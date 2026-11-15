// Subtitles of her speech ahead of the voice, and her resting face.

import {
  type ContextKey,
  customEvent,
  type Event,
  newEnvelope,
  VOICE_UPCOMING_TOPIC,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type CoreMessage, Forwarder, parseCoreMessage } from "../src/index.js";

/** An old-form event as the bus delivers it. */
const ev = (event: Event) => newEnvelope("test", event);

const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const TURN = "01JTURN0000000000000000000";

const playback = (state: "started" | "finished", text: string): Event =>
  ({
    type: "voice_playback",
    data: { context: VOICE, turn: TURN, state, text, emotion: null },
  }) as Event;
const subtitles = (out: CoreMessage[]) => out.filter((m) => m.type === "subtitle");

describe("her resting face", () => {
  const affect = (tag: string | null, intensity = 0.6): Event =>
    customEvent("affect.changed", {
      shown: tag === null ? null : { from: "sorrow", tag, style: "", masked: false },
      top: tag === null ? [] : [{ name: "sorrow", intensity }],
    });
  const emotions = (out: CoreMessage[]) => out.filter((m) => m.type === "emotion");

  it("follows what she shows, also while she says nothing", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(ev(affect("sad")))).toEqual([
      { type: "emotion", name: "sad", intensity: 0.6, resting: true },
    ]);
    expect(f.onEvent(ev(affect(null)))).toEqual([
      { type: "emotion", name: "neutral", intensity: 0, resting: true },
    ]);
  });

  it("only when it changed", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(ev(affect(null)))).toEqual([]);
    f.onEvent(ev(affect("sad", 0.6)));
    expect(f.onEvent(ev(affect("sad", 0.65)))).toEqual([]);
    expect(f.onEvent(ev(affect("sad", 0.8)))).toHaveLength(1);
    expect(f.onEvent(ev(affect("annoyed", 0.8)))).toHaveLength(1);
  });

  it("a node that connects gets it", () => {
    const f = new Forwarder(false);
    expect(f.resumeResting()).toBeNull();
    f.onEvent(ev(affect("sad")));
    expect(f.resumeResting()).toEqual({
      type: "emotion",
      name: "sad",
      intensity: 0.6,
      resting: true,
    });
  });

  it("a line said in it without a marker shows it as strongly as she feels it", () => {
    const f = new Forwarder(false);
    f.onEvent(ev(affect("sad", 0.5)));
    const line = (emotion: string): Event =>
      ({
        type: "voice_playback",
        data: { context: VOICE, turn: TURN, state: "started", text: "嗯", emotion },
      }) as Event;
    expect(emotions(f.onEvent(ev(line("sad"))))).toEqual([
      { type: "emotion", name: "sad", intensity: 0.5 },
    ]);
    // Another tag than what she shows: the marker's own strength, as before.
    expect(emotions(f.onEvent(ev(line("happy"))))).toEqual([
      { type: "emotion", name: "happy", intensity: 1 },
    ]);
  });

  it("a payload that is not a snapshot is her plain rest", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(ev(customEvent("affect.changed", "no")))).toEqual([]);
  });

  it("the protocol carries it, and an older message still reads", () => {
    expect(parseCoreMessage({ type: "emotion", name: "sad", intensity: 1, resting: true })).toEqual(
      {
        type: "emotion",
        name: "sad",
        intensity: 1,
        resting: true,
      },
    );
    expect(parseCoreMessage({ type: "emotion", name: "sad", intensity: 1 })).toEqual({
      type: "emotion",
      name: "sad",
      intensity: 1,
    });
  });
});

describe("subtitles ahead of the voice", () => {
  const upcoming = (text: string, turn = TURN): Event =>
    customEvent(VOICE_UPCOMING_TOPIC, { turn, context: { ...VOICE }, text, emotion: null });
  const failed = (text: string): Event =>
    ({
      type: "voice_playback",
      data: { context: VOICE, turn: TURN, state: "failed", text, emotion: null },
    }) as Event;
  const completed = (): Event =>
    ({ type: "agent_turn_completed", data: { turn: TURN, context: VOICE, text: "" } }) as Event;

  it("a line announced as upcoming shows then, and its start adds nothing", () => {
    const f = new Forwarder(false);
    expect(subtitles(f.onEvent(ev(upcoming("你好"))))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好", final: false },
    ]);
    expect(subtitles(f.onEvent(ev(playback("started", "你好"))))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好", final: false },
    ]);
    // The next one is announced while the first still plays.
    expect(subtitles(f.onEvent(ev(upcoming("還好嗎?"))))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好還好嗎?", final: false },
    ]);
    f.onEvent(ev(playback("finished", "你好")));
    // The turn is written out but its last line has not played: not final yet.
    expect(subtitles(f.onEvent(ev(completed())))).toEqual([]);
    f.onEvent(ev(playback("started", "還好嗎?")));
    expect(subtitles(f.onEvent(ev(playback("finished", "還好嗎?"))))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好還好嗎?", final: true },
    ]);
  });

  it("an announced line that fails is taken out again", () => {
    const f = new Forwarder(false);
    f.onEvent(ev(upcoming("一")));
    f.onEvent(ev(playback("started", "一")));
    f.onEvent(ev(upcoming("二")));
    f.onEvent(ev(upcoming("三")));
    f.onEvent(ev(playback("finished", "一")));
    expect(subtitles(f.onEvent(ev(failed("二"))))).toEqual([
      { type: "subtitle", turn: TURN, text: "一三", final: false },
    ]);
    f.onEvent(ev(completed()));
    f.onEvent(ev(playback("started", "三")));
    expect(subtitles(f.onEvent(ev(playback("finished", "三"))))).toEqual([
      { type: "subtitle", turn: TURN, text: "一三", final: true },
    ]);
  });
});
