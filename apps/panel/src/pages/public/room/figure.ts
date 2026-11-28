// Her figure on the stage (docs/design/her-room.md §7.3): her Live2D model when the Core can serve
// it (`live2d.ts`), and under it until she is drawn, or alone, the landing page's recorded loops
// (`landing/her/*.webm`, from the official free model by 神宫凉子), one per pose, switched by her
// state and her face; under reduced motion only their still posters.

import basinPoster from "../landing/her/basin.webp";
import basinLoop from "../landing/her/basin.webm";
import chestPoster from "../landing/her/chest.webp";
import chestLoop from "../landing/her/chest.webm";
import fingerPoster from "../landing/her/finger.webp";
import fingerLoop from "../landing/her/finger.webm";
import glassesPoster from "../landing/her/glasses.webp";
import glassesLoop from "../landing/her/glasses.webm";
import grassPoster from "../landing/her/grass.webp";
import grassLoop from "../landing/her/grass.webm";
import heartPoster from "../landing/her/heart.webp";
import heartLoop from "../landing/her/heart.webm";
import singPoster from "../landing/her/sing.webp";
import singLoop from "../landing/her/sing.webm";
import type { RoomDoing, RoomFigureFace, RoomState } from "@miyoria/contracts/api";

export type Pose = "heart" | "finger" | "sing" | "chest" | "glasses" | "basin" | "grass" | "still";

export interface HerFigure {
  mount(into: HTMLElement): void;
  show(pose: Pose): void;
  /** Her face and what she does (Live2D; the loops go by `show`). */
  feel?(face: RoomFigureFace, doing: RoomDoing | "still"): void;
  /** Her line is being read out (a mouth for Live2D; nothing for the loops). */
  speaking(on: boolean): void;
  dispose(): void;
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

export interface Loop {
  src: string;
  poster: string;
}

/** The recordings by pose; `still` is the first pose's poster without its loop. */
export const LOOPS: Record<Exclude<Pose, "still">, Loop> = {
  heart: { src: heartLoop, poster: heartPoster },
  finger: { src: fingerLoop, poster: fingerPoster },
  sing: { src: singLoop, poster: singPoster },
  chest: { src: chestLoop, poster: chestPoster },
  glasses: { src: glassesLoop, poster: glassesPoster },
  basin: { src: basinLoop, poster: basinPoster },
  grass: { src: grassLoop, poster: grassPoster },
};

/** How long the old pose fades before the new one takes its place, ms. */
export const SWAP_MS = 200;

/** The recorded loops as her figure. `reduced`: posters only, no swap fade. */
export function loopFigure(options: { reduced: () => boolean; loops?: typeof LOOPS }): HerFigure {
  const loops = options.loops ?? LOOPS;
  let video: HTMLVideoElement | null = null;
  let current: Pose | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const apply = (pose: Pose) => {
    const v = video;
    if (!v) return;
    const loop = pose === "still" ? loops.heart : loops[pose];
    v.poster = loop.poster;
    if (pose === "still" || options.reduced()) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } else {
      v.src = loop.src;
      // (Some players, and test DOMs, answer without a promise.)
      v.play()?.catch(() => undefined);
    }
    v.classList.remove("hr-swap");
  };

  return {
    mount(into) {
      const v = document.createElement("video");
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "auto";
      v.setAttribute("aria-hidden", "true");
      v.setAttribute("muted", "");
      v.setAttribute("playsinline", "");
      into.appendChild(v);
      video = v;
      if (current) apply(current);
    },
    show(pose) {
      if (pose === current) return;
      const first = current === null;
      current = pose;
      if (!video) return;
      clearTimeout(timer);
      if (first || options.reduced()) {
        apply(pose);
        return;
      }
      video.classList.add("hr-swap");
      timer = setTimeout(() => apply(pose), SWAP_MS);
    },
    speaking() {
      // The loops have no mouth to move.
    },
    dispose() {
      clearTimeout(timer);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.remove();
      }
      video = null;
    },
  };
}
