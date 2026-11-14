// What counts as her starting to talk and as a person answering her (`unanswered.ts`), and an
// older saved ledger state.

import { type Event, toTimestamp, type VoiceUtterance } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanResponse, LedgerSnapshotSchema, startsTalk } from "../src/index.js";
import { acct, impulse, ManualClock, T0, textCtx, voiceCtx } from "./helpers.js";

const VOICE = voiceCtx("v1");

afterEach(() => {
  vi.useRealTimers();
});

describe("what counts", () => {
  it("startsTalk: her wishes, narration and memory followups only", () => {
    const clock = new ManualClock();
    const of = (i: Parameters<typeof impulse>[1]) => startsTalk(impulse(clock, i));
    expect(of({ source: "plan", context: VOICE })).toBe(true);
    expect(of({ source: "agenda", context: VOICE })).toBe(true);
    expect(of({ source: "followup", context: VOICE, reason: "followup" })).toBe(true);
    expect(
      of({
        source: "game",
        context: VOICE,
        attention: { key: "k", repeat_after_ms: 1 },
      }),
    ).toBe(true);
    expect(of({ source: "game", context: VOICE })).toBe(false);
    expect(of({ source: "followup", context: VOICE, reason: "action_result" })).toBe(false);
    for (const source of ["song", "notice", "world", "message", "command", "panel"] as const) {
      expect(of({ source, context: VOICE })).toBe(false);
    }
  });

  const message = (who: string, isBot: boolean): Event => ({
    type: "platform_message_created",
    data: {
      id: { context: textCtx("c"), id: "m" },
      author: { account: acct(who), display_name: who, is_bot: isBot },
      text: "hi",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(T0),
    },
  });
  const utterance = (who: string, text: string, isBot = false): Event => ({
    type: "voice_utterance",
    data: {
      context: VOICE,
      speaker: { account: acct(who), display_name: who, is_bot: isBot },
      text,
    } as unknown as VoiceUtterance,
  });
  const isSelf = (a: { id: string }): boolean => a.id === "her";

  it("humanResponse: a person's message or speech, addressed to her or not", () => {
    expect(humanResponse(message("a", false), isSelf)).toEqual({
      context: textCtx("c"),
      account: acct("a"),
    });
    expect(humanResponse(utterance("a", "嗯。"), isSelf)).toEqual({
      context: VOICE,
      account: acct("a"),
    });
  });

  it("humanResponse: not her, not bots, not silence, not people coming and going", () => {
    expect(humanResponse(message("her", false), isSelf)).toBeNull();
    expect(humanResponse(message("b", true), isSelf)).toBeNull();
    expect(humanResponse(utterance("her", "欸"), isSelf)).toBeNull();
    expect(humanResponse(utterance("b", "欸", true), isSelf)).toBeNull();
    expect(humanResponse(utterance("a", "   "), isSelf)).toBeNull();
    expect(
      humanResponse(
        { type: "voice_participants", data: { context: VOICE, participants: [] } },
        isSelf,
      ),
    ).toBeNull();
  });
});

describe("the state survives a restart", () => {
  it("an older saved state still loads", () => {
    const old = {
      starts: [],
      places: [{ key: "k", kind: "voice", context: null, misses: 1, misses_at: 0 }],
      streak: 0,
      topics: [],
    };
    const parsed = LedgerSnapshotSchema.parse(old);
    expect(parsed.said).toEqual([]);
    expect(parsed.places[0]?.unanswered).toBe(0);
  });
});
