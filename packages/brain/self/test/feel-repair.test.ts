// The repair of a reply that went out without its `<feel>` block: what a run keeps for it, the one
// call (the run's request with her reply and the note, small, no reasoning, labelled `feel`), what
// it brings back, what it is charged, and when it is skipped or gives up. Scripted model.

import { type ChatRequest, currentLlmTag, type StreamEvent } from "@miyoria/llm/llm";
import { describe, expect, it } from "vitest";
import { parseFeel } from "../src/feel.js";
import { FEEL_REPAIR_LABEL, FEEL_REPAIR_MAX_TOKENS, feelOfRepair } from "../src/feel-repair.js";
import { PROFILES } from "../src/profiles.js";
import { type Payer, PersonQuota, type QuotaRules } from "../src/quota.js";
import { FEEL_REPAIR_NOTE } from "../src/rules.js";
import type { ModelStream, RunModel } from "../src/types.js";
import { calls, done, fakeTool, MODEL, rig, say, T0 } from "./harness.js";

const BLOCK = "<feel>\n我: 生氣 中\nOwen: 羈絆 -10「說了兩次不要還一直洗版」\n</feel>";
const RULES: QuotaRules = { usdPerHour: 1, usdPerDay: 3, unpricedUsdPerMtok: 1 };
const OWEN: Payer = { person: "p-owen" };

describe("what a run keeps for a repair", () => {
  it("a reply without a block, when asked: once, with the request its next step would send", async () => {
    const r = await rig([say("不要就是不要"), say(BLOCK)]);
    const result = await r.run(undefined, { feelRepair: true });
    expect(result).toMatchObject({ outcome: "said", feel: [] });
    const repair = r.runner.takeFeelRepair(result.turn);
    expect(repair).not.toBeNull();
    expect(r.runner.takeFeelRepair(result.turn)).toBeNull();
    if (repair === null) return;

    const last = r.model.requests[0] as ChatRequest;
    const sent = repair.request();
    // The run's prompt as it was sent, so the provider's cache serves it; then her reply, the note.
    expect(sent.messages.slice(0, last.messages.length)).toEqual(last.messages);
    expect(sent.messages.slice(last.messages.length)).toEqual([
      expect.objectContaining({ role: "assistant", content: "不要就是不要" }),
      expect.objectContaining({ role: "system", content: FEEL_REPAIR_NOTE }),
    ]);
    expect(sent.tools).toEqual(last.tools);
    expect(sent).toMatchObject({ max_tokens: FEEL_REPAIR_MAX_TOKENS, reasoning: "off" });
  });

  it("after the steps of a run with tools: its calls and her last words are in it", async () => {
    const r = await rig([calls([{ name: "look" }]), say("查好了"), say(BLOCK)]);
    r.tools.register(fakeTool("look", "貓"));
    const result = await r.run(undefined, { feelRepair: true });
    const repair = r.runner.takeFeelRepair(result.turn);
    const last = r.model.requests[1] as ChatRequest;
    const sent = repair?.request().messages ?? [];
    expect(sent.slice(0, last.messages.length)).toEqual(last.messages);
    expect(sent.at(-2)).toMatchObject({ role: "assistant", content: "查好了" });
  });

  it("nothing when not asked, when she wrote a block, when silent, or for a quiet profile", async () => {
    const plain = await rig([say("好")]);
    const notAsked = await plain.run();
    expect(plain.runner.takeFeelRepair(notAsked.turn)).toBeNull();

    const wrote = await rig([say(`好\n${BLOCK}`)]);
    const withBlock = await wrote.run(undefined, { feelRepair: true });
    expect(withBlock.feel).toHaveLength(1);
    expect(wrote.runner.takeFeelRepair(withBlock.turn)).toBeNull();

    const quiet = await rig([say("<silence/>")]);
    const silent = await quiet.run(undefined, { feelRepair: true });
    expect(silent.outcome).toBe("silent");
    expect(quiet.runner.takeFeelRepair(silent.turn)).toBeNull();

    for (const profile of [PROFILES.subagent, PROFILES.reflect]) {
      const helper = await rig([say("做好了")]);
      const done_ = await helper.run(undefined, { profile, feelRepair: true });
      expect(helper.runner.takeFeelRepair(done_.turn), profile.name).toBeNull();
    }
  });

  it("a voice reply is repaired too", async () => {
    const r = await rig([say("不要。")]);
    const result = await r.run(undefined, { profile: PROFILES.voice, feelRepair: true });
    expect(result.outcome).toBe("said");
    expect(r.runner.takeFeelRepair(result.turn)).not.toBeNull();
  });
});

