// The 2026-11-07 run: she said she would close the game and rejoin voice, and did neither.
// A promise counts as a claim like "done" does: until a tool call, an accepted task or her state
// backs it, it is not sent as it stands (claims.ts, turn.ts).

import { describe, expect, it } from "vitest";
import { unbackedClaim } from "../src/claims.js";

const OFFERED = new Set(["game_stop", "voice_join"]);
const BARE = { requests: new Set<never>(), tools: new Set<string>(), scope: null };

describe("leaving voice in plain words", () => {
  // 2026-11-09: asked to leave so the others could talk, she said so and stayed.
  const LEAVE = new Set(["voice_leave"]);
  it("is a claim when she says she is going and does not", () => {
    expect(unbackedClaim("算了,好啦……那我先出去喔,要叫我再回來。", LEAVE, BARE)?.tool).toBe(
      "voice_leave",
    );
    expect(unbackedClaim("好,我先走了。", LEAVE, BARE)?.tool).toBe("voice_leave");
    expect(unbackedClaim("我離開語音了。", LEAVE, BARE)?.tool).toBe("voice_leave");
  });
  it("is not one when she refuses, or when the tool did it", () => {
    expect(unbackedClaim("我才不要出去。", LEAVE, BARE)).toBeNull();
    expect(
      unbackedClaim("那我先出去喔。", LEAVE, { ...BARE, tools: new Set(["voice_leave"]) }),
    ).toBeNull();
    expect(unbackedClaim("那我先出去喔。", new Set(["voice_join"]), BARE)).toBeNull(); // not in voice: no tool
  });
});

describe("a promise with no action behind it", () => {
  it("is a claim until the request or the tool call that backs it is there", () => {
    const text = "好啦,我馬上關麥塊。";
    expect(unbackedClaim(text, OFFERED, BARE)?.tool).toBe("game_stop");
    expect(
      unbackedClaim(text, OFFERED, { ...BARE, requests: new Set(["stop" as const]) }),
    ).toBeNull();
    expect(unbackedClaim(text, OFFERED, { ...BARE, tools: new Set(["game_stop"]) })).toBeNull();
    // Refusing or talking about it is not promising it.
    expect(unbackedClaim("我不關麥塊。", OFFERED, BARE)).toBeNull();
  });
});
