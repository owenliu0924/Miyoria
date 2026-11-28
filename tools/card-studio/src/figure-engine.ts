// Her Live2D figure's engine (docs/design/her-room.md §7.3, "Live2D"): the model, what moves her and
// the drawing, with Live2D's own Web Framework. Nothing here touches the page: it draws into the
// canvas it is given, which is the page's own canvas on the main thread (`figure.ts`) or that
// canvas handed over to a worker (`figure-worker.ts`), so that her frames do not wait on the page
// and the page does not wait on hers.
//
// What she does: the model's idle motion, breathing and a slow sway, blinking, physics (hair,
// skirt, tail), the eyes and head following the pointer gently, one face per mood made of the
// model's own expression files and a few parameters (faded into each other), and her mouth moving
// with her voice's level. In a conversation (`figure-gestures.ts`): a nod and a look at the member
// when they say something, a thinking pose while she works out her reply, a bounce or a look away
// when her bond with them moves. Reduced motion: a still pose that only blinks. The loop stops
// while the tab is hidden, and a lost WebGL context is rebuilt when the browser gives it back.

import { BreathParameterData, CubismBreath } from "../vendor/framework/src/effect/cubismbreath";
import { CubismEyeBlink } from "../vendor/framework/src/effect/cubismeyeblink";
import type { CubismIdHandle } from "../vendor/framework/src/id/cubismid";
import { CubismFramework, LogLevel, Option } from "../vendor/framework/src/live2dcubismframework";
import { CubismMatrix44 } from "../vendor/framework/src/math/cubismmatrix44";
import { CubismTargetPoint } from "../vendor/framework/src/math/cubismtargetpoint";
import { CubismUserModel } from "../vendor/framework/src/model/cubismusermodel";
import { CubismMotion } from "../vendor/framework/src/motion/cubismmotion";
import type { CubismMotionManager } from "../vendor/framework/src/motion/cubismmotionmanager";
import { CubismShaderManager_WebGL } from "../vendor/framework/src/rendering/cubismshader_webgl";
import { csmVector } from "../vendor/framework/src/type/csmvector";
import {
  addGesture,
  addThinking,
  ease,
  GESTURE_CROSSFADE_S,
  type GestureKind,
  gestureLength,
  HEARD_FOCUS_S,
  type Offsets,
  POSE_FADE_S,
  stepWeight,
  zeroOffsets,
} from "./figure-gestures";

export type { GestureKind } from "./figure-gestures";

// ---- what the Core hands over (`packages/api/src/room/figure.ts`, `FigureManifest`) ------------

/** One parameter of a face: `set` moves it toward `value`, `mul` scales it, `add` adds to it. */
export interface FaceParam {
  id: string;
  value: number;
  blend: "set" | "mul" | "add";
}

/** The manifest of her figure, as `GET /api/member/room/figure` answers it. */
export interface FigureManifest {
  version: 1;
  /** Cubism Core's script. */
  core: string;
  moc: string;
  physics: string | null;
  /** The model's idle motion, looped. */
  idle: string | null;
  /** The engine as a classic worker script (`figure-worker.ts`); `null`: the main thread only. */
  worker?: string | null;
  /** Texture URLs by their size (the longest side in pixels), in the model's order. */
  textures: Record<string, string[]>;
  /** Faces by name (`neutral`, `happy`, …): their parameters, expression files already read in. */
  faces: Record<string, FaceParam[]>;
  /** The model's parameters for what moves her. */
  rig: {
    angleX: string;
    angleY: string;
    angleZ: string;
    bodyX: string;
    eyeX: string;
    eyeY: string;
    breath: string;
    blink: string[];
    mouth: string[];
  };
  /** Her whole figure in model units (y up; the model's canvas is 2 high): crown and feet. */
  framing: { top: number; bottom: number };
}

/** How much of the canvas her whole figure fills, and where its top is (fractions of its height). */
export interface Frame {
  height: number;
  top: number;
}

