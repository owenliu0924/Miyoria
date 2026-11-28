// The worker helper, the per-kind limits from the config, the helpers' plan and her section of
// the jobs going on (docs/design/v6-agent.md 第一批).

import { contentText } from "@miyoria/llm/llm";
import type { Tool, ToolContext } from "@miyoria/llm/tools";
import { getLogger } from "@miyoria/runtime/kernel";
import { type ContextKey, type JsonValue, Principals } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { DelegateConfigSchema } from "../../agent/src/config.js";
import {
  type DelegateEvent,
  Delegator,
  type DelegatorPorts,
  type JobRow,
  MemoryJobStore,
} from "../src/delegate.js";
import { JOBS_TITLE, PLAN_TEXTS, WORKER_CODE, WORKER_NO_CODE } from "../src/delegate-texts.js";
import { DELEGATE, DELEGATE_LIST, DELEGATE_READ, delegateTools } from "../src/delegate-tools.js";
import { permissiveGuard } from "../src/guard.js";
import { JobsPrompt, jobsBody } from "../src/jobs-prompt.js";
import { MAX_PLAN_STEPS, parsePlan } from "../src/plan.js";
import { CALLS_PER_ROUND } from "../src/profiles.js";
import { wakeLine } from "../src/prompt.js";
import { REFUSALS } from "../src/rules.js";
import {
  defaultKindLimits,
  helperGuard,
  jobTools,
  KINDS,
  kindLimitsOf,
  setWorkerExtraTools,
  workerExtraTools,
} from "../src/subagents.js";
import { CTX, calls, fakeTool, OTHER, OWEN, promptText, rig, say } from "./harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctxOf(context: ContextKey = CTX): ToolContext {
  return {
    turn: "t1",
    context,
    account: OWEN.account,
    principal: Principals.user(OWEN.account, context),
    message: { context, id: "m1" },
    priority: "request",
    signal: new AbortController().signal,
  };
}

async function setup(
  script: Parameters<typeof rig>[0],
  tools: Tool[],
  ports: Partial<DelegatorPorts> = {},
) {
  const r = await rig(script);
  for (const t of tools) r.tools.register(t);
  const store = new MemoryJobStore();
  const woke: JobRow[] = [];
  const events: DelegateEvent[] = [];
  const delegator = new Delegator({
    transcript: r.transcript,
    tools: r.tools,
    model: r.model,
    guard: permissiveGuard,
    clock: r.clock,
    log: getLogger("brain.self.worker.test"),
    store,
    ended: (job) => woke.push(structuredClone(job)),
    onEvent: (e) => events.push(structuredClone(e)),
    ...ports,
  });
  const made = new Map(
    delegateTools({ delegator, nameOf: () => OWEN.name }).map((t) => [t.spec.name, t]),
  );
  const call = async (name: string, args: Record<string, JsonValue>, context = CTX) => {
    const tool = made.get(name) as Tool;
    return (tool.result as NonNullable<Tool["result"]>)(ctxOf(context), args);
  };
  return { r, store, woke, events, delegator, call };
}

/** Records a call that must not run. */
const marker = (into: string[], what: string) => () => {
  into.push(what);
  return "done";
};

const workspace = (wrote: string[] = []) => [
  fakeTool("workspace_list", "notes.md", { core: false, group: "workspace" }),
  fakeTool("workspace_read", "內容", { core: false, group: "workspace" }),
  fakeTool("workspace_write", "寫好了", {
    core: false,
    effect: "act",
    group: "workspace",
    call: marker(wrote, "write"),
  }),
  fakeTool("workspace_export", "產物 a1", { core: false, effect: "act", group: "files" }),
];

afterEach(() => setWorkerExtraTools([]));

