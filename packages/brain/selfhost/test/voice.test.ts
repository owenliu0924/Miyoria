// Voice on the new runner: utterances in, `speak` actions out through the mouth, her sentences in
// the transcript once they play. The playback events the voice module would publish are
// simulated here; the model is scripted. Real time, with the waits of the voice config made short.

import { defineTool } from "@miyoria/llm/tools";
import { sleep } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  type DecisionTrace,
  Events,
  type JsonValue,
  MouthKey,
  type PlaybackState,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PROFILES, serialiseMessages, serialiseTools } from "../../self/src/index.js";
import { silentWaits } from "../src/index.js";
import { notInVoice } from "../src/voice-texts.js";
import {
  account,
  calls,
  done,
  mention,
  Rig,
  type RigOptions,
  says,
  stopRigs,
  textOf,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const VC: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };
/** The voice channel's text chat: the same channel, kind `channel`. */
const VC_CHAT: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "channel" };

function member(id: string, self = false): VoiceParticipant {
  return { account: account(id), display_name: id, is_self: self, muted: false, deafened: false };
}

/** Short waits; no early start unless a test asks for one. */
const VOICE = {
  default_mode: "normal",
  debounce_ms: 150,
  direct_debounce_ms: 80,
  turn_debounce_ms: 20,
  max_debounce_ms: 1_500,
  speculate: false,
  live_context_ms: 50,
};

async function voiceRig(voice: Record<string, JsonValue> = {}, o: RigOptions = {}): Promise<Rig> {
  const rig = await Rig.create({ ...o, config: { ...o.config, voice: { ...VOICE, ...voice } } });
  rig.sup.bus.publish("voice.test", Events.VoiceJoined, {
    context: VC,
    participants: [member("owen"), member("amy"), member("her", true)],
  });
  await sleep(20);
  return rig;
}

let nextUtterance = 0;

function hear(rig: Rig, who: string, text: string, complete = false): void {
  const now = Date.now();
  rig.sup.bus.publish("voice.test", Events.VoiceUtteranceEvent, {
    id: `u${nextUtterance++}`,
    context: VC,
    speaker: { account: account(who), display_name: who, is_bot: false },
    text,
    language: "zh",
    emotion: null,
    audio_events: [],
    started_at: toTimestamp(now - 800),
    ended_at: toTimestamp(now),
    asr_ms: 200,
    ...(complete ? { turn: { ended_by: "turn", probability: 0.9 } } : {}),
  });
}

function speaking(rig: Rig, who: string, on: boolean): void {
  rig.sup.bus.publish("voice.test", Events.VoiceSpeaking, {
    context: VC,
    account: account(who),
    speaking: on,
  });
}

function play(
  rig: Rig,
  turn: string,
  state: PlaybackState,
  text: string,
  extra: Record<string, JsonValue> = {},
): void {
  rig.sup.bus.publish("voice.test", Events.VoicePlaybackEvent, {
    context: VC,
    turn,
    state,
    text,
    ...extra,
  });
}

/** `[text, emotion, turn]` of every `speak` action. */
function speeches(rig: Rig): [string, string | null, string | null][] {
  return rig.sink.actions.flatMap((a) =>
    a.payload.type === "speak" ? [[a.payload.text, a.payload.emotion, a.turn]] : [],
  ) as [string, string | null, string | null][];
}

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
const own = (rig: Rig) =>
  rig.entries(VC).filter((e) => e.kind === "self" || e.kind === "tool_calls");

/** A tool for voice runs that takes `ms` (cut by the run's signal). */
function slowTool(name: string, ms: number, answer = "查到了") {
  let ran = 0;
  const tool = defineTool({
    name,
    description: `測試用的 ${name}。`,
    parameters: z.object({ q: z.string().optional() }),
    effect: "read",
    speed: "instant",
    risk: "low",
    group: "test",
    core: true,
    next: true,
    readOnly: true,
    async call(ctx) {
      ran += 1;
      await sleep(ms, ctx.signal);
      return answer;
    },
  });
  return { tool, ran: () => ran };
}

