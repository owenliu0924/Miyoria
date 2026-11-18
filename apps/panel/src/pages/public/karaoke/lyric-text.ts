// The lyrics under the lane, reference.json version 2 (docs/design/karaoke.md 「做了什麼第二步」):
// how far each piece of an aligned line is sung, which readings a song has, and the viewer's own
// choices kept in this browser (the reading shown, the key of each song). No DOM here.

import type {
  WorkersKaraokeLineV2,
  WorkersKaraokeLyricsV2,
  WorkersKaraokePiece,
} from "@miyoria/contracts/workers/karaoke";
import { lyricAt } from "./lane";

/** What is shown above the words: nothing, the reading (furigana / pinyin), or romaji. */
export type ReadingMode = "off" | "reading" | "roman";

/** How far `piece` is sung at `t`, 0..1; `null` when it has no time (shown as the line is). */
export function pieceProgress(piece: WorkersKaraokePiece, t: number): number | null {
  if (piece.start === null || piece.end === null) return null;
  if (t <= piece.start) return 0;
  if (t >= piece.end) return 1;
  return (t - piece.start) / Math.max(0.001, piece.end - piece.start);
}

/**
 * Each piece's progress at `t` for a line that is aligned: an unsung piece (a space, a comma)
 * takes the state of the sung piece before it. `null` for a line without times.
 */
export function lineProgress(line: WorkersKaraokeLineV2, t: number): number[] | null {
  const pieces = line.pieces;
  if (!line.aligned || pieces === null) return null;
  let before = 0;
  return pieces.map((p) => {
    const at = pieceProgress(p, t);
    if (at === null) return before >= 1 ? 1 : 0;
    before = at;
    return at;
  });
}

/** Under reduced motion a piece lights whole as it begins, without the wipe. */
export function stepped(at: number): number {
  return at > 0 ? 1 : 0;
}

/**
 * The two lines on the stage at `t`: the line being sung (or, between lines, the one coming, not
 * yet lit) and the one after it. Indices into `lines`.
 */
export function stageLines<L extends { start: number; end: number | null }>(
  lines: readonly L[],
  t: number,
): { main: number | null; second: number | null } {
  const at = lyricAt(lines, t);
  if (at.current !== null) return { main: at.current, second: at.next };
  const main = at.next;
  const second = main !== null && main + 1 < lines.length ? main + 1 : null;
  return { main, second };
}

/**
 * When a line's singing ends: its last timed piece's end when it is aligned (a line's own `end` is
 * often the next line's start), else its `end`.
 */
export function sungEnd(line: Pick<WorkersKaraokeLineV2, "start" | "end" | "aligned" | "pieces">): number | null {
  if (line.aligned && line.pieces) {
    for (let i = line.pieces.length - 1; i >= 0; i--) {
      const end = line.pieces[i]?.end;
      if (end !== null && end !== undefined) return end;
    }
  }
  return line.end;
}

/** Dots before a line comes in after a rest. */
export const COUNTDOWN_DOTS = 4;

/**
 * How many dots are left before the next line starts (one a second, the last four seconds of a
 * rest of at least that long), or `null` when none show.
 */
export function countdown<L extends { start: number; end: number | null }>(lines: readonly L[], t: number): number | null {
  const at = lyricAt(lines, t);
  if (at.current !== null || at.next === null) return null;
  const next = lines[at.next] as L;
  const before = at.next > 0 ? (lines[at.next - 1] as L) : null;
  // Only after a real rest: a line right after another needs no counting in.
  const restFrom = before === null ? 0 : (before.end ?? before.start);
  if (next.start - restFrom < COUNTDOWN_DOTS) return null;
  const left = next.start - t;
  if (left <= 0 || left > COUNTDOWN_DOTS) return null;
  return Math.ceil(left);
}

/** The reading modes a song's lyrics have (besides `off`): what its pieces carry. */
export function readingModes(lyrics: WorkersKaraokeLyricsV2 | null): ReadingMode[] {
  const pieces = (lyrics?.lines ?? []).flatMap((l) => l.pieces ?? []);
  const out: ReadingMode[] = [];
  if (pieces.some((p) => p.reading !== null)) out.push("reading");
  if (pieces.some((p) => p.roman !== null)) out.push("roman");
  return out;
}

/** The words of a mode for this song's language: 假名 for Japanese, 拼音 for Chinese. */
export function readingLabel(mode: ReadingMode, language: string | null): string {
  if (mode === "off") return "不顯示";
  if (mode === "roman") return "羅馬字";
  return language === "zh" ? "拼音" : "假名";
}

/** What a piece shows above it in `mode`, or `null`. */
export function rubyOf(piece: WorkersKaraokePiece, mode: ReadingMode): string | null {
  if (mode === "reading") return piece.reading;
  if (mode === "roman") return piece.roman;
  return null;
}

/** A found line that did not match what was heard: shown with a light mark. */
export function isDoubtful(line: WorkersKaraokeLineV2): boolean {
  return line.source === "found" && (line.status === "uncertain" || line.status === "failed");
}

// ---- kept in this browser --------------------------------------------------------------------

type StorageGetter = () => Pick<Storage, "getItem" | "setItem">;
const local: StorageGetter = () => window.localStorage;

const READING_KEY = "miyoria.karaoke.reading";
const KEY_PREFIX = "miyoria.karaoke.key:";

export function loadReading(storage: StorageGetter = local): ReadingMode {
  try {
    const v = storage().getItem(READING_KEY);
    return v === "reading" || v === "roman" ? v : "off";
  } catch {
    return "off";
  }
}

export function saveReading(mode: ReadingMode, storage: StorageGetter = local): void {
  try {
    storage().setItem(READING_KEY, mode);
  } catch {
    // Not kept: this visit still shows it.
  }
}

/** The key last sung for `song`, `0` when none (-6..6). */
export function loadKey(song: string, max: number, storage: StorageGetter = local): number {
  try {
    const v = Number(storage().getItem(`${KEY_PREFIX}${song}`));
    return Number.isInteger(v) && Math.abs(v) <= max ? v : 0;
  } catch {
    return 0;
  }
}

export function saveKey(song: string, shift: number, storage: StorageGetter = local): void {
  try {
    storage().setItem(`${KEY_PREFIX}${song}`, String(shift));
  } catch {
    // Not kept.
  }
}

/** `原調`, `+2`, `−3`. */
export function keyLabel(shift: number): string {
  if (shift === 0) return "原調";
  return shift > 0 ? `+${shift}` : `−${Math.abs(shift)}`;
}
