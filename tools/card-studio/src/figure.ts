// Her Live2D figure in a member's browser (docs/design/her-room.md §7.3, "Live2D"): the room's page
// loads this bundle from the Core (`/api/member/room/figure/...`) and has her drawn into its canvas.
// Built apart from the page (`scripts/build.mjs figure`) because Live2D's framework is not in git.
//
// Her frames are worked out and drawn in a worker when the browser can (`figure-worker.ts`: the
// canvas is handed over to it), so she moves at the screen's pace whatever the page is doing, and
// on the main thread otherwise. This file is the page's side of both: the canvas's size, where the
// pointer is from her face, reduced motion, a hidden tab.

import {
  createEngine,
  type Engine,
  type EngineInit,
  type EngineStats,
  type FigureManifest,
  type Frame,
} from "./figure-engine";
import type { FromWorker, ToWorker } from "./figure-worker";

export type { FaceParam, FigureManifest, Frame } from "./figure-engine";
export { divisorFor, refreshFrom } from "./figure-engine";

export interface MountOptions {
  manifest: FigureManifest;
  /** The texture size to load (a key of `manifest.textures`). */
  size: number;
  /** Reduced motion: a still pose that blinks. Read again about once a second. */
  reduced: () => boolean;
  /** The framing for the canvas's size now. Read again on every resize. */
  frame: () => Frame;
  /** The most device pixels per CSS pixel to draw at. Default 2. */
  maxDpr?: number;
  /** The most pixels on the canvas's long side. Default 2560. */
  maxSide?: number;
  /** `false`: on the main thread even where a worker could. Default: a worker when it can. */
  worker?: boolean;
}

export interface Figure {
  /** Her face: a key of `manifest.faces`; anything else is `neutral`. */
  setMood(face: string): void;
  /** What she is doing (the room's `doing`): singing sways more, working looks down at her work. */
  setState(doing: string): void;
  /** Her voice's level now, 0..1 (0: the mouth closes). */
  speak(level: number): void;
  /** A point on the page (client pixels) to look toward; `null`: look ahead again. */
  lookAt(x: number | null, y?: number): void;
  /** The canvas's box changed. */
  resize(): void;
  /** Her frame rate and what a frame costs; `worker`: drawn off the main thread. */
  stats(): EngineStats & { worker: boolean };
  destroy(): void;
}

/** The part of a frame's time her work may take: the page needs the rest of the main thread. */
const SHARE_MAIN = 0.7;
const SHARE_WORKER = 0.9;
/** How long the worker has to say it can draw, and then to draw her, ms. */
const HELLO_MS = 4000;
const READY_MS = 30_000;
/** How often reduced motion and the framing are read again, ms. */
const WATCH_MS = 1000;

const coreLoads = new Map<string, Promise<void>>();

/** Loads Cubism Core's script once on the page (it sets a global). */
function loadCore(url: string): Promise<void> {
  if (typeof (globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore !== "undefined")
    return Promise.resolve();
  let p = coreLoads.get(url);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("cannot load Cubism Core"));
      document.head.appendChild(s);
    });
    p.catch(() => coreLoads.delete(url));
    coreLoads.set(url, p);
  }
  return p;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The canvas's size in device pixels for its box now. */
function sizeOf(
  canvas: HTMLCanvasElement,
  options: MountOptions,
): { width: number; height: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr ?? 2);
  let width = Math.round(canvas.clientWidth * dpr);
  let height = Math.round(canvas.clientHeight * dpr);
  const over = Math.max(width, height) / (options.maxSide ?? 2560);
  if (over > 1) {
    width = Math.round(width / over);
    height = Math.round(height / over);
  }
  return { width, height };
}

/** A worker that says it can draw her; `null` when there is none, it cannot, or it does not answer. */
function startWorker(url: string): Promise<Worker | null> {
  return new Promise((done) => {
    let worker: Worker;
    try {
      worker = new Worker(url, { name: "her-figure" });
    } catch {
      done(null);
      return;
    }
    const give = (w: Worker | null) => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      if (w === null) worker.terminate();
      done(w);
    };
    const timer = setTimeout(() => give(null), HELLO_MS);
    worker.onerror = () => give(null);
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      give(event.data.t === "hello" && event.data.ok ? worker : null);
    };
  });
}