describe("called by name in voice", () => {
  it("answers aloud sentence by sentence; her line enters the transcript when it starts playing", async () => {
    const rig = await voiceRig();
    rig.model.push(says("<emo:happy>在喔!今天想聊什麼?"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => speeches(rig).length === 2, 3_000, "her sentences");
    const said = speeches(rig);
    expect(said.map(([t, e]) => [t, e])).toEqual([
      ["在喔!", "happy"],
      ["今天想聊什麼?", "happy"],
    ]);
    const turn = said[0]?.[2] as string;
    // Every line is the main line's, on the voice lane, and nothing went to a text channel.
    expect(rig.sup.services.get(MouthKey)?.owns(turn)).toBe(true);
    expect(
      rig.sink.actions
        .filter((a) => a.payload.type === "speak")
        .every((a) => a.lane === "voice:test:guild"),
    ).toBe(true);
    expect(rig.sink.texts()).toEqual([]);
    // The request: voice reasoning, the voice note at the end, the room in <now>.
    const request = rig.model.requests[0];
    expect(request).toMatchObject({
      reasoning: "off",
      reasoning_purpose: "chat_voice",
      max_tokens: 600,
    });
    const last = String(request?.messages.at(-1)?.content ?? "");
    expect(last).toContain("## 語音");
    expect(last).toContain("語音頻道裡現在有:owen、amy");
    expect(last).toContain("owen 在語音裡跟你說話");
    expect(textOf(request)).toContain("owen(語音): 小鯨魚你在嗎");
    // Nothing of hers is in the transcript before it plays.
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(own(rig)).toEqual([]);
    play(rig, turn, "started", "在喔!");
    await until(() => own(rig).length === 1, 3_000, "her first sentence");
    play(rig, turn, "finished", "在喔!");
    play(rig, turn, "started", "今天想聊什麼?");
    await until(() => own(rig).length === 2, 3_000, "her second sentence");
    expect(own(rig).map((e) => [e.content, e.spoken, e.turn])).toEqual([
      ["在喔!", true, turn],
      ["今天想聊什麼?", true, turn],
    ]);
    const [outcome] = outcomes(rig);
    expect(outcome?.outcome).toEqual({ type: "sent", parts: 2 });
    expect(outcome?.reason).toBe("addressed");
    expect(outcome?.voice_stages).toMatchObject({ speculative: false });
    expect(outcome?.voice_stages?.first_sentence_ms).not.toBeNull();
    const decision = rig.of<DecisionTrace>(Events.AgentDecision.type).at(-1);
    expect(decision?.reasons).toEqual(["runner self", "voice", "addressed: name"]);
  });

  it("an interrupted sentence keeps only the part heard; what was not said never enters", async () => {
    const rig = await voiceRig();
    rig.model.push(says("我跟你說一個很長的故事。後面還有很多。"));
    hear(rig, "owen", "小鯨魚講故事");
    await until(() => speeches(rig).length === 2, 3_000, "her sentences");
    const turn = speeches(rig)[0]?.[2] as string;
    play(rig, turn, "started", "我跟你說一個很長的故事。");
    play(rig, turn, "interrupted", "我跟你說一個很長的故事。", { heard_ms: 500, total_ms: 1000 });
    await until(() => own(rig)[0]?.interrupted === true, 3_000, "the cut");
    const [entry] = own(rig);
    expect(own(rig)).toHaveLength(1);
    expect(entry?.content).toBe("我跟你說一個很長的故事。");
    expect(entry?.heard).toBe("我跟你說一個");
    // The rest of her speech is dropped from the scheduler.
    expect(rig.sink.cancelled).toContain(turn);
    // The next request shows what was heard, marked.
    rig.model.push(says("好啦。"));
    hear(rig, "owen", "小鯨魚停一下");
    await until(() => rig.model.requests.length === 2, 3_000, "the next run");
    expect(textOf(rig.model.requests[1])).toContain("我跟你說一個(被打斷)");
    expect(textOf(rig.model.requests[1])).not.toContain("後面還有很多");
  });

  it("a barge-in during her run stops it: the outcome says who cut in", async () => {
    const search = slowTool("web_search", 800);
    const rig = await voiceRig({}, { provide: (_sup, tools) => tools.register(search.tool) });
    rig.model.push(
      {
        events: [
          { type: "text_delta", text: "我查一下喔。" },
          ...calls("web_search", { q: "鯨魚" }),
        ],
      },
      says("找到了。"),
    );
    hear(rig, "owen", "小鯨魚幫我查鯨魚");
    await until(() => speeches(rig).length === 1, 3_000, "her first sentence");
    const turn = speeches(rig)[0]?.[2] as string;
    play(rig, turn, "started", "我查一下喔。");
    play(rig, turn, "interrupted", "我查一下喔。", { heard_ms: 200, total_ms: 1000 });
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]?.outcome).toMatchObject({ type: "cancelled", cause: "barge_in" });
    expect(speeches(rig).map(([t]) => t)).toEqual(["我查一下喔。"]);
  });
});