describe("the worker", () => {
  it("is a kind she may start, with files, the web and the notebook, and says code cannot run", async () => {
    const wrote: string[] = [];
    const s = await setup(
      [
        calls([{ id: "w", name: "workspace_write", args: { q: "report.md" } }]),
        say("寫好了 report.md"),
      ],
      [fakeTool("web_search"), fakeTool("notebook_read"), ...workspace(wrote)],
    );
    const out = await s.call(DELEGATE, { kind: "worker", goal: "做一份報告存成 report.md" });
    expect(out.ok).toBe(true);
    await s.delegator.idle();
    const job = s.woke[0] as JobRow;
    expect(job).toMatchObject({ kind: "worker", state: "done", budget_usd: 1 });
    expect(wrote).toEqual(["write"]);
    const first = s.r.model.requests[0];
    expect(first?.tools?.map((t) => t.name)).toEqual([
      "plan",
      "find_tools",
      "web_search",
      "notebook_read",
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "workspace_export",
    ]);
    const system = contentText(first?.messages[0]?.content ?? "");
    expect(system).toContain(WORKER_NO_CODE);
    expect(system).not.toContain(WORKER_CODE);
    expect(system).toContain("先用 plan 寫下步驟");
  });

  it("runs code when the sandbox is there, and its instructions say so", async () => {
    const s = await setup(
      [calls([{ name: "code_run", args: { q: "print(1)" } }]), say("跑出 1")],
      [fakeTool("code_run", "1", { effect: "external", group: "code" }), ...workspace()],
    );
    await s.call(DELEGATE, { kind: "worker", goal: "算 1" });
    await s.delegator.idle();
    expect((s.woke[0] as JobRow).summary).toBe("跑出 1");
    const system = contentText(s.r.model.requests[0]?.messages[0]?.content ?? "");
    expect(system).toContain(WORKER_CODE);
    expect(system).not.toContain(WORKER_NO_CODE);
    expect(jobTools("worker", (n) => s.r.tools.entry(n))).toContain("code_run");
  });

  it("calls only the tools of its list by name, never by group or effect", async () => {
    const guard = helperGuard("worker", () => true);
    const ctx = { session: { id: "delegate:x", context: CTX } } as never;
    const check = async (name: string, effect: string, group: string) =>
      (
        await guard.checkCall(
          {
            call: { id: "c", name, arguments: "{}" },
            args: {},
            entry: { name, effect, group, tool: fakeTool(name) } as never,
          },
          ctx,
        )
      ).allow;
    for (const [name, effect, group] of [
      ["workspace_list", "read", "workspace"],
      ["workspace_read", "read", "workspace"],
      ["workspace_write", "act", "workspace"],
      ["workspace_delete", "act", "workspace"],
      ["workspace_export", "act", "files"],
      ["notebook_read", "read", "notebook"],
      ["recall", "read", "memory"],
      ["code_run", "external", "code"],
      ["code_session", "external", "code"],
      ["workspace_run", "external", "workspace"],
      ["web_search", "external", "web"],
      ["web_read", "read", "web"],
      ["web_image", "read", "web"],
      ["plan", "act", "work"],
      ["find_tools", "read", "core"],
    ] as const) {
      expect(await check(name, effect, group), name).toBe(true);
    }
    for (const [name, effect, group] of [
      // What a web page could make it do to her memory of people.
      ["notebook_write", "act", "notebook"],
      ["notebook_delete", "act", "notebook"],
      // Read tools of other groups: her jobs, her schedule, the stream, her skills.
      ["delegate_read", "read", "work"],
      ["delegate_list", "read", "work"],
      ["schedule_list", "read", "schedule"],
      ["watch_look", "read", "stream"],
      ["skill", "read", "skills"],
      // Plugin and MCP tools say nothing of what they do.
      ["ext_tool", "external", "extension"],
      ["mcp_tool", "external", "mcp"],
      ["workspace_save_script", "act", "workspace"],
      ["say", "say", "core"],
      ["message_dm", "say", "chat"],
      ["share", "say", "files"],
      ["buy_item", "spend", "economy"],
      ["voice_join", "act", "voice"],
      ["game_start", "act", "game"],
      ["stream_start", "act", "stream"],
      ["channel_activeness", "act", "chat"],
      ["remind_me", "act", "schedule"],
      ["unknown_thing", "external", "other"],
    ] as const) {
      expect(await check(name, effect, group), name).toBe(false);
    }
    // The research helper still only reads.
    const research = helperGuard("research", new Set(KINDS.research.tools));
    const r = await research.checkCall(
      {
        call: { id: "c", name: "workspace_write", arguments: "{}" },
        args: {},
        entry: { name: "workspace_write", effect: "act", group: "workspace" } as never,
      },
      ctx,
    );
    expect(r.allow).toBe(false);
  });

  it("calls an MCP or plugin tool only when the owner names it in extra_tools", async () => {
    const cfg = DelegateConfigSchema.parse({
      kinds: { worker: { extra_tools: ["ext_tool", "mcp_tool", "notebook_write"] } },
    });
    expect(cfg.kinds.worker.extra_tools).toEqual(["ext_tool", "mcp_tool", "notebook_write"]);
    expect(kindLimitsOf("worker", cfg.kinds.worker).extraTools).toEqual(
      cfg.kinds.worker.extra_tools,
    );
    expect(workerExtraTools()).toEqual(["ext_tool", "mcp_tool", "notebook_write"]);
    const guard = helperGuard("worker", () => true);
    const ctx = { session: { id: "delegate:x", context: CTX } } as never;
    const check = async (name: string, effect: string, group: string) =>
      (
        await guard.checkCall(
          {
            call: { id: "c", name, arguments: "{}" },
            args: {},
            entry: { name, effect, group, tool: fakeTool(name) } as never,
          },
          ctx,
        )
      ).allow;
    expect(await check("ext_tool", "external", "extension")).toBe(true);
    expect(await check("mcp_tool", "external", "mcp")).toBe(true);
    expect(await check("other_ext", "external", "extension")).toBe(false);
    // Only MCP and plugin tools: naming a core tool there does not open it.
    expect(await check("notebook_write", "act", "notebook")).toBe(false);
    // Nor one that speaks or spends.
    setWorkerExtraTools(["ext_say"]);
    expect(await check("ext_say", "say", "extension")).toBe(false);
    expect(DelegateConfigSchema.parse({}).kinds.worker.extra_tools).toEqual([]);
  });

  it("finds with its own find_tools only what its list and extra_tools hold, never into her list", async () => {
    const dms: string[] = [];
    setWorkerExtraTools(["ext_render"]);
    const s = await setup(
      [
        calls([{ name: "find_tools", args: { query: "腳本" } }]),
        calls([{ name: "ext_render", args: { q: "a.py" } }]),
        calls([{ name: "voice_join", args: {} }]),
        say("畫好了"),
      ],
      [
        ...workspace(),
        fakeTool("workspace_save_script", "存好了", {
          core: false,
          effect: "act",
          group: "workspace",
          description: "把腳本存進工作區。",
        }),
        fakeTool("ext_render", "畫好了", {
          core: false,
          effect: "external",
          group: "extension",
          description: "用插件把腳本畫成圖。",
        }),
        fakeTool("ext_other", "x", {
          core: false,
          effect: "external",
          group: "extension",
          description: "插件的另一個腳本工具。",
        }),
        fakeTool("skill", "x", {
          core: false,
          effect: "read",
          group: "skills",
          description: "載入一個技能和它的腳本。",
        }),
        fakeTool("voice_join", "x", {
          core: false,
          effect: "act",
          group: "voice",
          description: "進語音頻道,也可以念腳本。",
          call: marker(dms, "join"),
        }),
      ],
    );
    await s.call(DELEGATE, { kind: "worker", goal: "把腳本畫成圖" });
    await s.delegator.idle();
    const job = s.woke[0] as JobRow;
    expect(job.summary).toBe("畫好了");
    const results = s.r.transcript
      .tail(job.session)
      .entries.filter((e) => e.kind === "tool_result")
      .map((e) => e.content);
    for (const never of ["voice_join", "workspace_save_script", "ext_other", "skill"]) {
      expect(results[0]).not.toContain(never);
    }
    expect(results[1]).toBe("畫好了");
    expect(results[2]).toBe(REFUSALS.notOffered("voice_join"));
    expect(dms).toEqual([]);
    // The extra tool is in its list from the start; her own session loaded nothing.
    expect(s.r.model.requests[0]?.tools?.map((t) => t.name)).toContain("ext_render");
    expect(s.r.model.requests[0]?.tools?.map((t) => t.name)).not.toContain("ext_other");
    expect(s.r.tools.loaded.loaded("discord:g1:c1")).toEqual([]);
    expect(s.r.tools.loaded.toJSON()).toEqual({});
  });
});