/** The engine in `worker`, drawing into `canvas` (handed over for good), behind the engine's own API. */
function remoteEngine(
  worker: Worker,
  canvas: HTMLCanvasElement,
  init: EngineInit,
): Promise<Engine> {
  return new Promise((resolve, reject) => {
    let last: EngineStats = { frameMs: 0, frames: 0, fps: 0 };
    const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("her figure's worker did not answer"));
    }, READY_MS);
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error("her figure's worker stopped"));
    };
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const m = event.data;
      if (m.t === "stats") last = m.v;
      else if (m.t === "error") {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(m.message));
      } else if (m.t === "ready") {
        clearTimeout(timer);
        resolve({
          setMood: (v) => send({ t: "mood", v }),
          setState: (v) => send({ t: "state", v }),
          speak: (v) => send({ t: "speak", v }),
          look: (x, y) => send({ t: "look", x, y }),
          setView: (width, height, frame) => send({ t: "view", width, height, frame }),
          setReduced: (v) => send({ t: "reduced", v }),
          setHidden: (v) => send({ t: "hidden", v }),
          stats: () => last,
          // Her model, textures and context go with the thread.
          destroy: () => worker.terminate(),
        });
      }
    };
    const offscreen = canvas.transferControlToOffscreen();
    send({ t: "init", canvas: offscreen, init }, [offscreen]);
  });
}

/**
 * Draws her into `canvas`. Resolves once she is drawn; rejects when anything is missing (WebGL,
 * Cubism Core, a file), leaving the canvas empty.
 */
export async function mount(canvas: HTMLCanvasElement, options: MountOptions): Promise<Figure> {
  const m = options.manifest;
  const size0 = sizeOf(canvas, options);
  const init = (share: number): EngineInit => ({
    manifest: m,
    size: options.size,
    maskSize: Math.max(canvas.clientWidth, canvas.clientHeight) > 900 ? 2048 : 1024,
    width: size0.width,
    height: size0.height,
    frame: options.frame(),
    reduced: options.reduced(),
    hidden: document.hidden,
    share,
  });

  // A worker is asked first whether it can draw: the canvas cannot come back once handed over.
  const can =
    options.worker !== false &&
    typeof m.worker === "string" &&
    typeof Worker !== "undefined" &&
    typeof canvas.transferControlToOffscreen === "function";
  const worker = can ? await startWorker(m.worker as string) : null;
  const engine = worker
    ? await remoteEngine(worker, canvas, init(SHARE_WORKER))
    : await createEngine(canvas, init(SHARE_MAIN), loadCore);

  let destroyed = false;
  let reduced = options.reduced();
  let frame = options.frame();
  let lookFrame = 0;
  let lookTo: { x: number | null; y?: number } | null = null;

  const resize = () => {
    if (destroyed) return;
    const { width, height } = sizeOf(canvas, options);
    frame = options.frame();
    engine.setView(width, height, frame);
  };
  const onVisible = () => engine.setHidden(document.hidden);
  document.addEventListener("visibilitychange", onVisible);
  const watch = setInterval(() => {
    const now = options.reduced();
    if (now !== reduced) {
      reduced = now;
      engine.setReduced(now);
    }
    const f = options.frame();
    if (f.height !== frame.height || f.top !== frame.top) resize();
  }, WATCH_MS);
  // What changed while she was loading.
  engine.setHidden(document.hidden);
  resize();

  // The pointer moves more often than she is drawn: one look per frame of the page.
  const sendLook = () => {
    lookFrame = 0;
    const to = lookTo;
    lookTo = null;
    if (!to || destroyed) return;
    if (to.x === null || to.y === undefined) {
      engine.look(null);
      return;
    }
    // Toward the point from her face (about a fifth of the way down her figure), gently.
    const box = canvas.getBoundingClientRect();
    const faceY = box.top + box.height * (frame.top + frame.height * 0.13);
    const faceX = box.left + box.width / 2;
    const reach = Math.max(240, Math.min(box.width, box.height) * 0.6);
    const dx = clamp((to.x - faceX) / reach, -1, 1);
    const dy = clamp((faceY - to.y) / reach, -1, 1);
    engine.look(dx * 0.7, dy * 0.7);
  };

  return {
    setMood: (face) => engine.setMood(face),
    setState: (doing) => engine.setState(doing),
    speak: (level) => engine.speak(level),
    lookAt(x, y) {
      lookTo = { x, y };
      if (lookFrame === 0) lookFrame = requestAnimationFrame(sendLook);
    },
    resize,
    stats: () => ({ ...engine.stats(), worker: worker !== null }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(watch);
      if (lookFrame !== 0) cancelAnimationFrame(lookFrame);
      document.removeEventListener("visibilitychange", onVisible);
      engine.destroy();
    },
  };
}
