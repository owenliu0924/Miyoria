import { describe, expect, it } from "vitest";
import type { WordleBoard, WordleRow } from "../src/feed.js";
import { wordleMarks } from "../src/wordle-demo.js";
import { endMessage, planWordle, rejectReason } from "../src/wordle-plan.js";

const ANSWER = "CRANE";
const row = (word: string): WordleRow => ({ word, marks: wordleMarks(word, ANSWER) });
const board = (words: string[], over: Partial<WordleBoard> = {}): WordleBoard => ({
  rows: words.map(row),
  maxGuesses: 6,
  state: "playing",
  answer: null,
  attempts: words.length,
  rejected: null,
  ...over,
});

describe("wordleMarks (the demo's scoring)", () => {
  it("marks greens first, then one yellow per letter left", () => {
    expect(wordleMarks("STARE", "CRANE")).toEqual(["absent", "absent", "correct", "present", "correct"]);
    expect(wordleMarks("EERIE", "CRANE")).toEqual(["absent", "absent", "present", "absent", "correct"]);
  });
});

describe("planWordle", () => {
  it("draws a board seen for the first time as it is", () => {
    expect(planWordle(null, board([]))).toEqual([{ kind: "reset", maxGuesses: 6 }]);
    // Opened mid-game: the rows at once, no typing.
    expect(planWordle(null, board(["STARE", "GRAND"]))).toEqual([
      { kind: "reset", maxGuesses: 6 },
      { kind: "fill", rows: [row("STARE"), row("GRAND")] },
    ]);
    // Opened after the end: the rows and the message.
    expect(planWordle(null, board(["CRANE"], { state: "won", answer: ANSWER }))).toEqual([
      { kind: "reset", maxGuesses: 6 },
      { kind: "fill", rows: [row("CRANE")] },
      { kind: "end", message: "天才!", won: true, row: 0 },
    ]);
  });

  it("types each new guess into the next row", () => {
    expect(planWordle(board(["STARE"]), board(["STARE", "GRAND"]))).toEqual([
      { kind: "guess", index: 1, row: row("GRAND") },
    ]);
    expect(planWordle(board(["STARE"]), board(["STARE", "GRAND", "CRANE"]))).toHaveLength(2);
  });

  it("types a refused word and says why; the same board again plays nothing", () => {
    const refused = board(["STARE"], { attempts: 2, rejected: "CRANX" });
    expect(planWordle(board(["STARE"]), refused)).toEqual([
      { kind: "reject", index: 1, word: "CRANX", reason: "不在單字表裡" },
    ]);
    expect(planWordle(refused, refused)).toEqual([]);
    // The same word refused twice in a row is two attempts: it plays again.
    expect(planWordle(refused, { ...refused, attempts: 3 })).toHaveLength(1);
  });

  it("ends a game: the row bounces on a win, the answer shows otherwise", () => {
    const five = ["STARE", "GRAND", "BRAND", "GRANT", "PRANK"];
    expect(planWordle(board(five), board([...five, "CRANE"], { state: "won", answer: ANSWER }))).toEqual([
      { kind: "guess", index: 5, row: row("CRANE") },
      { kind: "end", message: "好險!", won: true, row: 5 },
    ]);
    expect(planWordle(board(["STARE"]), board(["STARE"], { state: "gave_up", answer: ANSWER }))).toEqual([
      { kind: "end", message: "CRANE", won: false, row: 0 },
    ]);
  });

  it("starts over for another game, and hides when the board goes", () => {
    const done = board(["CRANE"], { state: "won", answer: ANSWER });
    expect(planWordle(done, board([]))).toEqual([{ kind: "reset", maxGuesses: 6 }]);
    expect(planWordle(board(["STARE"]), board([], { maxGuesses: 8 }))).toEqual([{ kind: "reset", maxGuesses: 8 }]);
    expect(planWordle(board(["STARE"]), board(["GRAND"]))[0]).toEqual({ kind: "reset", maxGuesses: 6 });
    expect(planWordle(done, null)).toEqual([{ kind: "hide" }]);
    expect(planWordle(null, null)).toEqual([]);
  });
});

describe("messages", () => {
  it("says why a word is refused, like the original", () => {
    expect(rejectReason("HMM", [])).toBe("要 5 個字母");
    expect(rejectReason("STARE", [row("STARE")])).toBe("已經猜過了");
    expect(rejectReason("CRANX", [])).toBe("不在單字表裡");
  });

  it("praises a win by the number of guesses and tells the answer otherwise", () => {
    expect(endMessage(board(["CRANE"], { state: "won", answer: ANSWER }))).toBe("天才!");
    expect(endMessage(board(["STARE", "GRAND", "CRANE"], { state: "won", answer: ANSWER }))).toBe("厲害!");
    expect(endMessage(board(["STARE"], { state: "lost", answer: ANSWER }))).toBe("CRANE");
  });
});