describe("limits per kind", () => {
  it("come from the config, and its defaults are the kinds' own", () => {
    const cfg = DelegateConfigSchema.parse({});
    expect({
      research: kindLimitsOf("research", cfg.kinds.research),
      curator: kindLimitsOf("curator", cfg.kinds.curator),
      worker: kindLimitsOf("worker", cfg.kinds.worker),
    }).toEqual(defaultKindLimits());
    expect(KINDS.worker.limits).toMatchObject({
      rounds: 60,
      wallMs: 30 * 60_000,
      defaultUsd: 1,
      maxUsd: 3,
    });
    expect(cfg).toMatchObject({ max_running: 3, max_queued: 8 });
    // Calls per step and the token ceiling are fixed, not settings; nor is a day's cap of all jobs.
    expect(cfg).not.toHaveProperty("daily_usd");
    expect(cfg).not.toHaveProperty("daily_tokens");
    expect(cfg.kinds.worker).not.toHaveProperty("calls_per_round");
    expect(cfg.kinds.worker).not.toHaveProperty("tokens");
    const tokens = DelegateConfigSchema.parse({ kinds: { worker: { tokens: 5 } } });
    expect(kindLimitsOf("worker", tokens.kinds.worker).tokens).toBe(KINDS.worker.limits.tokens);
    const set = DelegateConfigSchema.parse({ kinds: { worker: { rounds: 5, usd_max: 2 } } });
    expect(set.kinds.worker).toMatchObject({ rounds: 5, usd_max: 2, minutes: 30 });
    expect(set.kinds.research.rounds).toBe(16);
  });

  it("hold a job to its kind's rounds and budget as configured, and 8 calls a step", async () => {
    const s = await setup(
      [
        (request) =>
          contentText(request.messages.at(-1)?.content ?? "").includes("不能再呼叫工具")
            ? say("做到這裡。")
            : calls([{ name: "web_search" }, { name: "web_search" }, { name: "web_search" }]),
      ],
      [fakeTool("web_search")],
      {
        limits: {
          maxRunning: 1,
          kinds: { research: { rounds: 2, defaultUsd: 0.5, maxUsd: 0.6 } },
        },
      },
    );
    await s.call(DELEGATE, { kind: "research", goal: "查" });
    await s.call(DELEGATE, { kind: "research", goal: "查很多", budget: 5 });
    await s.delegator.idle();
    const [a, b] = s.woke as [JobRow, JobRow];
    expect(a.budget_usd).toBe(0.5);
    expect(b.budget_usd).toBe(0.6);
    expect(a.rounds).toBe(3);
    expect(a.note).toContain("輪數上限");
    const results = s.r.transcript.tail(a.session).entries.filter((e) => e.kind === "tool_result");
    // All three calls ran each round: a step may make eight.
    expect(results.filter((e) => e.content === REFUSALS.tooMany(CALLS_PER_ROUND))).toHaveLength(0);
    expect(results).toHaveLength(6);
    // The opening entry says the job's own rounds.
    expect(s.r.transcript.tail(a.session).entries[0]?.content).toContain("最多 2 輪工具");
  });
});

