// Scripted Wordle games for `?layer=wordle&demo=1`: the boards the extension would send, so the page
// can be designed and previewed without the Stage. A win with a refused word on the way, then a loss.
import type { WordleBoard, WordleMark } from "./feed.js";

/** Marks one guess (greens first, then a yellow per letter the answer still has). */
export function wordleMarks(guess: string, answer: string): WordleMark[] {
  const marks: WordleMark[] = Array.from(guess, (c, i) => (c === answer[i] ? "correct" : "absent"));
  const left = Array.from(answer).filter((c, i) => guess[i] !== c);
  Array.from(guess).forEach((c, i) => {
    const at = left.indexOf(c);
    if (marks[i] === "absent" && at >= 0) {
      marks[i] = "present";
      left.splice(at, 1);
    }
  });
  return marks;
}

/** The games: the answer, and what she types (`!` before a word: it is refused). */
const GAMES: { answer: string; inputs: string[] }[] = [
  { answer: "CRANE", inputs: ["STARE", "!CRANX", "GRAND", "CRANE"] },
  { answer: "PIZZA", inputs: ["ADIEU", "CLOUT", "BRISK", "!HMM", "NIGHT", "FIZZY", "DIZZY"] },
];

export function startWordleDemo(emit: (board: WordleBoard | null) => void): () => void {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

  void (async () => {
    for (let g = 0; !stopped; g++) {
      const { answer, inputs } = GAMES[g % GAMES.length] as (typeof GAMES)[number];
      const board: WordleBoard = { rows: [], maxGuesses: 6, state: "playing", answer: null, attempts: 0, rejected: null };
      emit({ ...board });
      for (const input of inputs) {
        await wait(5000);
        if (stopped) return;
        board.attempts += 1;
        if (input.startsWith("!")) {
          board.rejected = input.slice(1);
        } else {
          board.rejected = null;
          board.rows = [...board.rows, { word: input, marks: wordleMarks(input, answer) }];
          if (input === answer) board.state = "won";
          else if (board.rows.length >= board.maxGuesses) board.state = "lost";
          if (board.state !== "playing") board.answer = answer;
        }
        emit({ ...board, rows: [...board.rows] });
      }
      // The page takes a finished game away by itself after a while; the next one starts after.
      await wait(20_000);
    }
  })();

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}