/** What the engine starts with; the rest arrives through its setters. */
export interface EngineInit {
  manifest: FigureManifest;
  /** The texture size to load (a key of `manifest.textures`). */
  size: number;
  /** The mask buffers' side in pixels. */
  maskSize: number;
  /** The canvas's size in device pixels. */
  width: number;
  height: number;
  frame: Frame;
  /** Reduced motion: a still pose that blinks. */
  reduced: boolean;
  /** The tab is hidden: nothing is drawn until it shows again. */
  hidden: boolean;
  /** The part of the time between two frames her work may take (the rest is the page's). */
  share: number;
}

export interface EngineStats {
  /** What one frame costs (update and draw calls), ms, averaged. */
  frameMs: number;
  frames: number;
  /** Her frames in the last second. */
  fps: number;
}

export interface Engine {
  /** Her face: a key of `manifest.faces`; anything else is `neutral`. */
  setMood(face: string): void;
  /**
   * What she is doing (the room's `doing`, or `thinking` while she works out a reply): singing
   * sways more, working and browsing look down at her work, thinking takes the thinking pose.
   */
  setState(doing: string): void;
  /** A gesture: `heard` the member's line, her bond went `up` or `down`. Replaces the one before. */
  react(kind: GestureKind): void;
  /** Her voice's level now, 0..1 (0: the mouth closes). */
  speak(level: number): void;
  /** Where to look, -1..1 each way from her face (y up); `null`: look ahead again. */
  look(x: number | null, y?: number): void;
  /** The canvas's size in device pixels and the framing for it. */
  setView(width: number, height: number, frame: Frame): void;
  setReduced(reduced: boolean): void;
  setHidden(hidden: boolean): void;
  stats(): EngineStats;
  destroy(): void;
}

/** A canvas of the page or one handed over to a worker. */
export type EngineCanvas = HTMLCanvasElement | OffscreenCanvas;

// ---- the framework ------------------------------------------------------------------------------

let started = false;

function startFramework(): void {
  if (started) return;
  const option = new Option();
  option.logFunction = (m: string) => console.debug(m);
  option.loggingLevel = LogLevel.LogLevel_Error;
  // Core takes one log function for good (its table of them does not grow): a second copy of this
  // bundle on the page (another URL of it) starts without one.
  const core = globalThis.Live2DCubismCore as { Logging?: { csmGetLogFunction?: () => unknown } };
  const hasLog = typeof core?.Logging?.csmGetLogFunction?.() === "function";
  CubismFramework.startUp(hasLog ? undefined : option);
  CubismFramework.initialize();
  started = true;
}

declare global {
  // Cubism Core's global, set by its script.
  var Live2DCubismCore: unknown;
}

/**
 * Waits until Cubism Core answers: its WebAssembly is set up after its script has run, which a
 * worker's `importScripts` does not wait for.
 */