describe("the plan", () => {
  it("is kept on the job, in its next step's <now>, in the lists and in a read", async () => {
    const steps = [
      { text: "查 A 的價格", state: "done" },
      { text: "查 B 的價格", state: "in_progress" },
      { text: "寫成表格", state: "pending" },
    ];
    const s = await setup(
      [calls([{ name: "plan", args: { steps } }]), say("A 便宜。")],
      [fakeTool("web_search")],
    );
    await s.call(DELEGATE, { kind: "research", goal: "比 A 和 B 的價格" });
    await s.delegator.idle();
    const job = s.woke[0] as JobRow;
    expect(job.plan).toEqual(steps);
    expect(s.store.jobs.get(job.id)?.plan).toEqual(steps);
    expect(promptText(s.r.model.requests[1])).toContain("2. [進行中] 查 B 的價格");
    const list = await s.call(DELEGATE_LIST, {});
    expect(list.text).toContain("計畫 1/3");
    const read = await s.call(DELEGATE_READ, { job: job.id });
    expect(read.text).toContain("計畫(完成 1/3)");
    expect(read.text).toContain("3. [待做] 寫成表格");
    // The panel's task feed hears of it as progress.
    const progress = s.events.filter((e) => e.type === "progress");
    expect(progress.map((e) => (e.type === "progress" ? e.detail : ""))).toContain(
      "計畫 1/3:查 B 的價格",
    );
  });

  it("a helper that stops with steps open gets one more step that lists them, once", async () => {
    const steps = [
      { text: "查 A 的價格", state: "done" },
      { text: "查 B 的價格", state: "in_progress" },
      { text: "寫成表格", state: "pending" },
    ];
    const s = await setup(
      [
        calls([{ name: "plan", args: { steps } }]),
        say("A 便宜。"),
        say("A 便宜;B 的價格查不到,網站關了,所以沒有表格。"),
        say("不該有這一步"),
      ],
      [fakeTool("web_search")],
    );
    await s.call(DELEGATE, { kind: "research", goal: "比 A 和 B 的價格" });
    await s.delegator.idle();
    const job = s.woke[0] as JobRow;
    expect(s.r.model.requests).toHaveLength(3);
    const note = s.r.model.requests[2]?.messages.at(-1);
    expect(note?.role).toBe("system");
    expect(note?.content).toBe(PLAN_TEXTS.open(["查 B 的價格", "寫成表格"]));
    expect(String(note?.content)).toContain("1. 查 B 的價格\n2. 寫成表格");
    expect(job.state).toBe("done");
    expect(job.summary).toContain("B 的價格查不到");
  });

  it("marking the steps done after the note, the result is written; an empty step keeps the one before", async () => {
    const open = [{ text: "寫成表格", state: "pending" }];
    const s = await setup(
      [
        calls([{ name: "plan", args: { steps: open } }]),
        say("表格在下面。"),
        calls([{ name: "plan", args: { steps: [{ text: "寫成表格", state: "done" }] } }]),
        say("| A | B |"),
      ],
      [fakeTool("web_search")],
    );
    await s.call(DELEGATE, { kind: "research", goal: "做表格" });
    await s.delegator.idle();
    const done = s.woke[0] as JobRow;
    expect(s.r.model.requests).toHaveLength(4);
    expect(done.plan).toEqual([{ text: "寫成表格", state: "done" }]);
    expect(done.summary).toContain("| A | B |");

    const quiet = await setup(
      [calls([{ name: "plan", args: { steps: open } }]), say("表格在下面。"), say("")],
      [fakeTool("web_search")],
    );
    await quiet.call(DELEGATE, { kind: "research", goal: "做表格" });
    await quiet.delegator.idle();
    const kept = quiet.woke[0] as JobRow;
    expect(quiet.r.model.requests).toHaveLength(3);
    expect(kept.state).toBe("done");
    expect(kept.summary).toContain("表格在下面。");
  });

  it("no note when the plan is done, nor when a limit ended the job", async () => {
    const s = await setup(
      [calls([{ name: "plan", args: { steps: [{ text: "查", state: "done" }] } }]), say("查好了")],
      [fakeTool("web_search")],
    );
    await s.call(DELEGATE, { kind: "research", goal: "查" });
    await s.delegator.idle();
    expect(s.r.model.requests).toHaveLength(2);

    const capped = await setup(
      [
        calls([{ name: "plan", args: { steps: [{ text: "查", state: "pending" }] } }]),
        say("只做到這裡"),
        say("不該有這一步"),
      ],
      [fakeTool("web_search")],
      { limits: { kinds: { research: { rounds: 2 } } } },
    );
    await capped.call(DELEGATE, { kind: "research", goal: "查" });
    await capped.delegator.idle();
    expect(capped.r.model.requests).toHaveLength(2);
    expect((capped.woke[0] as JobRow).summary).toContain("只做到這裡");
  });

  it("refuses a plan that is not one, and the job goes on", async () => {
    const many = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({
      text: `第 ${i} 步`,
      state: "pending",
    }));
    expect(parsePlan({ steps: many })).toMatchObject({ ok: false });
    expect(parsePlan({ steps: [] })).toMatchObject({ ok: false });
    expect(parsePlan({ steps: [{ text: "x", state: "maybe" }] })).toMatchObject({ ok: false });
    expect(parsePlan({ steps: [{ text: "字".repeat(81), state: "done" }] })).toMatchObject({
      ok: false,
    });
    const s = await setup(
      [calls([{ name: "plan", args: { steps: many } }]), say("沒有計畫也做完了")],
      [fakeTool("web_search")],
    );
    await s.call(DELEGATE, { kind: "research", goal: "查" });
    await s.delegator.idle();
    const job = s.woke[0] as JobRow;
    expect(job.plan).toEqual([]);
    expect(job.state).toBe("done");
    const result = s.r.transcript.tail(job.session).entries.find((e) => e.kind === "tool_result");
    expect(result?.content).toContain("最多 12 步");
  });
});

