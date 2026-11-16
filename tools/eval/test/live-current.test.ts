// Subject `current` with a scripted model: her real brain (agent, gate, Arbiter, mind, ...) and
// her real profile, on real timers. Only the provider is scripted, so nothing here reaches a
// network. These tests take a few seconds each: the brain debounces and settles in real time.

import { fileURLToPath } from "node:url";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { Profile } from "@miyoria/runtime/profile";
import { describe, expect, it } from "vitest";
import { CurrentSubject } from "../src/live/current.js";
import { routerJudge } from "../src/live/judge.js";
import { Meter } from "../src/live/meter.js";
import { PERSONA_SCENES } from "../src/live/scenes.js";
import type { Scene } from "../src/live/subject.js";
import type { SuiteContext } from "../src/live/suite.js";
import { runPersona } from "../src/live/suites/persona.js";
import { runTools, type ToolItem } from "../src/live/suites/tools.js";
import { TOOL_TASKS } from "../src/tasks/set.js";

const PROFILE_DIR = fileURLToPath(new URL("../../../profiles/deepseek-chan", import.meta.url));
const usage = { prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: 40 };
const done: StreamEvent = { type: "done", finish_reason: "stop", usage };

const say = (text: string): StreamEvent[] => [{ type: "text_delta", text }, done];
const call = (name: string, args: unknown): StreamEvent[] => [
  { type: "tool_call_delta", index: 0, id: `call-${name}`, name, arguments: JSON.stringify(args) },
  { type: "done", finish_reason: "tool_calls", usage },
];