describe("the waits", () => {
  it("are pushed out while someone is speaking, and the run starts once they stop", async () => {
    const rig = await voiceRig();
    rig.model.push(says("嗯嗯。"));
    speaking(rig, "owen", true);
    hear(rig, "owen", "小鯨魚我跟你說");
    await sleep(400);
    expect(rig.model.requests).toHaveLength(0);
    speaking(rig, "owen", false);
    await until(() => rig.model.requests.length === 1, 3_000, "the run");
  });

  it("a speaker the turn model judged done is answered after the short wait", async () => {
    const rig = await voiceRig({ direct_debounce_ms: 600 });
    rig.model.push(says("好。"));
    hear(rig, "owen", "小鯨魚你覺得呢", true);
    await sleep(250);
    expect(rig.model.requests).toHaveLength(1);
  });

  it("an early start runs the model at once and says nothing until the wait is over", async () => {
    const rig = await voiceRig({ speculate: true, direct_debounce_ms: 500 });
    rig.model.push(says("在這。"));
    hear(rig, "owen", "小鯨魚");
    await until(() => rig.model.requests.length === 1, 300, "the early model call");
    expect(speeches(rig)).toEqual([]);
    await until(() => speeches(rig).length === 1, 3_000, "her line after the wait");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]?.voice_stages?.speculative).toBe(true);
    const latency = rig.of<{ stage: string; result?: string }>(Events.VoiceLatency.type);
    expect(latency.find((l) => l.stage === "speculation")?.result).toBe("confirmed");
  });

  it("an early start is dropped without a trace when they go on; the merged run answers both", async () => {
    const rig = await voiceRig({ speculate: true, direct_debounce_ms: 500 });
    rig.model.push(says("第一次的回答。"), says("合起來的回答。"));
    hear(rig, "owen", "小鯨魚");
    await until(() => rig.model.requests.length === 1, 300, "the early model call");
    hear(rig, "owen", "今天晚餐吃什麼好");
    await until(() => speeches(rig).length === 1, 3_000, "the merged answer");
    expect(speeches(rig).map(([t]) => t)).toEqual(["合起來的回答。"]);
    expect(textOf(rig.model.requests[1])).toContain("今天晚餐吃什麼好");
    const latency = rig.of<{ stage: string; result?: string }>(Events.VoiceLatency.type);
    expect(latency.find((l) => l.stage === "speculation")?.result).toBe("dropped");
    await until(() => outcomes(rig).length === 1, 3_000, "the merged run's outcome");
    await sleep(50);
    // One outcome (the merged run's); the dropped run left nothing in the transcript.
    expect(outcomes(rig)).toHaveLength(1);
    expect(own(rig)).toEqual([]);
    expect(rig.entries(VC).filter((e) => e.kind === "note" || e.kind === "tool_result")).toEqual(
      [],
    );
  });
});

describe("what is typed in the voice channel's chat", () => {
  it("belongs to the voice conversation and is answered aloud", async () => {
    const rig = await voiceRig();
    rig.model.push(says("看到了!"));
    rig.say(mention(VC_CHAT, "amy", "@她 打字給你"));
    await until(() => speeches(rig).length === 1, 3_000, "her spoken answer");
    expect(rig.sink.texts()).toEqual([]);
    const typed = rig.entries(VC).find((e) => e.content === "@她 打字給你");
    expect(typed?.spoken).toBe(false);
    expect(rig.entries(VC_CHAT)).toEqual([]);
  });
});

