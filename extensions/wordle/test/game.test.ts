import { describe, expect, it } from "vitest";
import { type Dictionary, Game, score } from "../src/game.js";

const dictionary: Dictionary = {
  answers: ["crane"],
  allowed: new Set(["crane", "slate", "eerie", "speed", "abide", "erase", "robot"]),
};
const g = "correct";
const p = "present";
const a = "absent";

describe("score", () => {
  it("marks every letter right", () => {
    expect(score("crane", "crane")).toEqual([g, g, g, g, g]);
    expect(score("slate", "crane")).toEqual([a, a, g, a, g]);
  });

  it("gives a repeated letter a yellow only as often as the answer has it", () => {
    // one E in the answer, and the last E is green: the other Es get nothing
    expect(score("eerie", "crane")).toEqual([a, a, p, a, g]);
    // one E in the answer: only the first guessed E is yellow
    expect(score("speed", "abide")).toEqual([a, a, p, a, p]);
    // two Es in the answer: both guessed Es count
    expect(score("erase", "speed")).toEqual([p, a, a, p, p]);
  });

  it("takes the green first, so a green letter is never also a yellow", () => {
    // ROBOT has two Os: the O in place is green, the other one is yellow
    expect(score("floor", "robot")).toEqual([a, a, p, g, p]);
  });
});

describe("Game", () => {
  it("wins, loses and rejects what does not count", () => {
    const game = new Game("crane", 2, dictionary);
    expect(game.guess("abc")).toMatchObject({ ok: false });
    expect(game.guess("zzzzz")).toMatchObject({ ok: false });
    expect(game.guesses).toHaveLength(0);
    expect(game.guess("SLATE")).toMatchObject({ ok: true, won: false, lost: false });
    expect(game.guess("slate")).toMatchObject({ ok: false });
    expect(game.guess("eerie")).toMatchObject({ ok: true, lost: true });
    expect(game.finished).toBe(true);
    expect(game.guess("crane")).toMatchObject({ ok: false });

    const second = new Game("crane", 6, dictionary);
    expect(second.guess("crane")).toMatchObject({ ok: true, won: true });
  });

  it("sums up the letters", () => {
    const game = new Game("crane", 6, dictionary);
    game.guess("slate");
    expect(game.letters()).toMatchObject({ correct: "AE", absent: "LST" });
    expect(game.letters().unused).toBe("BCDFGHIJKMNOPQRUVWXYZ");
  });
});