/** Her replies (`chat_*` calls) come from `script`, in order; the judge's from `judge`. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly chat: ChatRequest[] = [];
  readonly judged: ChatRequest[] = [];
  readonly other: ChatRequest[] = [];
  constructor(
    readonly script: StreamEvent[][],
    readonly judge: string = "{}",
  ) {}
  async stream(request: ChatRequest): Promise<ChatStream> {
    const purpose = request.reasoning_purpose ?? "";
    let events = say("{}");
    if (purpose.startsWith("chat_")) {
      events = this.script[Math.min(this.chat.length, this.script.length - 1)] ?? say("嗯。");
      this.chat.push(structuredClone(request));
    } else if (request.json_mode && request.reasoning === "high") {
      events = say(this.judge);
      this.judged.push(structuredClone(request));
    } else this.other.push(structuredClone(request));
    return (async function* (): ChatStream {
      for (const ev of events) yield ev;
    })();
  }
}

async function build(
  script: StreamEvent[][],
  options: { judge?: string; maxUsd?: number } = {},
): Promise<{ provider: Scripted; meter: Meter; router: LlmRouter; subject: CurrentSubject }> {
  const provider = new Scripted(script, options.judge);
  const meter = new Meter(
    options.maxUsd === undefined
      ? {}
      : {
          maxUsd: options.maxUsd,
          pricing: new Map([
            [
              "scripted:m",
              { input_per_mtok: 10_000, cached_input_per_mtok: 10_000, output_per_mtok: 0 },
            ],
          ]),
        },
  );
  const chain = [parseModelRef("scripted:m")];
  const router = new LlmRouter(
    new Map([["scripted", meter.wrap(provider)]]),
    new Map(["chat", "fast", "mind", "summarizer"].map((p) => [p, chain])),
  );
  const profile = await Profile.loadDir(PROFILE_DIR);
  // Shorter waits than a live run: the scripted model answers at once.
  const subject = new CurrentSubject({ router, meter, profile, quietMs: 500, settleMs: 5000 });
  return { provider, meter, router, subject };
}

const context = (
  subject: SuiteContext["subject"],
  router: LlmRouter,
  meter: Meter,
): SuiteContext => ({
  subject,
  judge: routerJudge(router),
  meter,
  persona: "p",
  repeat: 1,
  seed: "s",
  log: () => {},
});

const prompt = (request: ChatRequest | undefined): string =>
  (request?.messages ?? []).map((m) => contentText(m.content)).join("\n");

const TIMEOUT = 60_000;

describe("subject current", () => {
  it(
    "answers a mention with her real prompt: persona, the scene's closeness and state",
    async () => {
      const { provider, subject } = await build([say("<emo:happy>哼哼,知道就好。")]);
      const scene: Scene = {
        id: "t",
        place: "text",
        people: [{ name: "阿哲", closeness: { bond: 300, familiarity: 100, trust: 90 } }],
        lines: [{ who: "阿哲", text: "DS醬你剛剛幫我改的那段寫得超乾淨" }],
        address: "mention",
        state: "下午練了一首新歌,還沒練完",
      };
      const reply = await subject.respond(scene);
      expect(reply.lines).toEqual(["哼哼,知道就好。"]);
      expect(reply).toMatchObject({ silent: false, calls: [] });
      expect(reply.usage).toEqual({
        calls: 1,
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_prompt_tokens: 40,
        reasoning_tokens: 0,
      });
      expect(reply.ms).toBeGreaterThan(0);
      const sent = prompt(provider.chat[0]);
      expect(sent).toContain("# 你是 DeepSeek-chan");
      expect(sent).toContain('<person name="阿哲" relation="心有靈犀" level="300/1000"');
      expect(sent).toContain("下午練了一首新歌,還沒練完");
      expect(sent).toContain("阿哲: DS醬你剛剛幫我改的那段寫得超乾淨");
      // No Plan of the mind in a scene.
      expect(provider.other).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "answers in a DM, and reads the scene's clock when it sets one",
    async () => {
      const { provider, subject } = await build([say("在啦。")]);
      const reply = await subject.respond({
        id: "d",
        place: "dm",
        people: [{ name: "小安", closeness: { bond: 0 } }],
        lines: [{ who: "小安", text: "在嗎" }],
        address: "dm",
        now: "2026-11-10 18:00",
      });
      expect(reply.lines).toEqual(["在啦。"]);
      const sent = prompt(provider.chat[0]);
      expect(sent).toContain("時間:2026-11-10 18:0");
      expect(sent).toContain("的私訊");
    },
    TIMEOUT,
  );

  it(
    "leaves it to her attention when nobody calls her: silence, and no model call",
    async () => {
      const { provider, subject } = await build([say("我也要!")]);
      const scene = PERSONA_SCENES.find((s) => s.situation.id === 12)?.scene;
      expect(scene?.address).toBe("none");
      const reply = await subject.respond(scene as Scene);
      expect(reply).toMatchObject({ lines: [], silent: true });
      expect(reply.usage.calls).toBe(0);
      expect(provider.chat).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "takes a persona scene through the suite: her reply, then the judge on the same router",
    async () => {
      const five = { score: 5, reason: "像她" };
      const judge = JSON.stringify({
        in_character: five,
        fits: five,
        brevity: five,
        clean: five,
        grounded: five,
      });
      const { provider, meter, router, subject } = await build([say("嘿嘿,再誇兩句也可以喔。")], {
        judge,
      });
      // The suite takes all twenty situations: let only the first through.
      let shown = 0;
      const first = {
        name: subject.name,
        unsupported: (scene: Scene) =>
          shown++ === 0 ? subject.unsupported(scene) : "left out of this test",
        respond: (scene: Scene) => subject.respond(scene),
      };
      const result = await runPersona(context(first, router, meter));
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: 1, lines: ["嘿嘿,再誇兩句也可以喔。"] });
      expect(result.headline).toEqual({ score: 1, low_share: 0 });
      expect(result.unsupported).toHaveLength(19);
      expect(prompt(provider.judged[0])).toContain("嘿嘿,再誇兩句也可以喔。");
    },
    TIMEOUT,
  );

  it(
    "drives the fake world's tools from her own loop and passes a task by its criteria",
    async () => {
      const task = TOOL_TASKS.filter((t) => t.id === "verify-a-date");
      const { provider, meter, router, subject } = await build([
        call("web_search", { query: "Zephyr 3.0 發布" }),
        call("web_read", { url: "https://zephyr.example/blog/3-0" }),
        say("查了官方公告,是 10 月 28 日才對,那個說法不準啦。"),
      ]);
      const result = await runTools(context(subject, router, meter), task);
      const item = (result.items as ToolItem[])[0];
      expect(item?.criteria.filter((c) => !c.ok)).toEqual([]);
      expect(result.headline.success).toBe(1);
      expect(item?.calls).toBe(2);
      expect(item?.usage.calls).toBe(3);
      // Her loop offered the fake tools beside her own, and fed the result back in the same turn.
      const offered = provider.chat[0]?.tools?.map((t) => t.name) ?? [];
      expect(offered).toEqual(expect.arrayContaining(["web_search", "web_read", "keep_note"]));
      expect(prompt(provider.chat[1])).toContain("Zephyr 3.0 正式發布");
    },
    TIMEOUT,
  );

  it(
    "waits for her hands: a tool outside the loop comes back in a later turn",
    async () => {
      const task = TOOL_TASKS.filter((t) => t.id === "update-a-notebook-page");
      const { meter, router, subject } = await build([
        call("notebook_read", { key: "小雨" }),
        call("notebook_write", { key: "小雨", text: "小雨:改喝茶了。" }),
        say("改好了,小雨那頁現在寫喝茶。"),
      ]);
      const result = await runTools(context(subject, router, meter), task);
      const item = (result.items as ToolItem[])[0];
      // Three turns: each hands tool ends its turn, and its result opens the next one.
      expect(item?.calls).toBe(2);
      expect(item?.usage.calls).toBe(3);
      expect(item?.lines.at(-1)).toBe("改好了,小雨那頁現在寫喝茶。");
      expect(item?.timed_out).toBeUndefined();
    },
    TIMEOUT,
  );

  it("says which scenes it cannot take", async () => {
    const { subject } = await build([say("嗯。")]);
    const base: Scene = {
      id: "x",
      place: "text",
      people: [{ name: "阿哲" }],
      lines: [{ who: "阿哲", text: "嗨" }],
      address: "mention",
    };
    expect(subject.unsupported(base)).toBeNull();
    const env = (tools: readonly string[]) => ({
      prompt: "",
      tools,
      call: () => ({ ok: true, text: "" }),
    });
    expect(subject.unsupported({ ...base, tools: env(["web_search", "voice_join"]) })).toBe(
      "no fake tool definition for voice_join",
    );
    expect(subject.unsupported({ ...base, address: "dm" })).not.toBeNull();
    // Every tool of the ten tasks has a definition: none of them is unsupported.
    for (const task of TOOL_TASKS) {
      expect(subject.unsupported({ ...base, tools: env(task.tools) })).toBeNull();
    }
  });

  it(
    "sends nothing once the budget is spent, and counts the refusal",
    async () => {
      const { provider, meter, subject } = await build([say("嗯。")], { maxUsd: 0.5 });
      // One call's worth is already spent.
      meter.record("scripted:m", usage);
      expect(meter.spent()).toBe(true);
      await subject.respond({
        id: "b",
        place: "text",
        people: [{ name: "阿哲" }],
        lines: [{ who: "阿哲", text: "嗨" }],
        address: "mention",
      });
      expect(provider.chat).toEqual([]);
      expect(meter.refusals()).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
