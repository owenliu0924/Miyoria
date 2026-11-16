// The Wordle page's plan: given the board it shows and the board that just came, what to play on
// screen, in order. Pure (no DOM, no timers), so it is unit tested; wordle-page.ts plays the steps.
//
// A new guess is typed letter by letter, entered and turned over; a refused word is typed, shakes
// and is taken back; a game that ends says so. A board seen for the first time (the page opened
// mid-game, or a new game) is drawn as it is, without replaying what led to it.
import type { WordleBoard, WordleRow } from "./feed.js";

export type WordleStep =
  /** Empty grid of `maxGuesses` rows, keyboard cleared. */
  | { kind: "reset"; maxGuesses: number }
  /** These rows at once, already turned over (a board seen for the first time). */
  | { kind: "fill"; rows: WordleRow[] }
  /** She types `row.word` into row `index`, enters it, and the tiles turn over. */
  | { kind: "guess"; index: number; row: WordleRow }
  /** She types `word`, it is refused (`reason`), the row shakes and the letters go again. */
  | { kind: "reject"; index: number; word: string; reason: string }
  /** The game is over: the message, and the row that bounces (`won`). */
  | { kind: "end"; message: string; won: boolean; row: number }
  /** Take the page away. */
  | { kind: "hide" };

/** What the original says after a win, by the number of guesses (sixth and later: a close one). */
const PRAISE = ["天才!", "太神了!", "厲害!", "漂亮!", "不錯!", "好險!"];

/** What the page says when a game ends. */
export function endMessage(board: WordleBoard): string {
  if (board.state === "won") return PRAISE[Math.min(board.rows.length, PRAISE.length) - 1] ?? "猜中了!";
  return board.answer ?? "";
}

/** Why `word` was refused: the toast the original shows. */
export function rejectReason(word: string, rows: readonly WordleRow[]): string {
  if (word.length !== 5) return "要 5 個字母";
  if (rows.some((r) => r.word === word)) return "已經猜過了";
  return "不在單字表裡";
}

/** Whether `next` is another game than `prev` (not the same one moved on). */
export function isNewGame(prev: WordleBoard, next: WordleBoard): boolean {
  return (
    next.maxGuesses !== prev.maxGuesses ||
    next.attempts < prev.attempts ||
    next.rows.length < prev.rows.length ||
    (prev.state !== "playing" && next.state === "playing") ||
    prev.rows.some((r, i) => r.word !== next.rows[i]?.word)
  );
}

/**
 * The steps from `prev` (the board on screen, `null` for none) to `next` (`null`: take it away).
 * The same board again plans nothing.
 */
export function planWordle(prev: WordleBoard | null, next: WordleBoard | null): WordleStep[] {
  if (next === null) return prev === null ? [] : [{ kind: "hide" }];
  const ending = (): WordleStep[] =>
    next.state === "playing"
      ? []
      : [{ kind: "end", message: endMessage(next), won: next.state === "won", row: next.rows.length - 1 }];

  if (prev === null || isNewGame(prev, next)) {
    const steps: WordleStep[] = [{ kind: "reset", maxGuesses: next.maxGuesses }];
    if (next.rows.length > 0) steps.push({ kind: "fill", rows: next.rows });
    return [...steps, ...ending()];
  }

  const steps: WordleStep[] = [];
  next.rows.slice(prev.rows.length).forEach((row, i) => {
    steps.push({ kind: "guess", index: prev.rows.length + i, row });
  });
  const typedMore = next.attempts > prev.attempts;
  if (typedMore && steps.length === 0 && next.rejected !== null && next.state === "playing") {
    steps.push({
      kind: "reject",
      index: next.rows.length,
      word: next.rejected,
      reason: rejectReason(next.rejected, next.rows),
    });
  }
  if (prev.state === "playing") steps.push(...ending());
  return steps;
}
