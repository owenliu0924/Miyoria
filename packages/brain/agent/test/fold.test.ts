// Phase G in turns: history her conversation notes already cover is not repeated raw, and
// lessons shift her ambient talkativeness.

import { MockProvider } from "@miyoria/llm/llm";
import { type Lessons, LessonsKey, SocialSignalsKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channel, Harness, incoming, noCheck, stopHarnesses, wait } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

describe("turns with conversation notes", () => {
  it("lessons about the speaker make her quieter where they apply", async () => {
    const ctx = channel("c2");
    const lessons: Lessons = {
      all: () => [],
      applicable: () => [],
      talkShift: (_c, people) => (people.length > 0 ? -0.4 : 0),
    };
    const chat = new MockProvider("chat").reply("<silence/>");
    const h = await Harness.build("ambient", noCheck(), chat, null, {
      provide: (s) => {
        s.provide("app", LessonsKey, lessons);
        s.provide("app", SocialSignalsKey, {
          attitude: () => ({
            person: "p-owen",
            affinity: 0,
            trust: 0,
            familiarity: 0,
            blocked: false,
            label: "",
            call_name: null,
          }),
        });
      },
    });
    h.say(incoming(ctx, "owen", "今天好累喔大家"));
    await wait(10_000);
    const trace = h.traces().at(-1);
    expect(trace?.reasons.some((r) => r.includes("default+lessons"))).toBe(true);
  });
});
