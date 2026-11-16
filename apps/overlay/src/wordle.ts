// The Wordle board on the overlay: a grid of `maxGuesses` rows of five tiles, her guesses filled in
// from the top. A new guess turns over tile by tile, left to right; the line under the grid says
// how the game ended. The view decides when the board shows; this only draws it.
import type { WordleBoard } from "./feed.js";
import { isPresent, present } from "./motion.js";

/** How long a finished game stays up before it fades (ms). */
export const WORDLE_LINGER_MS = 15_000;

const WORD = 5;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: Element, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
}

/** The line under a finished board. */
export function wordleResult(board: WordleBoard): string | null {
  switch (board.state) {
    case "playing":
      return null;
    case "won":
      return `第 ${board.rows.length} 次就猜中了!`;
    case "lost":
      return `沒猜到,答案是 ${board.answer}`;
    case "gave_up":
      return `放棄了,答案是 ${board.answer}`;
  }
}

export class WordleView {
  readonly el: HTMLElement;
  private readonly count: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly result: HTMLElement;
  private readonly resultText: HTMLElement;
  /** Tiles, row by row. */
  private tiles: HTMLElement[][] = [];
  /** Rows filled in so far. */
  private filled = 0;

  constructor(parent: Element) {
    this.el = el("section", "wordle is-out", parent);
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Wordle");
    const head = el("div", "wordle__head", this.el);
    el("span", "wordle__title", head, "WORDLE");
    this.count = el("span", "wordle__count", head);
    this.grid = el("div", "wordle__grid", this.el);
    const result = el("div", "fold wordle__result is-out", this.el);
    result.hidden = true;
    this.result = result;
    this.resultText = el("div", "fold__in", result);
  }

  /** Shows `board`, or takes the board away when it is null. */
  render(board: WordleBoard | null): void {
    if (board === null) {
      present(this.el, false);
      return;
    }
    const appearing = !isPresent(this.el);
    // Another game (fewer rows than drawn, or another size): start from an empty grid.
    if (board.maxGuesses !== this.tiles.length || board.rows.length < this.filled || appearing) this.reset(board.maxGuesses);
    board.rows.forEach((row, r) => {
      if (r < this.filled) return;
      const tiles = this.tiles[r] ?? [];
      for (let i = 0; i < WORD; i++) {
        const tile = tiles[i];
        if (!tile) continue;
        tile.textContent = row.word[i] ?? "";
        tile.className = `wordle__tile is-${row.marks[i] ?? "absent"}`;
        // Turned over one after another; a board that is only appearing shows them at once.
        if (!appearing) tile.classList.add("is-flip");
        tile.style.setProperty("--i", String(i));
      }
    });
    this.filled = board.rows.length;
    this.count.textContent = `${board.rows.length} / ${board.maxGuesses}`;
    const line = wordleResult(board);
    if (line !== null) this.resultText.textContent = line;
    this.result.classList.toggle("is-won", board.state === "won");
    present(this.result, line !== null, appearing);
    present(this.el, true);
  }

  private reset(rows: number): void {
    // More rows than the usual six: smaller tiles, so the board still fits above the subtitles.
    this.el.style.setProperty("--tile", rows > 6 ? `${Math.max(2.2, 21 / rows).toFixed(2)}rem` : "");
    this.grid.replaceChildren();
    this.tiles = [];
    this.filled = 0;
    for (let r = 0; r < rows; r++) {
      const row = el("div", "wordle__row", this.grid);
      this.tiles.push(Array.from({ length: WORD }, () => el("div", "wordle__tile", row)));
    }
  }
}
