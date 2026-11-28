// Her Live2D figure on the stage (docs/design/her-room.md §7.3, "Live2D"): when the Core says it can
// (`state.figure`), the page loads her figure's bundle from the Core after its first paint and
// draws her into a canvas over the recorded loops, then fades the loops out. The bundle is not part
// of this app (Live2D's framework is not in git): it is fetched and imported at run time. Anything
// that goes wrong on the way (no WebGL, a file missing, the bundle refusing) leaves the loops where
// they are, without a word to the member.

import type { RoomDoing, RoomFigureFace, RoomState } from "@miyoria/contracts/api";
import { type HerFigure, loopFigure, type Pose } from "./figure";

/** The faces the Core describes (`ROOM_FIGURE_FACES`, written out: no zod in the page). */
export const FIGURE_FACES = [
  "neutral",
  "happy",
  "smug",
  "annoyed",
  "angry",
  "embarrassed",
  "sad",
  "surprised",
  "thinking",
  "working",
  "singing",
] as const satisfies readonly RoomFigureFace[];

/** Her avatar's emotion names and their kin (`[emotion]` keys, the loops' names) by face. */
const NAMES: Record<Exclude<RoomFigureFace, "working" | "singing" | "neutral">, readonly string[]> = {
  happy: ["happy", "joy", "smile", "gratitude", "grateful", "love", "excited", "cheerful", "touched"],
  smug: ["smug", "pride", "proud", "teasing", "playful"],
  annoyed: ["annoyed", "disgust", "disgusted", "frustration", "frustrated", "jealousy", "jealous", "pout"],
  angry: ["angry", "anger", "mad"],
  embarrassed: ["embarrassed", "shy", "blush", "guilt", "guilty", "flustered"],
  sad: ["sad", "sorrow", "lonely", "missing", "tired", "sleepy", "cry", "hurt"],
  surprised: ["surprised", "surprise", "fear", "scared", "worried", "shocked"],
  thinking: ["thinking", "think", "curious", "confused", "serious", "focus"],
};

/** Her mood's word (`MOOD_WORDS` in the Core) by face. */
const WORDS: Record<string, RoomFigureFace> = {
  開心: "happy",
  感激: "happy",
  得意: "smug",
  生氣: "angry",
  嫌棄: "annoyed",
  吃醋: "annoyed",
  不甘心: "annoyed",
  害羞: "embarrassed",
  不好意思: "embarrassed",
  有點難過: "sad",
  寂寞: "sad",
  想念: "sad",
  驚訝: "surprised",
  不安: "surprised",
  平靜: "neutral",
};

const BY_NAME = new Map<string, RoomFigureFace>();
for (const [face, names] of Object.entries(NAMES)) for (const n of names) BY_NAME.set(n, face as RoomFigureFace);

/**
 * Her face on the figure: singing and working first (what she does shows), then her last line's
 * face, then her mood's face, then the word of her mood; `neutral` otherwise.
 */
export function faceFor(state: RoomState | null, face: string | null): RoomFigureFace {
  if (!state?.open || state.doing === "offline") return "neutral";
  if (state.doing === "singing") return "singing";
  if (state.doing === "working" || state.doing === "browsing") return "working";
  for (const f of [face, state.mood?.face ?? null]) {
    const known = f === null ? undefined : BY_NAME.get(f.toLowerCase());
    if (known) return known;
  }
  return (state.mood && WORDS[state.mood.word]) ?? "neutral";
}

// ---- the bundle's API (the card studio's `src/figure.ts`) ---------------------------------------

/** What the page reads of the manifest; the rest is the bundle's. */
export interface FigureManifestHead {
  version: number;
  bundle: string;
  sizes: number[];
}

export interface FigureHandle {
  setMood(face: string): void;
  setState(doing: string): void;
  speak(level: number): void;
  lookAt(x: number | null, y?: number): void;
  resize(): void;
  destroy(): void;
}

export interface FigureModule {
  mount(
    canvas: HTMLCanvasElement,
    options: {
      manifest: unknown;
      size: number;
      reduced: () => boolean;
      frame: () => { height: number; top: number };
    },
  ): Promise<FigureHandle>;
}

/** How much of the stage her whole figure fills, as the loops do (`room.css`, `.hr-figure video`). */
export function frameFor(narrow: boolean): { height: number; top: number } {
  return narrow ? { height: 1.08, top: 0.01 } : { height: 1.36, top: 0.01 };
}

/**
 * The texture size for a stage: the smallest that is sharp at her figure's height in device
 * pixels, and no more than 1024 on a device that says it has little memory (under 4 GB). Her
 * model's largest texture is 8192 px, so 2048 is a quarter of it: about 52 MB of GPU memory, which
 * a phone holds, and visibly sharper than 1024 on one.
 */
export function pickSize(
  sizes: readonly number[],
  device: { figurePx: number; memoryGb: number | null },
): number {
  const sorted = [...sizes].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const small = device.memoryGb !== null && device.memoryGb < 4;
  const allowed = small ? sorted.filter((s) => s <= 1024) : sorted;
  const pool = allowed.length > 0 ? allowed : [sorted[0] as number];
  // A set is sharp for a figure about as tall (in device pixels) as its largest texture.
  return pool.find((s) => s >= device.figurePx) ?? (pool[pool.length - 1] as number);
}

