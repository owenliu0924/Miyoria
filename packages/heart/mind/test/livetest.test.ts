// The live-test scenario (busy voice channel, she kept starting conversations about the same
// stale topics and retrying `game.start` while Minecraft was not running), reproduced against
// Plan. Without the Arbiter her own floor applies (these tests); with it, the Arbiter decides.

import { MockProvider } from "@miyoria/llm/llm";
import {
  type ContextKey,
  contextKeyString,
  Events,
  type Thought,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MindLoop } from "../src/index.js";
import { texts } from "./fakes.js";
import { HER, OWEN, type Rig, rig, stopRigs, TEXT, VOICE, wait } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T10:20:00.000Z")); // 18:20 at UTC+8
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const MIN = 60_000;
const AQUA = { platform: "discord", id: "300" };
const HERE = contextKeyString(TEXT);

function reply(impulses: unknown[], thought = "嗯。"): string {
  return JSON.stringify({ thought, impulses });
}

const speak = (hint: string, why: string) => ({
  kind: "speak",
  capability: "chat.start",
  place: HERE,
  why,
  hint,
});

/** A rig whose loop does not plan on its own (paused): the test drives every Plan. */
async function manual(
  provider: MockProvider,
): Promise<Rig & { plan(c?: ContextKey): Promise<Thought> }> {
  const r = await rig(provider, { config: { min_interval_secs: 0, max_calls_per_hour: 100 } });
  await r.registry.setPaused(true);
  let n = 0;
  r.intents.outcome = () => ({ status: "started", detail: "queued", turn: `T${++n}` });
  const loop = r.mind() as unknown as MindLoop;
  return Object.assign(r, {
    async plan(context: ContextKey = TEXT): Promise<Thought> {
      const t = await loop.plan([{ kind: "manual", detail: "", context }]);
      await wait(10);
      return r
        .mind()
        .thoughts()
        .find((x) => x.id === t?.id) as Thought;
    },
  });
}

/** Her intent turn `turn` opened and she said `text` in it. */
function spoke(r: Rig, turn: string, context: ContextKey, text: string): void {
  r.publish(Events.AgentDecision, {
    turn,
    context,
    respond: true,
    score: 0,
    reasons: ["intent:chat.start"],
  });
  r.publish(Events.AgentTurnCompleted, { turn, context, text });
}

/** Someone addressed her in `context` (attention's decision on their message). */
function _addressed(r: Rig, context: ContextKey): void {
  r.publish(Events.AgentDecision, {
    turn: `R${Date.now()}`,
    context,
    respond: true,
    score: 0.8,
    reasons: ["mode ambient", "direct: name `小鯨`"],
  });
}

const _status = (t: Thought) => t.intents.map((i) => [i.capability, i.status, i.detail]);

describe("announcements (v2 §5 item 12)", () => {
  it("a song announcement nobody answers is no topic of hers", async () => {
    const r = await manual(new MockProvider("p"));
    for (const [i, reason] of ["initiative:song_start", "initiative:song_done"].entries()) {
      r.publish(Events.AgentDecision, {
        turn: `S${i}`,
        context: TEXT,
        respond: true,
        score: 0,
        reasons: [reason],
      });
      r.publish(Events.AgentTurnCompleted, {
        turn: `S${i}`,
        context: TEXT,
        text: "下一首要開始囉",
      });
    }
    await wait(30 * 60_000);
    expect(r.mind().unanswered?.(TEXT)).toEqual([]);
  });
});

