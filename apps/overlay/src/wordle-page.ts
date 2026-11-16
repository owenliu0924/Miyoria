// The Wordle page (`?layer=wordle`): her game drawn like the original, full screen. A header, the
// grid, the keyboard. Every word she plays is typed in letter by letter (the key lights up), then
// entered: a real guess turns over tile by tile and colours the keyboard, a refused one shakes,
// shows why and is taken back. A win bounces the row. The page is transparent while there is no
// game and fades in with the first board.
//
// Steps come from wordle-plan.ts and play one after another; a board that comes while one plays
// waits its turn. Taking the page away (or a new game) drops whatever was still to play.
import type { WordleBoard, WordleMark, WordleRow } from "./feed.js";
import { planWordle, type WordleStep } from "./wordle-plan.js";
import "./wordle.css";

/** How long a finished game stays up before the page fades (ms). */
export const WORDLE_LINGER_MS = 15_000;

/** Timings (ms) at normal speed; reduced motion plays everything at once. */
const T = {
  /** Between two typed letters. */
  type: 230,
  /** After the last letter, before Enter. */
  enter: 380,
  /** One tile turning over; the next starts `flipStep` later. */
  flip: 520,
  flipStep: 280,
  shake: 600,
  /** A refused word stays this long before it is taken back. */
  rejectHold: 900,
  /** Between two letters being taken back. */
  erase: 90,
  /** One tile's bounce; the next starts `bounceStep` later. */
  bounce: 500,
  bounceStep: 100,
  /** A toast for a refused word. */
  toast: 1600,
};

const KEYS = ["QWERTYUIOP", "ASDFGHJKL", "+ZXCVBNM-"];
const RANK: Record<WordleMark, number> = { absent: 0, present: 1, correct: 2 };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
}