export interface Live2dOptions {
  /** The manifest's URL (`state.figure.manifest`). */
  manifest: string;
  reduced: () => boolean;
  /** Her voice's level now, 0..1. */
  level: () => number;
  /** Tests: the manifest and the bundle without the network. */
  fetchManifest?: (url: string, signal: AbortSignal) => Promise<FigureManifestHead>;
  importBundle?: (url: string) => Promise<FigureModule>;
  /** Tests: the loops underneath. */
  loops?: () => HerFigure;
  /** Runs `fn` once the page has painted; returns a cancel. */
  afterPaint?: (fn: () => void) => () => void;
}

/** How long the loops take to fade out under her, ms (`room.css`, `.hr-live`). */
export const CROSSFADE_MS = 600;

const narrow = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 700px)").matches === true;

function defaultAfterPaint(fn: () => void): () => void {
  let idle = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raf = requestAnimationFrame(() => {
    timer = setTimeout(() => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
      if (w.requestIdleCallback) idle = w.requestIdleCallback(fn, { timeout: 1500 });
      else fn();
    }, 0);
  });
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    const w = window as Window & { cancelIdleCallback?: (id: number) => void };
    if (idle && w.cancelIdleCallback) w.cancelIdleCallback(idle);
  };
}

async function defaultManifest(url: string, signal: AbortSignal): Promise<FigureManifestHead> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as FigureManifestHead;
}

/** The bundle, from the Core at run time (never bundled into this app). */
const defaultImport = (url: string) => import(/* @vite-ignore */ url) as Promise<FigureModule>;

/** Her figure as Live2D over the loops, which stay until she is drawn (and for good if she is not). */
export function live2dFigure(options: Live2dOptions): HerFigure {
  const loops = (options.loops ?? (() => loopFigure({ reduced: options.reduced })))();
  let loopsGone = false;
  let box: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let handle: FigureHandle | null = null;
  let cancelPaint: (() => void) | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let speakFrame = 0;
  let observer: ResizeObserver | null = null;
  const abort = new AbortController();
  let face: RoomFigureFace = "neutral";
  let doing: RoomDoing | "still" = "idle";
  let talking = false;

  const onPointer = (e: PointerEvent) => handle?.lookAt(e.clientX, e.clientY);
  const onLeave = () => handle?.lookAt(null);

  const pump = () => {
    speakFrame = 0;
    if (!handle) return;
    handle.speak(talking ? options.level() : 0);
    if (talking) speakFrame = requestAnimationFrame(pump);
  };

  const fail = () => {
    canvas?.remove();
    canvas = null;
    box?.classList.remove("hr-live");
  };

  async function load(): Promise<void> {
    const into = box;
    if (!into || abort.signal.aborted) return;
    const manifest = await (options.fetchManifest ?? defaultManifest)(options.manifest, abort.signal);
    if (manifest.version !== 1 || typeof manifest.bundle !== "string" || !Array.isArray(manifest.sizes)) {
      throw new Error("unknown manifest");
    }
    const mod = await (options.importBundle ?? defaultImport)(manifest.bundle);
    if (abort.signal.aborted || typeof mod?.mount !== "function") return;
    const c = document.createElement("canvas");
    c.className = "hr-l2d";
    c.setAttribute("aria-hidden", "true");
    into.appendChild(c);
    canvas = c;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const frame = frameFor(narrow());
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const size = pickSize(manifest.sizes, {
      figurePx: into.clientHeight * dpr * frame.height,
      memoryGb: typeof memory === "number" ? memory : null,
    });
    const h = await mod.mount(c, {
      manifest,
      size,
      reduced: options.reduced,
      frame: () => frameFor(narrow()),
    });
    if (abort.signal.aborted) {
      h.destroy();
      return;
    }
    handle = h;
    h.setMood(face);
    h.setState(doing);
    if (talking) pump();
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => h.resize());
      observer.observe(c);
    }
    into.classList.add("hr-live");
    fadeTimer = setTimeout(() => {
      loopsGone = true;
      loops.dispose();
    }, CROSSFADE_MS + 100);
  }

  return {
    mount(into) {
      box = into;
      loops.mount(into);
      cancelPaint = (options.afterPaint ?? defaultAfterPaint)(() => {
        cancelPaint = null;
        load().catch((error: unknown) => {
          if (abort.signal.aborted) return;
          // Quietly: the loops stay. Only a developer's console at the debug level hears why.
          console.debug("her Live2D figure did not load; the loops stay", error);
          fail();
        });
      });
    },
    show(pose: Pose) {
      if (!loopsGone) loops.show(pose);
    },
    feel(next, now) {
      face = next;
      doing = now;
      handle?.setMood(next);
      handle?.setState(now);
    },
    speaking(on) {
      talking = on;
      if (on && speakFrame === 0) pump();
      if (!on) handle?.speak(0);
    },
    dispose() {
      abort.abort();
      cancelPaint?.();
      clearTimeout(fadeTimer);
      if (speakFrame !== 0) cancelAnimationFrame(speakFrame);
      observer?.disconnect();
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      handle?.destroy();
      handle = null;
      canvas?.remove();
      canvas = null;
      box?.classList.remove("hr-live");
      if (!loopsGone) loops.dispose();
      loopsGone = true;
      box = null;
    },
  };
}
