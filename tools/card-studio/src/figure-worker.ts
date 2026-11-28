// Her figure's engine in a worker (docs/design/her-room.md §7.3, "Live2D"): the page hands its
// canvas over (`figure.ts`), and her frames are worked out and drawn here, so they keep the
// screen's pace while the page does its own work. A classic worker script (`figure-worker.js`):
// Cubism Core is a classic script that sets a global, which `importScripts` runs under the page's
// content security policy (no `eval`).

import {
  createEngine,
  type Engine,
  type EngineInit,
  type EngineStats,
  type Frame,
} from "./figure-engine";

/** What the page tells the worker. */
export type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; init: EngineInit }
  | { t: "mood"; v: string }
  | { t: "state"; v: string }
  | { t: "speak"; v: number }
  | { t: "look"; x: number | null; y?: number }
  | { t: "view"; width: number; height: number; frame: Frame }
  | { t: "reduced"; v: boolean }
  | { t: "hidden"; v: boolean };

/** What the worker tells the page. */
export type FromWorker =
  /** Sent once at the start: whether this thread can draw her at all. */
  | { t: "hello"; ok: boolean }
  | { t: "ready" }
  | { t: "error"; message: string }
  | { t: "stats"; v: EngineStats };

interface Scope {
  postMessage(message: FromWorker): void;
  importScripts(...urls: string[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  requestAnimationFrame?: unknown;
}

const scope = globalThis as unknown as Scope;

/** How often the page hears her frame rate, ms. */
const STATS_MS = 1000;

function capable(): boolean {
  try {
    if (typeof scope.requestAnimationFrame !== "function" || typeof OffscreenCanvas === "undefined")
      return false;
    const probe = new OffscreenCanvas(1, 1);
    return (probe.getContext("webgl2") ?? probe.getContext("webgl")) !== null;
  } catch {
    return false;
  }
}

let engine: Engine | null = null;
/** What arrived while she was loading, in order. */
const waiting: ToWorker[] = [];

function apply(e: Engine, m: ToWorker): void {
  if (m.t === "mood") e.setMood(m.v);
  else if (m.t === "state") e.setState(m.v);
  else if (m.t === "speak") e.speak(m.v);
  else if (m.t === "look") e.look(m.x, m.y);
  else if (m.t === "view") e.setView(m.width, m.height, m.frame);
  else if (m.t === "reduced") e.setReduced(m.v);
  else if (m.t === "hidden") e.setHidden(m.v);
}

scope.onmessage = (event) => {
  const m = event.data;
  if (m.t !== "init") {
    if (engine) apply(engine, m);
    else waiting.push(m);
    return;
  }
  createEngine(m.canvas, m.init, async (url) => scope.importScripts(url)).then(
    (e) => {
      engine = e;
      for (const w of waiting.splice(0)) apply(e, w);
      scope.postMessage({ t: "ready" });
      setInterval(() => scope.postMessage({ t: "stats", v: e.stats() }), STATS_MS);
    },
    (error: unknown) => {
      scope.postMessage({
        t: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
};

scope.postMessage({ t: "hello", ok: capable() });
