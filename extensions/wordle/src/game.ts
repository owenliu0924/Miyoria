// The Wordle rules, with no I/O: scoring a guess (repeated letters included) and one game's state.

export type Mark = "correct" | "present" | "absent";

export const WORD_LENGTH = 5;

const SQUARE: Record<Mark, string> = { correct: "🟩", present: "🟨", absent: "⬛" };

/**
 * Marks each letter of `guess` against `answer`. Greens are taken first, so a letter that appears once
 * in the answer is yellow at most once, and only if no green already used it up.
 */
export function score(guess: string, answer: string): Mark[] {
  const marks: Mark[] = Array.from({ length: guess.length }, () => "absent");
  const left = new Map<string, number>();
  for (let i = 0; i < answer.length; i++) {
    if (guess[i] === answer[i]) marks[i] = "correct";
    else left.set(answer[i]!, (left.get(answer[i]!) ?? 0) + 1);
  }
  for (let i = 0; i < guess.length; i++) {
    if (marks[i] === "correct") continue;
    const n = left.get(guess[i]!) ?? 0;
    if (n > 0) {
      marks[i] = "present";
      left.set(guess[i]!, n - 1);
    }
  }
  return marks;
}

export function render(guess: string, marks: readonly Mark[]): string {
  return `${marks.map((m) => SQUARE[m]).join("")} ${guess.toUpperCase()}`;
}

export interface Dictionary {
  answers: readonly string[];
  /** Every word a guess may be (the answers included). */
  allowed: ReadonlySet<string>;
}

export type GuessResult =
  | { ok: false; reason: string }
  | { ok: true; line: string; won: boolean; lost: boolean };

export type GameState = "playing" | "won" | "lost" | "gave_up";

/** The game as the stream overlay draws it (`ext.miyoria.wordle.board`): capitals, answer only once over. */
export interface Board {
  rows: { word: string; marks: Mark[] }[];
  max_guesses: number;
  state: GameState;
  answer: string | null;
}

export class Game {
  readonly guesses: Array<{ word: string; marks: Mark[] }> = [];
  #state: GameState = "playing";

  constructor(
    private readonly answer: string,
    readonly maxGuesses: number,
    private readonly dictionary: Dictionary,
  ) {}

  get state(): GameState {
    return this.#state;
  }

  get finished(): boolean {
    return this.#state !== "playing";
  }

  /** The answer in capitals, once the game is over (else `null`). */
  reveal(): string | null {
    return this.finished ? this.answer.toUpperCase() : null;
  }

  toBoard(): Board {
    return {
      rows: this.guesses.map((g) => ({ word: g.word.toUpperCase(), marks: [...g.marks] })),
      max_guesses: this.maxGuesses,
      state: this.#state,
      answer: this.reveal(),
    };
  }

  get left(): number {
    return this.maxGuesses - this.guesses.length;
  }

  guess(raw: string): GuessResult {
    if (this.finished) return { ok: false, reason: "這局已經結束了,用 wordle.start 開新的一局" };
    const word = raw.trim().toLowerCase();
    if (!/^[a-z]+$/.test(word) || word.length !== WORD_LENGTH)
      return { ok: false, reason: `要剛好 ${WORD_LENGTH} 個英文字母(不算次數)` };
    if (!this.dictionary.allowed.has(word))
      return { ok: false, reason: `${word.toUpperCase()} 不在單字表裡(不算次數)` };
    if (this.guesses.some((g) => g.word === word))
      return { ok: false, reason: `${word.toUpperCase()} 已經猜過了(不算次數)` };
    const marks = score(word, this.answer);
    this.guesses.push({ word, marks });
    const won = word === this.answer;
    const lost = !won && this.left <= 0;
    if (won) this.#state = "won";
    else if (lost) this.#state = "lost";
    return { ok: true, line: render(word, marks), won, lost };
  }

  /** Ends a game in progress and tells the answer. */
  giveUp(): string {
    if (this.#state === "playing") this.#state = "gave_up";
    return this.answer.toUpperCase();
  }

  /** What the guesses so far say about each letter: the best mark it got, a-z in order. */
  letters(): { correct: string; present: string; absent: string; unused: string } {
    const best = new Map<string, Mark>();
    const rank: Record<Mark, number> = { absent: 0, present: 1, correct: 2 };
    for (const g of this.guesses)
      for (let i = 0; i < g.word.length; i++) {
        const prev = best.get(g.word[i]!);
        if (prev === undefined || rank[g.marks[i]!] > rank[prev]) best.set(g.word[i]!, g.marks[i]!);
      }
    const pick = (mark: Mark) =>
      [...best]
        .filter(([, m]) => m === mark)
        .map(([l]) => l)
        .sort()
        .join("")
        .toUpperCase();
    const unused = "abcdefghijklmnopqrstuvwxyz"
      .split("")
      .filter((l) => !best.has(l))
      .join("")
      .toUpperCase();
    return { correct: pick("correct"), present: pick("present"), absent: pick("absent"), unused };
  }

  board(): string {
    const rows = this.guesses.map((g) => render(g.word, g.marks));
    const l = this.letters();
    return [
      ...rows,
      `剩 ${this.left} 次`,
      `位置對:${l.correct || "-"}  有但位置不對:${l.present || "-"}  沒有:${l.absent || "-"}  還沒試:${l.unused}`,
    ].join("\n");
  }
}