describe("the jobs going on, in her prompt", () => {
  it("shows each job of this place with who asked, the plan, the last step and the minutes", async () => {
    let release!: () => void;
    const held = new Promise<string>((resolve) => {
      release = () => resolve("結果");
    });
    const s = await setup(
      [
        calls([
          {
            name: "plan",
            args: {
              steps: [
                { text: "找資料", state: "in_progress" },
                { text: "寫報告", state: "pending" },
              ],
            },
          },
        ]),
        calls([{ name: "web_search" }]),
        calls([{ name: "web_read" }]),
        say("做完了"),
      ],
      [fakeTool("web_search", "r"), fakeTool("web_read", "r", { call: () => held })],
      { limits: { maxRunning: 1 } },
    );
    expect(jobsBody(s.delegator, CTX)).toBeNull();
    await s.call(DELEGATE, { kind: "worker", goal: "做一份報告" });
    await s.call(DELEGATE, { kind: "research", goal: "私訊裡要的東西" }, OTHER);
    await sleep(40);
    s.r.clock.tick(3 * 60_000);
    const body = jobsBody(s.delegator, CTX, [OWEN.account]) ?? "";
    expect(body).toContain("worker,進行中,跑了 3 分鐘;Owen 要的");
    expect(body).toContain("做一份報告");
    expect(body).toContain("1. [進行中] 找資料");
    expect(body).toContain("最新一步:第 2 輪:web_search");
    // The other place's job is only a count here.
    expect(body).not.toContain("私訊裡要的東西");
    expect(body).toContain("別的地方還有 1 件");
    // Someone else in the same place: Owen's job is only a count.
    const amy = jobsBody(s.delegator, CTX, [{ platform: "discord", id: "amy" }]) ?? "";
    expect(amy).not.toContain("做一份報告");
    expect(amy).not.toContain("找資料");
    expect(amy).toContain("這裡還有 1 件別人的工作在跑");
    // So is it for a run nobody asked for.
    expect(jobsBody(s.delegator, CTX) ?? "").not.toContain("做一份報告");
    const there = jobsBody(s.delegator, OTHER, [OWEN.account]) ?? "";
    expect(there).toContain("research,排隊中");
    expect(there).toContain("私訊裡要的東西");
    const sections = await new JobsPrompt(s.delegator).contribute({ context: CTX } as never);
    expect(sections.map((x) => x.title)).toEqual([JOBS_TITLE]);
    release();
    await s.delegator.idle();
    expect(jobsBody(s.delegator, CTX)).toBeNull();
  });
});

describe("a finished job", () => {
  it("says who waits for it, and her wake says it must be passed on to them", async () => {
    const s = await setup([say("結果在 report.md")], [fakeTool("web_search")]);
    await s.call(DELEGATE, { kind: "research", goal: "查" });
    await s.delegator.idle();
    const job = s.woke[0] as JobRow;
    expect(s.delegator.resultFor(job)).toContain("誰要的:Owen 要的");
    expect(s.delegator.resultFor({ ...job, from: null })).toContain("沒有人在等");
    const line = wakeLine({
      kind: "result",
      tool: "delegate",
      job: job.id,
      ok: true,
      text: "",
      from: OWEN,
    });
    expect(line).toContain("一定要跟那個人交代");
    expect(line).not.toContain("想講就講,沒什麼好說就什麼都不寫");
  });
});
