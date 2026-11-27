// Her state in block 7 (`self.mood`). Review 2026-11-27: boredom and the drives were read only
// when there was no affect snapshot, and there always is one, so none of them reached her.

import type { AffectState, ContextKey, Drives } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { moodBlock } from "../src/self-block.js";

const CTX: ContextKey = { platform: "test", scope: "g", channel: "c1", kind: "channel" };

const CALM: Drives = {
  social: 0.4,
  play: 0.4,
  attention: 0.4,
  rest: 0.4,
  curiosity: 0.4,
  esteem: 0.4,
  hunger: 0.4,
  longing: 0,
};

function affect(drives: Partial<Drives>, boredom = 0.2): AffectState {
  const snapshot = {
    mood_line: "心情不錯",
    top: [],
    shown: null,
    drives: { ...CALM, ...drives },
    boredom,
  };
  return { snapshot: () => snapshot } as unknown as AffectState;
}

const block = (a: AffectState) => moodBlock({ context: CTX, now: 0, affect: a });

describe("her drives in the mood block", () => {
  it("says the drives that stand out and her boredom, from the snapshot", () => {
    const text = block(affect({ play: 0.9, social: 0.7, esteem: 0.8 }, 0.75));
    expect(text).toContain("你現在很無聊、很想玩遊戲、很想被誇、想表現一下、很想跟人聊天。");
  });

  it("says nothing of drives that are ordinary", () => {
    expect(block(affect({}))).toBe("你現在的心情:心情不錯");
  });

  it("keeps it short: at most three wants", () => {
    const text = block(
      affect({ social: 0.9, play: 0.85, attention: 0.8, curiosity: 0.75, esteem: 0.7 }),
    );
    expect(text).toContain("很想跟人聊天、很想玩遊戲、很想被大家注意。");
    expect(text).not.toContain("新鮮");
  });

  it("says what is notably met: talked enough, full of energy, not hungry", () => {
    const text = block(affect({ social: 0.05, rest: 0.02, hunger: 0.05 }));
    expect(text).toContain("你現在跟人聊得很夠了,不太想再主動找話題、精神很好。");
    expect(text).toContain("你現在不餓。");
  });

  it("says she is hungry when she is", () => {
    expect(block(affect({ hunger: 0.9 }))).toContain("肚子餓,很想吃白飯(Token)");
  });
});
