// Her figure on the stage (docs/design/her-room.md §7.3): her Live2D model when the Core can serve
// it (`live2d.ts`), and nothing otherwise. The room never shows recorded video of her (the owner's
// word, 2026-11-28): while she loads, when she cannot be drawn, or when the Core serves no figure,
// the stage is the backdrop alone.

import type { RoomDoing, RoomFigureFace, RoomState } from "@miyoria/contracts/api";

/**
 * The pose names the page still tracks for her (they came from the recorded loops, which are gone;
 * `poseFor` and `show()` stay so the page does not have to change shape, and Live2D goes by `feel`).
 */
export type Pose = "heart" | "finger" | "sing" | "chest" | "glasses" | "basin" | "grass" | "still";

export interface HerFigure {
  mount(into: HTMLElement): void;
  show(pose: Pose): void;
  /** Her face and what she does (Live2D). */
  feel?(face: RoomFigureFace, doing: RoomDoing | "still"): void;
  /** Her line is being read out (a mouth for Live2D). */
  speaking(on: boolean): void;
  /** She is working out her reply (the thinking pose for Live2D). */
  thinking?(on: boolean): void;
  /**
   * Her line as much of it as is shown while it comes in, `null` once it is whole: with no voice
   * playing her mouth moves with the text.
   */
  mouthing?(shown: string | null): void;
  /** A gesture: `heard` the member's line, her bond went `up` or `down`. */
  react?(kind: FigureReaction): void;
  dispose(): void;
}

/** What she reacts to on the stage. */
export type FigureReaction = "heard" | "up" | "down";

/** One reaction for the figure; `n` is new on every one, so the same kind twice is two. */
export interface FigureCue {
  kind: FigureReaction;
  n: number;
}

/** What the page last saw of the member's line and her bond, and the cue it made of them. */
export interface CueSeen {
  heard: string | null;
  bond: string | null;
  cue: FigureCue | null;
}

/**
 * The cue after `seen`, given the member's line on the stage now (its key) and her bond's last
 * change: a new line of theirs is `heard`, a new bond change is `up` or `down` (it wins when both
 * are new). `seen` itself when nothing is new, so the page can tell.
 */
export function nextCue(
  seen: CueSeen,
  heard: string | null,
  bond: { id: string; sign: "plus" | "minus" } | null,
): CueSeen {
  const bondId = bond?.id ?? null;
  if (seen.heard === heard && seen.bond === bondId) return seen;
  const n = (seen.cue?.n ?? 0) + 1;
  let cue = seen.cue;
  if (bond !== null && bondId !== seen.bond) cue = { kind: bond.sign === "plus" ? "up" : "down", n };
  else if (heard !== null && heard !== seen.heard) cue = { kind: "heard", n };
  return { heard, bond: bondId, cue };
}

/** Her avatar's emotion names (`[emotion]` keys, and the mood words' English) by the pose for them. */
const FACES: Record<Exclude<Pose, "sing" | "still">, readonly string[]> = {
  heart: ["happy", "joy", "smile", "pride", "proud", "smug", "gratitude", "grateful", "love", "excited", "cheerful"],
  finger: ["angry", "anger", "annoyed", "disgust", "disgusted", "frustration", "frustrated", "pout", "jealousy", "jealous"],
  chest: ["shy", "embarrassed", "guilt", "guilty", "touched", "blush"],
  glasses: ["thinking", "think", "curious", "confused", "serious", "focus"],
  basin: ["sad", "sorrow", "lonely", "missing", "tired", "sleepy", "cry"],
  grass: ["surprise", "surprised", "fear", "scared", "worried", "calm", "relaxed", "neutral"],
};

const BY_FACE = new Map<string, Pose>();
for (const [pose, faces] of Object.entries(FACES)) for (const f of faces) BY_FACE.set(f, pose as Pose);

/** The pose for her state and face: singing → sing; joy / pride → heart; anger / disgust → finger; … */
export function poseFor(state: RoomState | null, face: string | null): Pose {
  if (!state?.open || state.doing === "offline") return "still";
  if (state.doing === "singing") return "sing";
  const f = face ?? state.mood?.face ?? null;
  if (f !== null) {
    const pose = BY_FACE.get(f.toLowerCase());
    if (pose) return pose;
  }
  if (state.doing === "working" || state.doing === "browsing") return "glasses";
  return "heart";
}

/** No figure: the stage stays the backdrop (the Core serves none, or the room has no Core). */
export function noFigure(): HerFigure {
  return {
    mount() {},
    show() {},
    speaking() {},
    dispose() {},
  };
}