async function coreReady(): Promise<void> {
  const core = () =>
    globalThis.Live2DCubismCore as { Version?: { csmGetVersion?: () => number } } | undefined;
  for (let waited = 0; waited < 10_000; waited += 10) {
    try {
      if (typeof core()?.Version?.csmGetVersion?.() === "number") return;
    } catch {
      // Not set up yet.
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Cubism Core did not start");
}

async function bytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.arrayBuffer();
}

class Her extends CubismUserModel {
  get motions(): CubismMotionManager {
    return this._motionManager;
  }
  get physics() {
    return this._physics;
  }
}

/**
 * Mask buffers: each holds 32 masks when there are several, and her model has 49 clipped parts,
 * so two (at 2048 px, 32 MB of GPU memory; at 1024 px, 8 MB).
 */
const MASK_BUFFERS = 2;

/** The fastest she is drawn, frames a second: a 144 Hz screen draws her on every other frame. */
const MOST_FPS = 75;
/** The slowest she is drawn, ms between frames. */
const SLOWEST_MS = 50;

/**
 * Every how many of the screen's frames she is drawn: the fewest whose time her work (`cost` ms a
 * frame) fits in, `share` of it at most. Her frames then land on the screen's own, evenly spaced.
 * Going faster again takes a fifth of headroom, so a cost near a step does not flip between two
 * rates.
 */
export function divisorFor(
  cost: number,
  refreshMs: number,
  share: number,
  current: number,
): number {
  const least = Math.max(1, Math.round(1000 / MOST_FPS / refreshMs));
  const most = Math.max(least, Math.floor(SLOWEST_MS / refreshMs));
  const fits = (budget: number) => {
    let n = least;
    while (n < most && cost > budget * n * refreshMs) n += 1;
    return n;
  };
  const up = fits(share);
  if (up > current) return up;
  const down = fits(share * 0.8);
  return down < current ? down : Math.max(least, Math.min(current, most));
}

/** The screen's frame time from the last gaps between animation frames: the shortest, within reason. */
export function refreshFrom(gaps: readonly number[]): number {
  if (gaps.length < 5) return 1000 / 60;
  return Math.min(40, Math.max(4, Math.min(...gaps)));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How long one face takes to fade into the next, seconds. */
const FACE_FADE_S = 0.45;
/** Without a pointer for this long, she looks ahead again. */
const LOOK_IDLE_MS = 4000;

/**
 * Draws her into `canvas`. Resolves once she is drawn; rejects when anything is missing (WebGL,
 * Cubism Core, a file). `loadCore` runs Cubism Core's script (it sets a global) the way the
 * thread it is on can.
 */
export async function createEngine(
  canvas: EngineCanvas,
  init: EngineInit,
  loadCore: (url: string) => Promise<void>,
): Promise<Engine> {
  const m = init.manifest;
  const textureUrls = m.textures[String(init.size)];
  if (m.version !== 1 || !textureUrls) throw new Error("unknown figure manifest");
  const attrs: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    powerPreference: "default",
  };
  const gl = ((canvas as HTMLCanvasElement).getContext("webgl2", attrs) ??
    (canvas as HTMLCanvasElement).getContext("webgl", attrs)) as WebGLRenderingContext | null;
  if (!gl) throw new Error("no WebGL");
  const abort = new AbortController();
  const signal = abort.signal;

  await loadCore(m.core);
  await coreReady();
  startFramework();

  const [moc, physics, idle] = await Promise.all([
    bytes(m.moc, signal),
    m.physics ? bytes(m.physics, signal) : Promise.resolve(null),
    m.idle ? bytes(m.idle, signal) : Promise.resolve(null),
  ]);
  const her = new Her();
  her.loadModel(moc);
  if (!her.getModel()) throw new Error("the model would not load");
  if (physics) her.loadPhysics(physics, physics.byteLength);
  const model = her.getModel();
  const ids = CubismFramework.getIdManager();
  const id = (name: string): CubismIdHandle => ids.getId(name);

  const blink = CubismEyeBlink.create();
  const blinkIds = new csmVector<CubismIdHandle>();
  for (const b of m.rig.blink) blinkIds.pushBack(id(b));
  blink.setParameterIds(blinkIds);
  blink.setBlinkingInterval(4.2);

  const breath = CubismBreath.create();
  const breathParams = new csmVector<BreathParameterData>();
  const r = m.rig;
  breathParams.pushBack(new BreathParameterData(id(r.angleX), 0, 4, 6.5345, 0.5));
  breathParams.pushBack(new BreathParameterData(id(r.angleY), 0, 3, 3.5345, 0.5));
  breathParams.pushBack(new BreathParameterData(id(r.angleZ), 0, 4, 5.5345, 0.5));
  breathParams.pushBack(new BreathParameterData(id(r.bodyX), 0, 3, 15.5345, 0.5));
  breathParams.pushBack(new BreathParameterData(id(r.breath), 0.5, 0.5, 3.2345, 1));
  breath.setParameters(breathParams);

  let idleMotion: CubismMotion | null = null;
  if (idle) {
    idleMotion = CubismMotion.create(idle, idle.byteLength);
    if (idleMotion) {
      idleMotion.setLoop(true);
      idleMotion.setLoopFadeIn(false);
      idleMotion.setFadeInTime(0.5);
      // Its own eye and mouth curves (none here) would follow these groups; blinking and the
      // voice are done apart.
      idleMotion.setEffectIds(new csmVector<CubismIdHandle>(), new csmVector<CubismIdHandle>());
    }
  }

  // ---- WebGL: the renderer and the textures (again after a lost context) ----
  const maskSize = init.maskSize;
  const textures: WebGLTexture[] = [];

  async function upload(): Promise<void> {
    const g = gl as WebGLRenderingContext;
    her.createRenderer(MASK_BUFFERS);
    const renderer = her.getRenderer();
    // Before startUp: setting the size makes a new clipping manager, which startUp gives the context.
    renderer.setClippingMaskBufferSize(maskSize);
    renderer.startUp(g);
    renderer.setIsPremultipliedAlpha(true);
    const images = await Promise.all(
      (textureUrls as string[]).map(async (url) => {
        const res = await fetch(url, { credentials: "same-origin", signal });
        if (!res.ok) throw new Error(`${res.status}`);
        return createImageBitmap(await res.blob(), { premultiplyAlpha: "premultiply" });
      }),
    );
    images.forEach((image, i) => {
      const tex = g.createTexture() as WebGLTexture;
      g.bindTexture(g.TEXTURE_2D, tex);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, image);
      g.generateMipmap(g.TEXTURE_2D);
      g.bindTexture(g.TEXTURE_2D, null);
      image.close();
      textures[i] = tex;
      renderer.bindTexture(i, tex);
    });
  }

  function dropGl(): void {
    for (const t of textures) gl?.deleteTexture(t);
    textures.length = 0;
    her.deleteRenderer();
    CubismShaderManager_WebGL.deleteInstance();
  }

  await upload();

  // ---- what moves her ----
  // The rig's ids once: they are looked up by name otherwise, and these are used on every frame.
  const rig = {
    angleX: id(r.angleX),
    angleY: id(r.angleY),
    angleZ: id(r.angleZ),
    bodyX: id(r.bodyX),
    eyeX: id(r.eyeX),
    eyeY: id(r.eyeY),
    mouth: r.mouth.map(id),
  };
  const look = new CubismTargetPoint();
  let lookedAt = 0;
  /** Where the pointer asks her to look, kept while she looks at the member instead. */
  let wantX = 0;
  let wantY = 0;
  /** Her own time, s: it only runs while she is drawn, so a gesture never plays out unseen. */
  let clock = 0;
  /** She looks at the member (after their line) until this time on `clock`; 0: not. */
  let focusUntil = 0;
  // The gesture now and the one it replaced, which fades out under it.
  let gesture: GestureKind | null = null;
  let gestureAt = 0;
  let gestureSide = 1;
  let fading: GestureKind | null = null;
  let fadingAt = 0;
  let fadingSide = 1;
  let fadeFrom = 0;
  // The poses' weights (0..1, eased where they are used) and the side she thinks to.
  let thinkW = 0;
  let workW = 0;
  let thinkSide = 1;
  const offsets: Offsets = { angleX: 0, angleY: 0, angleZ: 0, bodyX: 0, eyeX: 0, eyeY: 0 };
  let mood = "neutral";
  let doing = "idle";
  const weights = new Map<string, number>([["neutral", 1]]);
  let level = 0;
  let mouth = 0;
  let frame = 0;
  let last = 0;
  let destroyed = false;
  let lost = false;
  let shown = false;
  let frames = 0;
  let frameMs = 0;
  let reducedNow = init.reduced;
  let hidden = init.hidden;
  let view = init.frame;
  /** Every how many of the screen's frames she is drawn, and what tells it. */
  let every = 0;
  let lastTick = 0;
  const gaps: number[] = [];
  const drawn: number[] = [];

  const faceOf = (name: string) => (m.faces[name] ? name : "neutral");

  function applyFaces(dt: number, reduced: boolean): void {
    const step = reduced ? 1 : dt / FACE_FADE_S;
    for (const [name, w] of weights) {
      const next = name === mood ? Math.min(1, w + step) : Math.max(0, w - step);
      if (next <= 0 && name !== mood) weights.delete(name);
      else weights.set(name, next);
    }
    if (!weights.has(mood)) weights.set(mood, reduced ? 1 : step);
    for (const [name, w] of weights) {
      const k = ease(w);
      for (const p of m.faces[name] ?? []) {
        const pid = id(p.id);
        if (p.blend === "add") model.addParameterValueById(pid, p.value, k);
        else if (p.blend === "mul") model.multiplyParameterValueById(pid, p.value, k);
        else {
          const v = model.getParameterValueById(pid);
          model.setParameterValueById(pid, v + (p.value - v) * k);
        }
      }
    }
  }

  function update(dt: number): void {
    const reduced = reducedNow;
    model.loadParameters();
    if (!reduced && idleMotion) {
      if (her.motions.isFinished()) her.motions.startMotionPriority(idleMotion, false, 1);
      her.motions.updateMotion(model, dt);
    }
    model.saveParameters();
    blink.updateParameters(model, dt);
    applyFaces(dt, reduced);
    if (!reduced) {
      clock += dt;
      if (lookedAt > 0 && performance.now() - lookedAt > LOOK_IDLE_MS) {
        wantX = 0;
        wantY = 0;
        lookedAt = 0;
        if (focusUntil === 0) look.set(0, 0);
      }
      if (focusUntil !== 0 && clock >= focusUntil) {
        // Back to the pointer; the target point eases there on its own.
        focusUntil = 0;
        look.set(wantX, wantY);
      }
      look.update(dt);
      const working = doing === "working" || doing === "browsing";
      workW = stepWeight(workW, working, dt, POSE_FADE_S);
      // A new spell of thinking looks to the other side from the last one, once the pose is gone.
      const thinking = doing === "thinking" && !working;
      if (thinking && thinkW === 0) thinkSide = -thinkSide;
      thinkW = stepWeight(thinkW, thinking, dt, POSE_FADE_S);
      const think = ease(thinkW);
      // While she thinks the pointer pulls on her less: her eyes are on the thought.
      const pull = 1 - 0.6 * think;
      const lx = look.getX() * pull;
      const ly = look.getY() * pull - 0.35 * ease(workW);
      zeroOffsets(offsets);
      addThinking(offsets, clock, thinkSide, think);
      if (gesture !== null) {
        const t = clock - gestureAt;
        if (t >= gestureLength(gesture)) gesture = null;
        else addGesture(offsets, gesture, t, gestureSide, 1);
      }
      if (fading !== null) {
        const f = (clock - fadeFrom) / GESTURE_CROSSFADE_S;
        const t = clock - fadingAt;
        if (f >= 1 || t >= gestureLength(fading)) fading = null;
        else addGesture(offsets, fading, t, fadingSide, 1 - ease(f));
      }
      model.addParameterValueById(rig.angleX, lx * 18 + offsets.angleX);
      model.addParameterValueById(rig.angleY, ly * 14 + offsets.angleY);
      model.addParameterValueById(rig.angleZ, lx * ly * -8 + offsets.angleZ);
      model.addParameterValueById(rig.bodyX, lx * 6 + offsets.bodyX);
      model.addParameterValueById(rig.eyeX, lx * 0.8 + offsets.eyeX);
      model.addParameterValueById(rig.eyeY, ly * 0.8 + offsets.eyeY);
      breath.updateParameters(model, doing === "singing" ? dt * 1.6 : dt);
      // The mouth follows the voice's level, opening fast and closing a little slower.
      const target = clamp(level, 0, 1);
      mouth += (target - mouth) * Math.min(1, dt * (target > mouth ? 30 : 14));
      if (mouth > 0.01) {
        for (const pid of rig.mouth) {
          model.setParameterValueById(pid, Math.max(model.getParameterValueById(pid), mouth));
        }
      }
    }
    her.physics?.evaluate(model, dt);
    model.update();
  }

  function draw(): void {
    const g = gl as WebGLRenderingContext;
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;
    const f = view;
    const span = m.framing.top - m.framing.bottom;
    // 2 model units span the canvas's height at zoom 1; her whole figure is `f.height` of it.
    const zoom = (2 * f.height) / span;
    const viewH = 2 / zoom;
    const centerY = m.framing.top + f.top * viewH - viewH / 2;
    const projection = new CubismMatrix44();
    projection.scale((zoom * h) / w, zoom);
    projection.translateRelative(0, -centerY);
    projection.multiplyByMatrix(her.getModelMatrix());
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, w, h);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    const renderer = her.getRenderer();
    renderer.setMvpMatrix(projection);
    renderer.setRenderState(null as unknown as WebGLFramebuffer, [0, 0, w, h]);
    renderer.drawModel();
  }

  function tick(now: number): void {
    frame = 0;
    if (destroyed || lost || hidden) return;
    // Her model is heavy (about 10 ms a frame on a desktop CPU, most of it Core's own update): she
    // is drawn on every frame of the screen her work fits in, on every second or third otherwise.
    if (lastTick !== 0) {
      gaps.push(now - lastTick);
      if (gaps.length > 20) gaps.shift();
    }
    lastTick = now;
    const refresh = refreshFrom(gaps);
    every = divisorFor(frameMs, refresh, init.share, every === 0 ? 1 : every);
    if (last !== 0 && now - last < (every - 0.5) * refresh) {
      schedule();
      return;
    }
    const dt = last === 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
    last = now;
    const t0 = performance.now();
    update(dt);
    draw();
    const spent = performance.now() - t0;
    frames += 1;
    frameMs += (spent - frameMs) / Math.min(frames, 60);
    drawn.push(now);
    while (drawn.length > 0 && now - (drawn[0] as number) > 1000) drawn.shift();
    schedule();
  }

  function schedule(): void {
    if (frame !== 0 || destroyed || lost || hidden) return;
    frame = requestAnimationFrame(tick);
  }

  function resize(width: number, height: number): void {
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    // A still figure (reduced motion, a hidden tab) is drawn again at the new size now.
    if (shown && !lost && !destroyed) draw();
  }

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    // Let go of what the lost context held now: deleting it after the context is back would touch
    // the new one's namespace (the browser warns of every such object).
    dropGl();
  };
  const onRestored = () => {
    upload().then(
      () => {
        lost = false;
        last = 0;
        lastTick = 0;
        schedule();
      },
      () => undefined,
    );
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  /** Ends any gesture at once (she is not being drawn) and gives the pointer back. */
  function dropGestures(): void {
    gesture = null;
    fading = null;
    if (focusUntil !== 0) {
      focusUntil = 0;
      look.set(wantX, wantY);
    }
  }

  // Physics settles before the first frame is shown: hair and skirt at rest, not falling into place.
  resize(init.width, init.height);
  for (let i = 0; i < 30; i++) update(1 / 30);
  draw();
  shown = true;
  schedule();

  return {
    setMood(face) {
      mood = faceOf(face);
    },
    setState(next) {
      doing = next;
    },
    react(kind) {
      // Nothing under reduced motion, and nothing saved up while she is not drawn.
      if (reducedNow || hidden || destroyed) return;
      if (kind !== "heard" && kind !== "up" && kind !== "down") return;
      // The gesture going on fades out under the new one instead of stopping dead.
      if (gesture !== null) {
        fading = gesture;
        fadingAt = gestureAt;
        fadingSide = gestureSide;
        fadeFrom = clock;
      }
      gesture = kind;
      gestureAt = clock;
      // Looking away: away from where she is looking now.
      gestureSide = look.getX() > 0 ? -1 : 1;
      if (kind === "heard") {
        focusUntil = clock + HEARD_FOCUS_S;
        look.set(0, 0);
      }
    },
    speak(n) {
      level = Number.isFinite(n) ? n : 0;
    },
    look(x, y) {
      if (x === null || y === undefined) {
        wantX = 0;
        wantY = 0;
        lookedAt = 0;
      } else {
        wantX = clamp(x, -1, 1);
        wantY = clamp(y, -1, 1);
        lookedAt = performance.now();
      }
      // While she looks at the member the pointer waits its turn.
      if (focusUntil === 0) look.set(wantX, wantY);
    },
    setView(width, height, next) {
      const moved = next.height !== view.height || next.top !== view.top;
      view = next;
      const same = canvas.width === width && canvas.height === height;
      resize(width, height);
      if (same && moved && shown && !lost && !destroyed) draw();
    },
    setReduced(next) {
      reducedNow = next;
      if (next) {
        // Her clock stands still under reduced motion: nothing is left half done for later.
        dropGestures();
      }
    },
    setHidden(next) {
      if (hidden === next) return;
      hidden = next;
      if (hidden) {
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
        // A gesture is of its moment: none is left to finish when she is shown again.
        dropGestures();
      } else {
        last = 0;
        lastTick = 0;
        gaps.length = 0;
        schedule();
      }
    },
    stats: () => ({ frameMs, frames, fps: drawn.length }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      if (frame !== 0) cancelAnimationFrame(frame);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      dropGl();
      her.release();
    },
  };
}