describe("the repair call", () => {
  it("brings back her block, under the run's turn and the label `feel`, and says nothing", async () => {
    const r = await rig([say("不要就是不要"), say(`好啦\n${BLOCK}`)]);
    const tags: unknown[] = [];
    const stream = r.model.stream.bind(r.model);
    r.model.stream = (purpose, request, signal) => {
      tags.push(currentLlmTag());
      return stream(purpose, request, signal);
    };
    const result = await r.run(undefined, { feelRepair: true });
    const out = await r.runner.takeFeelRepair(result.turn)?.run();
    expect(out?.status).toBe("repaired");
    if (out?.status !== "repaired") return;
    expect(parseFeel(out.feel[0] ?? "").lines).toEqual([
      expect.objectContaining({ name: "Owen", field: "bond", direction: "down", amount: 10 }),
    ]);
    expect(tags.at(-1)).toMatchObject({
      module: "agent",
      turn: result.turn,
      label: FEEL_REPAIR_LABEL,
    });
    expect(r.model.purposes.at(-1)).toBe("chat");
    // What she wrote around the block went nowhere, and nothing went into the transcript.
    expect(r.outlet.texts()).toEqual(["不要就是不要"]);
    expect(JSON.stringify(r.transcript.tail("s1").entries)).not.toMatch(/好啦|羈絆/);
    // Once.
    expect(await r.runner.takeFeelRepair(result.turn)?.run()).toBeUndefined();
  });

  it("an answer without a block is `empty`; a model of the host's own may be given", async () => {
    const r = await rig([say("好")]);
    const result = await r.run(undefined, { feelRepair: true });
    const asked: ChatRequest[] = [];
    const own: Pick<RunModel, "stream" | "prices"> = {
      async stream(_purpose, request): Promise<ModelStream> {
        asked.push(request);
        async function* events(): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", text: "好喔,我知道了" };
          yield done();
        }
        return Object.assign(events(), { model: MODEL });
      },
      prices: () => r.model.prices(),
    };
    const out = await r.runner.takeFeelRepair(result.turn)?.run({ model: own });
    expect(out?.status).toBe("empty");
    expect(asked).toHaveLength(1);
    expect(r.model.requests).toHaveLength(1);
  });

  it("is charged to the run's people, an even share each", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    const r = await rig([say("好"), say(BLOCK)], { runner: { compaction: null, quota } });
    const result = await r.run(undefined, { feelRepair: true, payer: OWEN });
    const before = quota.used("p-owen", r.clock.now()).hour;
    expect(before).toBeCloseTo(result.cost_usd, 9);
    const out = await r.runner.takeFeelRepair(result.turn)?.run();
    expect(out?.status).toBe("repaired");
    if (out?.status !== "repaired") return;
    expect(out.cost_usd).toBeGreaterThan(0);
    expect(quota.used("p-owen", r.clock.now()).hour).toBeCloseTo(before + (out.cost_usd ?? 0), 9);
  });

  it("is skipped, with no call, when someone the run worked for is at their quota", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    const r = await rig([say("好"), say(BLOCK)], { runner: { compaction: null, quota } });
    const result = await r.run(undefined, { feelRepair: true, payer: OWEN });
    quota.add("p-owen", T0, 1.5);
    const out = await r.runner.takeFeelRepair(result.turn)?.run();
    expect(out).toEqual({ status: "skipped", reason: "quota" });
    expect(r.model.requests).toHaveLength(1);
  });

  it("gives up after its timeout, and when the host stops", async () => {
    const hanging = (): Pick<RunModel, "stream" | "prices"> => ({
      stream: (_purpose, _request, signal) =>
        new Promise<ModelStream>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    const r = await rig([say("好")]);
    const first = await r.run(undefined, { feelRepair: true });
    const late = await r.runner
      .takeFeelRepair(first.turn)
      ?.run({ model: hanging(), timeoutMs: 20 });
    expect(late).toEqual({ status: "failed", error: "timed out" });

    const second = await r.run(undefined, { feelRepair: true });
    const stop = new AbortController();
    const stopped = r.runner
      .takeFeelRepair(second.turn)
      ?.run({ model: hanging(), signal: stop.signal });
    stop.abort();
    expect(await stopped).toMatchObject({ status: "failed" });
  });
});

describe("reading what the repair wrote", () => {
  it("takes the inside of the block, a block cut off, or lines written without tags", () => {
    expect(feelOfRepair(BLOCK)).toEqual([
      "我: 生氣 中\nOwen: 羈絆 -10「說了兩次不要還一直洗版」\n",
    ]);
    expect(feelOfRepair("好\n<feel>\n我: 平靜 弱\n")).toEqual(["我: 平靜 弱\n"]);
    expect(feelOfRepair("我: 開心 中\nOwen: 羈絆 + 「陪我」")).toEqual([
      "我: 開心 中\nOwen: 羈絆 + 「陪我」\n",
    ]);
    expect(feelOfRepair("好喔,我知道了")).toEqual([]);
    expect(feelOfRepair("<feel></feel>")).toEqual([]);
  });
});
