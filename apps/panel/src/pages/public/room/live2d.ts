// Her Live2D figure on the stage (docs/design/her-room.md §7.3, "Live2D"): when the Core says it can
// (`state.figure`), the page loads her figure's bundle from the Core after its first paint and
// draws her into a canvas, which fades in over the backdrop. Until then the stage shows the room
// without her. The bundle is not part of this app (Live2D's framework is not in git): it is fetched
// and imported at run time. If something goes wrong on the way (no WebGL, a file missing, the bundle
// refusing) the stage stays without her, without a word to the member: the room never shows recorded
// video of her (the owner's word, 2026-11-28).

import type { RoomDoing, RoomFigureFace, RoomState } from "@miyoria/contracts/api";
import type { FigureReaction, HerFigure } from "./figure";

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

/** Her avatar's emotion names and their kin (`[emotion]` keys) by face. */
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
 * Her face on the figure: singing and working first (what she does shows), then `thinking` while
 * she works out her reply, then her last line's face, then her mood's face, then the word of her
 * mood; `neutral` otherwise.
 */
export function faceFor(state: RoomState | null, face: string | null, thinking = false): RoomFigureFace {
  if (!state?.open || state.doing === "offline") return "neutral";
  if (state.doing === "singing") return "singing";
  if (state.doing === "working" || state.doing === "browsing") return "working";
  if (thinking) return "thinking";
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
  /** Missing from a bundle built before her reactions (the Core may serve one for a minute). */
  react?(kind: FigureReaction): void;
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

/** How much of the stage her whole figure fills, (`room.css`, `.hr-l2d`). */
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
  /** Runs `fn` once the page has painted; returns a cancel. */
  afterPaint?: (fn: () => void) => () => void;
}

/**
 * What the figure is told she is doing: `thinking` while she works out her reply, unless what she
 * does shows on its own (singing, her work, nothing at all).
 */
export function stateFor(doing: RoomDoing | "still", thinking: boolean): string {
  if (!thinking) return doing;
  return doing === "singing" || doing === "working" || doing === "browsing" || doing === "offline" || doing === "still"
    ? doing
    : "thinking";
}

// ---- her mouth with the text, when no voice plays ----------------------------------------------

/** A number in 0..1 from `n`, the same every time (an integer hash). */
function noise(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Syllable `n`'s beat, s: 130–190 ms, so about 5–8 a second. */
function beat(n: number): number {
  return 0.13 + 0.06 * noise(n);
}

/**
 * How long syllable `n` of the text mouth lasts, s: its beat, now and then (about one in eight) a
 * little longer, the way speech has small breaths in it.
 */
export function syllableLength(n: number): number {
  return beat(n) + (noise(n * 7 + 3) < 0.12 ? 0.08 : 0);
}

/**
 * The text mouth's level `t` s into syllable `n`: it opens to 0.35–0.75 and closes over the first
 * 62% of the beat, smoothly, and stays closed for the rest.
 */
export function textMouth(n: number, t: number): number {
  const open = 0.62 * beat(n);
  if (t <= 0 || t >= open) return 0;
  return (0.35 + 0.4 * noise(n + 101)) * Math.sin((Math.PI * t) / open);
}

/** Punctuation in newly shown text closes her mouth for a moment. */
const PAUSE_AT = /[，。、！？；：…,.!?;:~～—\n]/;
/** How long the mouth stays closed at punctuation, ms. */
export const TEXT_PAUSE_MS = 220;

/** How long she takes to fade in over the backdrop, ms (`room.css`, `.hr-live`); if she cannot be drawn the stage stays without her. */
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

/** Her figure as Live2D; if she cannot be drawn the stage stays without her. */
export function live2dFigure(options: Live2dOptions): HerFigure {
  let box: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let handle: FigureHandle | null = null;
  let cancelPaint: (() => void) | null = null;
  let speakFrame = 0;
  let observer: ResizeObserver | null = null;
  const abort = new AbortController();
  let face: RoomFigureFace = "neutral";
  let doing: RoomDoing | "still" = "idle";
  let talking = false;
  let thinkingNow = false;
  /** Her line as far as it is shown while it comes in; `null`: no text mouth. */
  let shownText: string | null = null;
  // The text mouth: the syllable it is on, when that began and until when the mouth stays shut
  // after punctuation (`performance.now()` ms).
  let syllable = 0;
  let syllableAt = 0;
  let quietUntil = 0;

  const onPointer = (e: PointerEvent) => handle?.lookAt(e.clientX, e.clientY);
  const onLeave = () => handle?.lookAt(null);

  const textLevel = (now: number): number => {
    if (now < quietUntil) {
      // The syllable starts again from closed once the pause is over.
      syllableAt = quietUntil;
      return 0;
    }
    // After a long gap (a hidden tab) it starts afresh instead of catching up.
    if (now - syllableAt > 1000) syllableAt = now;
    let length = syllableLength(syllable) * 1000;
    while (now - syllableAt >= length) {
      syllableAt += length;
      syllable += 1;
      length = syllableLength(syllable) * 1000;
    }
    return textMouth(syllable, (now - syllableAt) / 1000);
  };

  /** Her mouth moves: with her voice when it plays (it wins), with the text otherwise. */
  const mouthMoves = () => talking || shownText !== null;

  const pump = () => {
    speakFrame = 0;
    if (!handle) return;
    handle.speak(talking ? options.level() : shownText !== null ? textLevel(performance.now()) : 0);
    if (mouthMoves()) speakFrame = requestAnimationFrame(pump);
  };

  const mouthChanged = () => {
    if (mouthMoves()) {
      if (speakFrame === 0) pump();
      return;
    }
    if (speakFrame !== 0) cancelAnimationFrame(speakFrame);
    speakFrame = 0;
    handle?.speak(0);
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
    h.setState(stateFor(doing, thinkingNow));
    if (mouthMoves()) pump();
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => h.resize());
      observer.observe(c);
    }
    into.classList.add("hr-live");
  }

  return {
    mount(into) {
      box = into;
      cancelPaint = (options.afterPaint ?? defaultAfterPaint)(() => {
        cancelPaint = null;
        load().catch((error: unknown) => {
          if (abort.signal.aborted) return;
          // Quietly: she is not shown. Only a developer's console at the debug level hears why.
          console.debug("her Live2D figure did not load; she is not shown", error);
          fail();
        });
      });
    },
    show() {
      // Live2D goes by `feel`; the pose belonged to the recorded loops.
    },
    feel(next, now) {
      face = next;
      doing = now;
      handle?.setMood(next);
      handle?.setState(stateFor(now, thinkingNow));
    },
    speaking(on) {
      talking = on;
      mouthChanged();
    },
    thinking(on) {
      if (thinkingNow === on) return;
      thinkingNow = on;
      handle?.setState(stateFor(doing, on));
    },
    mouthing(next) {
      const before = shownText;
      shownText = next;
      if (next !== null) {
        const now = performance.now();
        if (before === null) {
          // A new run of text: a fresh syllable, from closed.
          syllable += 1;
          syllableAt = now;
          quietUntil = 0;
        } else if (PAUSE_AT.test(next.startsWith(before) ? next.slice(before.length) : next)) {
          quietUntil = now + TEXT_PAUSE_MS;
        }
      }
      mouthChanged();
    },
    react(kind) {
      // Only once she is drawn (a nod played late means nothing), and an older bundle has none.
      handle?.react?.(kind);
    },
    dispose() {
      abort.abort();
      cancelPaint?.();
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
      box = null;
    },
  };
}
