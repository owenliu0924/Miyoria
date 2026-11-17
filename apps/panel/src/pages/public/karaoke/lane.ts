// The singing lane's geometry: time runs right to left past a "now" line at a quarter of the
// width, pitch runs bottom to top over the song's own range. No DOM here; `lane-draw.ts` paints.

/** Where "now" sits, as a share of the width from the left. */
export const NOW_AT = 0.25;
/** Seconds across the whole width. */
export const LANE_SECONDS = 8;
/** On a narrow screen. */
export const LANE_SECONDS_NARROW = 5;
/** Semitones kept above and below the song's range. */
export const RANGE_MARGIN = 3;
/** The smallest range shown, in semitones. */
export const RANGE_MIN = 14;

export interface LaneView {
  width: number;
  height: number;
  /** Song time at the now line. */
  now: number;
  /** Seconds across the width. */
  span: number;
  /** MIDI at the bottom and the top. */
  lo: number;
  hi: number;
}

export interface MidiRange {
  lo: number;
  hi: number;
}

export function timeToX(t: number, view: LaneView): number {
  return view.width * (NOW_AT + (t - view.now) / view.span);
}

export function midiToY(midi: number, view: LaneView): number {
  return view.height * (1 - (midi - view.lo) / (view.hi - view.lo));
}

/** The song times at the left and right edges. */
export function visibleWindow(view: LaneView): { from: number; to: number } {
  return { from: view.now - NOW_AT * view.span, to: view.now + (1 - NOW_AT) * view.span };
}

/** The notes that reach into the lane. */
export function visibleNotes<N extends { start: number; end: number }>(
  notes: readonly N[],
  view: LaneView,
): N[] {
  const { from, to } = visibleWindow(view);
  return notes.filter((n) => n.end >= from && n.start <= to);
}

function quantile(sorted: readonly number[], q: number): number {
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at] as number;
}

/**
 * The song's range with a margin: the voiced curve (its 2nd to 98th percentile, so a stray frame
 * does not squash the lane) and every note, at least `RANGE_MIN` semitones, whole semitones.
 */
export function midiRange(
  curve: readonly (number | null)[],
  notes: readonly { midi: number }[] = [],
): MidiRange {
  const voiced = curve.filter((m): m is number => m !== null && Number.isFinite(m));
  voiced.sort((a, b) => a - b);
  const lows: number[] = [];
  const highs: number[] = [];
  if (voiced.length > 0) {
    lows.push(quantile(voiced, 0.02));
    highs.push(quantile(voiced, 0.98));
  }
  for (const n of notes) {
    lows.push(n.midi);
    highs.push(n.midi);
  }
  if (lows.length === 0) return { lo: 60 - RANGE_MIN / 2, hi: 60 + RANGE_MIN / 2 };
  let lo = Math.floor(Math.min(...lows)) - RANGE_MARGIN;
  let hi = Math.ceil(Math.max(...highs)) + RANGE_MARGIN;
  if (hi - lo < RANGE_MIN) {
    const grow = RANGE_MIN - (hi - lo);
    lo -= Math.floor(grow / 2);
    hi += Math.ceil(grow / 2);
  }
  return { lo, hi };
}

/** The lyric line sung at `t` (the last that started) and the one after it. */
export function lyricAt<L extends { start: number; end: number | null }>(
  lines: readonly L[],
  t: number,
): { current: number | null; next: number | null } {
  let current: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as L).start <= t) current = i;
    else break;
  }
  if (current !== null) {
    const line = lines[current] as L;
    // A line that has ended long before the next one starts is not shown as being sung.
    if (line.end !== null && t > line.end + 1) {
      return { current: null, next: current + 1 < lines.length ? current + 1 : null };
    }
  }
  const next = current === null ? (lines.length > 0 ? 0 : null) : current + 1;
  return { current, next: next !== null && next < lines.length ? next : null };
}
