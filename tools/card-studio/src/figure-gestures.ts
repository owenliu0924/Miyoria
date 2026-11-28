// What her figure does in a conversation (docs/design/her-room.md §7.5, "對話中的反應"): a nod
// when the member says something, a thinking pose while she works out her reply, a small bounce
// when her bond with them goes up and a look away when it goes down. Each is a curve over time in
// the model's own rig units (degrees for the head, -1..1 for the eyes), added on top of the idle
// motion, breathing and the pointer by `figure-engine.ts`.
//
// Kept apart from the engine and free of Live2D's framework (which is not in git) so the curves can
// be tested on their own. Nothing here allocates: the engine passes one `Offsets` it owns and every
// curve adds into it.

/** A gesture of hers: `heard` the member's line, her bond went `up` or `down`. */
export type GestureKind = "heard" | "up" | "down";

/** What the gestures and poses add to her rig this frame. */
export interface Offsets {
  angleX: number;
  angleY: number;
  angleZ: number;
  bodyX: number;
  eyeX: number;
  eyeY: number;
}

export function zeroOffsets(o: Offsets): void {
  o.angleX = 0;
  o.angleY = 0;
  o.angleZ = 0;
  o.bodyX = 0;
  o.eyeX = 0;
  o.eyeY = 0;
}

/** Smoothstep: 0 at 0 and 1 at 1, flat at both ends, so nothing starts or stops with a jolt. */
export const ease = (t: number): number => {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
};

/** A bump from 0 up to 1 and back down over 0..1, flat at both ends. */
const bump = (u: number): number => {
  if (u <= 0 || u >= 1) return 0;
  const s = Math.sin(Math.PI * u);
  return s * s;
};

/** How long she keeps her eyes on the member after their line, overriding the pointer, s. */
export const HEARD_FOCUS_S = 1.5;
/** How long an earlier gesture takes to fade out when a later one takes its place, s. */
export const GESTURE_CROSSFADE_S = 0.3;
/** How long the thinking pose (and the look down at her work) takes to come and to go, s. */
export const POSE_FADE_S = 0.5;

// The nod: the head dips and comes back up.
const NOD_S = 0.6;
const NOD_DEG = 9;
// The happy bounce: a quick roll of the head that dies away, with the chin lifted a little.
const BOUNCE_S = 0.9;
const BOUNCE_ROLL_DEG = 4.5;
const BOUNCE_HZ = 2.4;
const BOUNCE_LIFT_DEG = 3.5;
// The look away: eased in, held, eased out.
const AWAY_IN_S = 0.4;
const AWAY_HOLD_S = 0.8;
const AWAY_OUT_S = 0.6;
const AWAY_TURN_DEG = 10;
const AWAY_DROOP_DEG = 8;
const AWAY_EYES_X = 0.5;
const AWAY_EYES_Y = 0.35;

/** How long a gesture lasts, s; after that it adds nothing. */
export function gestureLength(kind: GestureKind): number {
  if (kind === "heard") return NOD_S;
  if (kind === "up") return BOUNCE_S;
  return AWAY_IN_S + AWAY_HOLD_S + AWAY_OUT_S;
}

/** The look away's strength at `t` s: eased in, held, eased out. */
export function awayEnvelope(t: number): number {
  if (t <= 0) return 0;
  if (t < AWAY_IN_S) return ease(t / AWAY_IN_S);
  if (t < AWAY_IN_S + AWAY_HOLD_S) return 1;
  return 1 - ease((t - AWAY_IN_S - AWAY_HOLD_S) / AWAY_OUT_S);
}

/**
 * Adds `k` of `kind` at `t` s after it began into `out`. `side` (-1 or 1) is which way she turns
 * when she looks away.
 */
export function addGesture(
  out: Offsets,
  kind: GestureKind,
  t: number,
  side: number,
  k: number,
): void {
  if (k <= 0 || t <= 0 || t >= gestureLength(kind)) return;
  if (kind === "heard") {
    out.angleY -= NOD_DEG * bump(t / NOD_S) * k;
    return;
  }
  if (kind === "up") {
    const u = t / BOUNCE_S;
    // A short attack so the roll does not start at full speed, then it dies away by the end.
    const env = ease(t / 0.12) * (1 - u) * (1 - u);
    out.angleZ += BOUNCE_ROLL_DEG * Math.sin(2 * Math.PI * BOUNCE_HZ * t) * env * k;
    out.angleY += BOUNCE_LIFT_DEG * bump(u) * k;
    return;
  }
  const a = awayEnvelope(t) * k;
  out.angleX += side * AWAY_TURN_DEG * a;
  out.angleY -= AWAY_DROOP_DEG * a;
  out.eyeX += side * AWAY_EYES_X * a;
  out.eyeY -= AWAY_EYES_Y * a;
}

// The thinking pose: the head tilted, head and eyes drifted up and to one side, swaying slowly.
const THINK_TILT_DEG = 6;
const THINK_TURN_DEG = 6;
const THINK_UP_DEG = 5;
const THINK_EYES_X = 0.45;
const THINK_EYES_Y = 0.5;

/**
 * Adds `k` (0..1, already eased) of the thinking pose at `clock` s into `out`; `side` (-1 or 1)
 * is the side she looks to.
 */
export function addThinking(out: Offsets, clock: number, side: number, k: number): void {
  if (k <= 0) return;
  // Slow and small, periods that do not line up with each other or with her breathing.
  const swayZ = 1.2 * Math.sin((2 * Math.PI * clock) / 6.1);
  const swayX = 1.5 * Math.sin((2 * Math.PI * clock) / 8.3 + 1.1);
  const swayY = 0.8 * Math.sin((2 * Math.PI * clock) / 5.3 + 2.3);
  out.angleZ += (side * THINK_TILT_DEG + swayZ) * k;
  out.angleX += (side * THINK_TURN_DEG + swayX) * k;
  out.angleY += (THINK_UP_DEG + swayY) * k;
  out.eyeX += side * THINK_EYES_X * k;
  out.eyeY += THINK_EYES_Y * k;
}

/** A pose's weight `dt` s later on its way to `on` (1) or off (0), over `seconds`; linear, eased where used. */
export function stepWeight(w: number, on: boolean, dt: number, seconds: number): number {
  const step = dt / seconds;
  return on ? Math.min(1, w + step) : Math.max(0, w - step);
}