/** Restarts a CSS animation class on `e`. */
function play(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

export class WordlePage {
  private readonly page: HTMLElement;
  private readonly board: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly keys = new Map<string, HTMLElement>();
  private tiles: HTMLElement[][] = [];
  private rows: HTMLElement[] = [];
  /** The last board received (what the screen is, or is about to be). */
  private target: WordleBoard | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped when pending steps must be dropped (hide, a new game). */
  private generation = 0;
  private linger: ReturnType<typeof setTimeout> | undefined;

  constructor(
    root: HTMLElement,
    private readonly reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  ) {
    root.replaceChildren();
    this.page = el("main", "wp is-out", root);
    this.page.setAttribute("aria-label", "Wordle");
    const col = el("div", "wp__col", this.page);
    const head = el("header", "wp__head", col);
    el("h1", "wp__title", head, "Wordle");
    const stage = el("div", "wp__stage", col);
    this.toasts = el("div", "wp__toasts", stage);
    this.toasts.setAttribute("role", "status");
    this.board = el("div", "wp__board", stage);
    const keyboard = el("div", "wp__keys", col);
    for (const line of KEYS) {
      const row = el("div", "wp__keyrow", keyboard);
      for (const k of line) {
        const label = k === "+" ? "ENTER" : k === "-" ? "⌫" : k;
        const key = el("div", k === "+" || k === "-" ? "wp__key wp__key--wide" : "wp__key", row, label);
        this.keys.set(k, key);
      }
    }
  }

  /** A board from the feed (`null`: take the page away). */
  update(next: WordleBoard | null): void {
    const steps = planWordle(this.target, next);
    this.target = next;
    if (steps.length === 0) return;
    clearTimeout(this.linger);
    // Hiding, or another game: whatever was still to play is no longer worth playing.
    if (steps[0]?.kind === "hide" || steps[0]?.kind === "reset") this.generation += 1;
    const gen = this.generation;
    this.queue = this.queue.then(async () => {
      for (const step of steps) {
        if (gen !== this.generation) return;
        await this.run(step, gen);
      }
    });
  }

  // ── steps ────────────────────────────────────────────────────────────────

  private async run(step: WordleStep, gen: number): Promise<void> {
    switch (step.kind) {
      case "hide":
        this.page.classList.add("is-out");
        return;
      case "reset":
        this.reset(step.maxGuesses);
        this.page.classList.remove("is-out");
        return;
      case "fill":
        step.rows.forEach((row, r) => {
          this.setRow(r, row.word);
          row.marks.forEach((mark, i) => {
            this.reveal(r, i, mark);
          });
          this.colourKeys(row);
        });
        return;
      case "guess":
        await this.typeWord(step.index, step.row.word, gen);
        await this.flipRow(step.index, step.row, gen);
        this.colourKeys(step.row);
        return;
      case "reject":
        await this.rejectWord(step.index, step.word, step.reason, gen);
        return;
      case "end":
        await this.end(step, gen);
        return;
    }
  }

  private reset(maxGuesses: number): void {
    this.toasts.replaceChildren();
    this.board.replaceChildren();
    // More rows than the usual six: smaller tiles, so the board still fits.
    this.page.style.setProperty("--wp-rows", String(Math.max(6, maxGuesses)));
    this.tiles = [];
    this.rows = [];
    for (let r = 0; r < maxGuesses; r++) {
      const row = el("div", "wp__row", this.board);
      this.rows.push(row);
      this.tiles.push(Array.from({ length: 5 }, () => el("div", "wp__tile", row)));
    }
    for (const key of this.keys.values()) delete key.dataset.state;
  }

  /** Types `word` into row `r` (five letters at most), each key lighting up, then presses Enter. */
  private async typeWord(r: number, word: string, gen: number): Promise<boolean> {
    const letters = [...word.slice(0, 5)];
    for (let i = 0; i < letters.length; i++) {
      if (!(await this.wait(i === 0 ? 0 : T.type, gen))) return false;
      const letter = letters[i] as string;
      const tile = this.tiles[r]?.[i];
      if (tile) {
        tile.textContent = letter;
        tile.dataset.state = "tbd";
        play(tile, "is-pop");
      }
      this.press(letter);
    }
    if (!(await this.wait(T.enter, gen))) return false;
    this.press("+");
    return true;
  }

  private async flipRow(r: number, row: WordleRow, gen: number): Promise<void> {
    const tiles = this.tiles[r] ?? [];
    tiles.forEach((tile, i) => {
      setTimeout(() => {
        play(tile, "is-flip");
        // The colour shows when the tile is edge-on, halfway through.
        setTimeout(() => this.reveal(r, i, row.marks[i] ?? "absent"), this.ms(T.flip) / 2);
      }, this.ms(T.flipStep) * i);
    });
    await this.wait(T.flipStep * (tiles.length - 1) + T.flip, gen);
  }

  private async rejectWord(r: number, word: string, reason: string, gen: number): Promise<void> {
    if (!(await this.typeWord(r, word, gen))) return;
    const row = this.rows[r];
    if (row) play(row, "is-shake");
    this.toast(reason, T.toast);
    if (!(await this.wait(T.rejectHold, gen))) return;
    // Taken back with the backspace key, last letter first.
    const tiles = this.tiles[r] ?? [];
    for (let i = Math.min(word.length, 5) - 1; i >= 0; i--) {
      const tile = tiles[i];
      if (tile) {
        tile.textContent = "";
        delete tile.dataset.state;
      }
      this.press("-");
      if (!(await this.wait(T.erase, gen))) return;
    }
    row?.classList.remove("is-shake");
  }

  private async end(step: Extract<WordleStep, { kind: "end" }>, gen: number): Promise<void> {
    if (step.won) {
      (this.tiles[step.row] ?? []).forEach((tile, i) => {
        setTimeout(() => play(tile, "is-bounce"), this.ms(T.bounceStep) * i);
      });
      await this.wait(T.bounceStep * 4 + T.bounce, gen);
    }
    if (gen !== this.generation) return;
    this.toast(step.message, null);
    this.linger = setTimeout(() => this.update(null), WORDLE_LINGER_MS);
  }

  // ── pieces ───────────────────────────────────────────────────────────────

  private setRow(r: number, word: string): void {
    (this.tiles[r] ?? []).forEach((tile, i) => {
      tile.textContent = word[i] ?? "";
    });
  }

  private reveal(r: number, i: number, mark: WordleMark): void {
    const tile = this.tiles[r]?.[i];
    if (tile) tile.dataset.state = mark;
  }

  /** Each letter's key takes the best mark it has had. */
  private colourKeys(row: WordleRow): void {
    [...row.word].forEach((letter, i) => {
      const key = this.keys.get(letter);
      const mark = row.marks[i];
      if (!key || !mark) return;
      const was = key.dataset.state as WordleMark | undefined;
      if (was === undefined || RANK[mark] > RANK[was]) key.dataset.state = mark;
    });
  }

  private press(k: string): void {
    const key = this.keys.get(k);
    if (key) play(key, "is-pressed");
  }

  /** A toast over the grid; `ms: null` keeps it (the end of the game). */
  private toast(text: string, ms: number | null): HTMLElement {
    // Newest nearest the grid (the list runs upwards).
    const t = el("div", "wp__toast", this.toasts, text);
    if (ms !== null) {
      setTimeout(() => {
        t.classList.add("is-out");
        setTimeout(() => t.remove(), 400);
      }, this.ms(ms));
    }
    return t;
  }

  private ms(v: number): number {
    return this.reducedMotion ? 0 : v;
  }

  /** Waits `v` ms; false when the step was dropped meanwhile. */
  private async wait(v: number, gen: number): Promise<boolean> {
    const ms = this.ms(v);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    return gen === this.generation;
  }
}
