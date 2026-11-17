// Paints the singing lane on a canvas: the reference curve thin, the guide notes as bars, the now
// line, and the singer's line in the primary colour. Geometry from `lane.ts`.

import type { WorkersKaraokeNote } from "@miyoria/contracts/workers/karaoke";
import type { ReferenceCurve } from "@miyoria/play/karaoke/score";
import { type LaneView, midiToY, NOW_AT, timeToX, visibleNotes, visibleWindow } from "./lane";
import type { TrailPoint } from "./take";

export interface LaneColors {
  primary: string;
  curve: string;
  note: string;
  noteNear: string;
  grid: string;
  now: string;
  past: string;
}

/** The theme's colours, read once per canvas. */
export function laneColors(el: Element): LaneColors {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    primary: v("--primary", "#f29dc4"),
    curve: "rgba(255, 255, 255, 0.5)",
    note: "rgba(255, 255, 255, 0.14)",
    noteNear: "rgba(255, 255, 255, 0.26)",
    grid: v("--chart-grid", "rgba(255, 255, 255, 0.07)"),
    now: v("--line-strong", "rgba(255, 255, 255, 0.2)"),
    past: "rgba(4, 5, 10, 0.16)",
  };
}

export interface LaneFrame {
  view: LaneView;
  reference: ReferenceCurve;
  notes: readonly WorkersKaraokeNote[];
  trail: readonly TrailPoint[];
  colors: LaneColors;
  /** Device pixels per CSS pixel. */
  dpr: number;
}

const NOTE_MIN_H = 6;
const NOTE_MAX_H = 16;

export function drawLane(ctx: CanvasRenderingContext2D, f: LaneFrame): void {
  const { view, colors } = f;
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);

  // A hairline at every C, the octave's landmark.
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = Math.ceil(view.lo / 12) * 12; m <= view.hi; m += 12) {
    const y = Math.round(midiToY(m, view)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
  }
  ctx.stroke();

  // What has gone by sits a little darker.
  const nowX = view.width * NOW_AT;
  ctx.fillStyle = colors.past;
  ctx.fillRect(0, 0, nowX, view.height);

  // The guide notes, most of a semitone tall.
  const semitone = view.height / (view.hi - view.lo);
  const noteH = Math.max(NOTE_MIN_H, Math.min(NOTE_MAX_H, semitone * 0.75));
  for (const n of visibleNotes(f.notes, view)) {
    const x0 = timeToX(n.start, view);
    const x1 = timeToX(n.end, view);
    const y = midiToY(n.midi, view);
    const on = n.start <= view.now && n.end >= view.now;
    ctx.fillStyle = on ? colors.noteNear : colors.note;
    roundRect(ctx, x0, y - noteH / 2, Math.max(2, x1 - x0), noteH, 3);
  }

  // The reference curve.
  const { from, to } = visibleWindow(view);
  const ref = f.reference;
  const first = Math.max(0, Math.floor((from - ref.start) * ref.hz));
  const last = Math.min(ref.midi.length - 1, Math.ceil((to - ref.start) * ref.hz));
  ctx.strokeStyle = colors.curve;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let pen = false;
  for (let i = first; i <= last; i++) {
    const m = ref.midi[i];
    if (m === null || m === undefined) {
      pen = false;
      continue;
    }
    const x = timeToX(ref.start + i / ref.hz, view);
    const y = midiToY(m, view);
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();

  // The singer: a gap where they were silent or a step jumps more than a fifth.
  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  pen = false;
  let prev: number | null = null;
  for (const p of f.trail) {
    if (p.midi === null || p.t < from - 0.1) {
      pen = false;
      prev = null;
      continue;
    }
    const x = timeToX(p.t, view);
    const y = midiToY(Math.min(view.hi, Math.max(view.lo, p.midi)), view);
    if (pen && prev !== null && Math.abs(p.midi - prev) < 7) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
    prev = p.midi;
  }
  ctx.stroke();

  // Now.
  ctx.strokeStyle = colors.now;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(nowX) + 0.5, 0);
  ctx.lineTo(Math.round(nowX) + 0.5, view.height);
  ctx.stroke();
  const tip = f.trail.at(-1);
  if (tip && tip.midi !== null && view.now - tip.t < 0.25) {
    ctx.fillStyle = colors.primary;
    ctx.beginPath();
    const y = midiToY(Math.min(view.hi, Math.max(view.lo, tip.midi)), view);
    ctx.arc(timeToX(tip.t, view), y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  ctx.fill();
}