describe("the kept screens, per sentence", () => {
  it("leaves out a sentence that is her reasoning and says the rest", async () => {
    const rig = await voiceRig();
    rig.model.push(says("好啊。回覆要簡短。我們明天見!"));
    hear(rig, "owen", "小鯨魚明天見");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(speeches(rig).map(([t]) => t)).toEqual(["好啊。", "我們明天見!"]);
    expect(outcomes(rig)[0]?.corrections).toEqual({ leak_dropped: 1 });
  });
});

describe("tools in voice", () => {
  it("refuses a tool that is not on the voice list, telling her why", async () => {
    const coins = slowTool("give_coins", 0, "給了");
    const rig = await voiceRig({}, { provide: (_sup, tools) => tools.register(coins.tool) });
    rig.model.push(calls("give_coins", { q: "owen" }), says("在語音裡不行耶。"));
    hear(rig, "owen", "小鯨魚給我金幣");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(coins.ran()).toBe(0);
    // The tool is offered (the prefix is text's), the call refused at call time.
    expect(rig.model.requests[0]?.tools?.map((t) => t.name)).toContain("give_coins");
    const result = rig.entries(VC).find((e) => e.kind === "tool_result");
    expect(result?.content).toBe(notInVoice("give_coins"));
  });

  it("a slow tool gets no wait line: silence, counted", async () => {
    const search = slowTool("web_search", 1_100);
    const rig = await voiceRig({}, { provide: (_sup, tools) => tools.register(search.tool) });
    rig.model.push(calls("web_search", { q: "天氣" }), says("明天會下雨。"));
    const before = silentWaits.get();
    hear(rig, "owen", "小鯨魚明天天氣");
    await until(() => outcomes(rig).length === 1, 5_000, "the outcome");
    expect(speeches(rig).map(([t]) => t)).toEqual(["明天會下雨。"]);
    expect(silentWaits.get() - before).toBe(1);
  });
});

describe("the prefix", () => {
  it("a voice request starts like a text-profile request of the same session", async () => {
    const rig = await voiceRig();
    rig.model.push(says("嗨。"));
    hear(rig, "owen", "小鯨魚嗨");
    await until(() => outcomes(rig).length === 1, 3_000, "the voice run");
    const host = rig.host;
    if (host === null) throw new Error("no host");
    // A text-profile run of the same session, then a voice run: the voice one opens with the text
    // one's prefix up to its transcript.
    rig.model.push(says("文字。"), says("語音。"));
    await host.runner.run({
      session: { id: host.sessionOf(VC), context: VC },
      wake: { kind: "glance", lines: 1 },
      profile: PROFILES.text,
      signal: new AbortController().signal,
      turn: "text-run",
    });
    hear(rig, "owen", "小鯨魚再一次");
    await until(() => rig.model.requests.length === 3, 3_000, "the second voice run");
    const text = rig.model.requests[1];
    const voice = rig.model.requests[2];
    const head = (text?.messages.length ?? 0) - 2;
    expect(head).toBeGreaterThan(1);
    expect(serialiseMessages(voice?.messages.slice(0, head) ?? [])).toEqual(
      serialiseMessages(text?.messages.slice(0, head) ?? []),
    );
    expect(serialiseTools(voice?.tools ?? [])).toEqual(serialiseTools(text?.tools ?? []));
  });
});

describe("the switch", () => {
  it('with runner = "mainline" voice runs on the old path and nothing of this runs', async () => {
    const rig = await voiceRig({}, { config: { runner: "mainline" } });
    rig.model.push(says("舊的路。"), [done()]);
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(
      () =>
        rig.of<DecisionTrace>(Events.AgentDecision.type).some((d) => d.context.kind === "voice"),
      3_000,
      "the old path's decision",
    );
    expect(rig.host).toBeNull();
    expect(rig.factoryCalls).toBe(0);
    const decisions = rig.of<DecisionTrace>(Events.AgentDecision.type);
    expect(decisions.every((d) => !d.reasons.includes("runner self"))).toBe(true);
  });
});