describe("a busy voice channel", () => {
  const member = (id: string, self: boolean): VoiceParticipant => ({
    account: { platform: "discord", id },
    display_name: id,
    is_self: self,
    muted: false,
    deafened: false,
  });
  const utterance = (who: { platform: string; id: string }, name: string) => ({
    id: `u${Date.now()}`,
    context: VOICE,
    speaker: { account: who, display_name: name, is_bot: false },
    text: "然後我就把它挖掉了",
    language: "zh",
    emotion: null,
    audio_events: [],
    started_at: toTimestamp(Date.now()),
    ended_at: toTimestamp(Date.now()),
    asr_ms: 100,
  });
  const join = (r: Rig) => {
    r.publish(Events.PlatformReady, { platform: "discord", self_account: HER });
    r.publish(Events.VoiceJoined, {
      context: VOICE,
      participants: [member(OWEN.id, false), member(AQUA.id, false), member(HER.id, true)],
    });
  };
  const lulls = (r: Rig) =>
    r
      .mind()
      .thoughts()
      .filter((t) => t.triggers.some((x) => x.detail.includes("秒沒說話了")));

  it("is never judged quiet while people keep talking, and the prompt says they are", async () => {
    const provider = new MockProvider("p").reply('{"thought": "大家聊得好開心。"}');
    const r = await rig(provider);
    r.world.herVoice = VOICE;
    r.world.voiceMembers = [
      { account: OWEN, name: "Owen" },
      { account: AQUA, name: "Aquatf" },
    ];
    join(r);
    // Six minutes of continuous conversation, a line every 20 seconds.
    for (let i = 0; i < 18; i++) {
      r.publish(
        Events.VoiceUtteranceEvent,
        utterance(i % 2 === 0 ? OWEN : AQUA, i % 2 === 0 ? "Owen" : "Aquatf"),
      );
      await wait(20_000);
    }
    expect(lulls(r)).toEqual([]);

    // The world still hears them although the mind missed some lines: not a lull either.
    r.world.voiceActivity = {
      recent_utterances: 14,
      per_minute: 2.8,
      last_at: toTimestamp(Date.now() - 5000),
      secs_since_last: 5,
      recent_speakers: ["Owen", "Aquatf"],
      lively: true,
      her_last_at: null,
    };
    await wait(60_000);
    expect(lulls(r)).toEqual([]);

    // Whatever wakes her, she reads the channel as busy.
    r.mind().suggest({ source: "test", reason: "x", context: VOICE, hint: "看看", about: [] });
    await wait(50_000);
    const plans = provider.requests().filter((q) => q.reasoning_purpose === "plan");
    expect(texts(plans.at(-1)).data).toContain("正在聊天:最近 14 句(Owen、Aquatf),最後一句 5 秒前");
  });

  it("world's channel_quiet for her voice channel wakes Plan (the one cold-channel signal)", async () => {
    const provider = new MockProvider("p").reply('{"thought": "大家怎麼不說話了。"}');
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    join(r);
    const quiet = (context: typeof VOICE | typeof TEXT, detail: string) =>
      r.publish(Events.WorldSalient, {
        kind: "channel_quiet",
        key: `channel_quiet:${context.channel}`,
        account: null,
        person: null,
        display_name: null,
        context: { ...context },
        detail,
        score: 0.3,
        count: 1,
        first_at: toTimestamp(Date.now()),
        at: toTimestamp(Date.now()),
      });
    // A text channel going quiet stays below her wake score.
    quiet(TEXT, "剛剛很熱鬧的頻道安靜下來了");
    await wait(10_000);
    expect(lulls(r)).toEqual([]);
    quiet(VOICE, "語音裡大家 45 秒沒說話了(之前 5 分鐘 6 句)");
    await wait(10_000);
    expect(lulls(r)).toHaveLength(1);
  });

  it("does not count her own lines as a conversation that went quiet", async () => {
    const provider = new MockProvider("p").reply('{"thought": "嗯。"}');
    const r = await rig(provider);
    join(r);
    r.publish(Events.VoiceUtteranceEvent, utterance(OWEN, "Owen"));
    for (let i = 0; i < 3; i++) {
      await wait(5000);
      r.publish(Events.VoicePlaybackEvent, {
        context: VOICE,
        turn: null,
        state: "started",
        text: "過來陪我玩麥塊",
      });
    }
    await wait(60_000);
    expect(provider.requests()).toHaveLength(0);
  });
});

describe("after her turns", () => {
  it("no turn of hers, started herself or not, wakes Plan", async () => {
    const provider = new MockProvider("p").reply(reply([speak("嗨", "想聊天")]));
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    let n = 0;
    r.intents.outcome = () => ({ status: "started", detail: "queued", turn: `T${++n}` });
    r.mind().suggest({
      source: "initiative",
      reason: "idle_channel",
      context: TEXT,
      hint: "冷場",
      about: [],
    });
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
    await wait(6 * MIN);
    spoke(r, "T1", TEXT, "嗨大家~");
    r.publish(Events.AgentDecision, {
      turn: "R1",
      context: TEXT,
      respond: true,
      score: 0.9,
      reasons: ["direct: mention"],
    });
    r.publish(Events.AgentTurnCompleted, { turn: "R1", context: TEXT, text: "好啊" });
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
  });
});

describe("channel levels", () => {
  it("are shown with the place", async () => {
    const start = reply([speak("大家好", "想聊天")]);
    const provider = new MockProvider("p").reply(start).reply(start);
    const r = await manual(provider);
    let blocked: string | null = null;
    r.intents.levels = (c) =>
      c.kind === "voice" ? null : { mode: "quiet", label: "安靜", blocked };
    await r.plan();
    expect(texts(provider.requests()[0]).data).toContain("聊天等級「安靜」");
    expect(texts(provider.requests()[0]).system).toContain("「安靜」的頻道很少主動開口");

    blocked = "level quiet: she started talking here 0 min ago; next in 180 min";
    await wait(11 * MIN);
    await r.plan();
    expect(texts(provider.requests()[1]).data).toContain("聊天等級「安靜」,現在不能主動開口");
    expect(r.intents.intents).toEqual([]);
  });
});
