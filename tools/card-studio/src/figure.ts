// Her Live2D figure in a member's browser (docs/design/her-room.md §7.3, "Live2D"): the room's page
// loads this bundle from the Core (`/api/member/room/figure/...`) and draws her into its canvas with
// Live2D's own Web Framework. Built apart from the page (`scripts/build.mjs figure`) because the
// framework is not in git; Cubism Core is loaded here from the manifest's URL.
//
// What she does: the model's idle motion, breathing and a slow sway, blinking, physics (hair,
// skirt, tail), the eyes and head following the pointer gently, one face per mood made of the
// model's own expression files and a few parameters (faded into each other), and her mouth moving
// with her voice's level. Reduced motion: a still pose that only blinks. The loop stops while the
// tab is hidden, and a lost WebGL context is rebuilt when the browser gives it back.

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

export interface MountOptions {
  manifest: FigureManifest;
  /** The texture size to load (a key of `manifest.textures`). */
  size: number;
  /** Reduced motion: a still pose that blinks. Read again on every frame. */
  reduced: () => boolean;
  /** The framing for the canvas's size now. Read again on every resize. */
  frame: () => Frame;
  /** The most device pixels per CSS pixel to draw at. Default 2. */
  maxDpr?: number;
  /** The most pixels on the canvas's long side. Default 2560. */
  maxSide?: number;
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
  /** What one frame costs on the main thread (update and draw calls), ms, averaged. */
  stats(): { frameMs: number; frames: number };
  destroy(): void;
}

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

const coreLoads = new Map<string, Promise<void>>();

/** Loads Cubism Core's script once (it sets a global). */
function loadCore(url: string): Promise<void> {
  if (typeof globalThis.Live2DCubismCore !== "undefined") return Promise.resolve();
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

/** Milliseconds between her frames for a frame that costs `cost` ms on the main thread. */
export function intervalFor(cost: number): number {
  if (cost < 5) return 1000 / 60;
  if (cost < 14) return 1000 / 30;
  return 1000 / 20;
}

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How long one face takes to fade into the next, seconds. */
const FACE_FADE_S = 0.45;
/** Without a pointer for this long, she looks ahead again. */
const LOOK_IDLE_MS = 4000;

/**
 * Draws her into `canvas`. Resolves once she is drawn; rejects when anything is missing (WebGL,
 * Cubism Core, a file), leaving the canvas empty.
 */
export async function mount(canvas: HTMLCanvasElement, options: MountOptions): Promise<Figure> {
  const m = options.manifest;
  const textureUrls = m.textures[String(options.size)];
  if (m.version !== 1 || !textureUrls) throw new Error("unknown figure manifest");
  const attrs: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    powerPreference: "default",
  };
  const gl = (canvas.getContext("webgl2", attrs) ??
    canvas.getContext("webgl", attrs)) as WebGLRenderingContext | null;
  if (!gl) throw new Error("no WebGL");
  const abort = new AbortController();
  const signal = abort.signal;

  await loadCore(m.core);
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
  const maskSize = Math.max(canvas.clientWidth, canvas.clientHeight) > 900 ? 2048 : 1024;
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
  const look = new CubismTargetPoint();
  let lookedAt = 0;
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
    const reduced = options.reduced();
    model.loadParameters();
    if (!reduced && idleMotion) {
      if (her.motions.isFinished()) her.motions.startMotionPriority(idleMotion, false, 1);
      her.motions.updateMotion(model, dt);
    }
    model.saveParameters();
    blink.updateParameters(model, dt);
    applyFaces(dt, reduced);
    if (!reduced) {
      if (lookedAt > 0 && performance.now() - lookedAt > LOOK_IDLE_MS) {
        look.set(0, 0);
        lookedAt = 0;
      }
      look.update(dt);
      const lx = look.getX();
      const ly = look.getY() + (doing === "working" || doing === "browsing" ? -0.35 : 0);
      model.addParameterValueById(id(r.angleX), lx * 18);
      model.addParameterValueById(id(r.angleY), ly * 14);
      model.addParameterValueById(id(r.angleZ), lx * ly * -8);
      model.addParameterValueById(id(r.bodyX), lx * 6);
      model.addParameterValueById(id(r.eyeX), lx * 0.8);
      model.addParameterValueById(id(r.eyeY), ly * 0.8);
      breath.updateParameters(model, doing === "singing" ? dt * 1.6 : dt);
      // The mouth follows the voice's level, opening fast and closing a little slower.
      const target = clamp(level, 0, 1);
      mouth += (target - mouth) * Math.min(1, dt * (target > mouth ? 30 : 14));
      if (mouth > 0.01) {
        for (const mid of r.mouth) {
          const pid = id(mid);
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
    const f = options.frame();
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
    if (destroyed || lost) return;
    // Her model is heavy (Core's own update alone is about 6 ms a frame on a desktop CPU): she
    // moves at the rate this device keeps up with, 60, 30 or 20 frames a second, and the frames
    // between are left alone.
    if (last !== 0 && now - last < intervalFor(frameMs) - 2) {
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
    frameMs += (spent - frameMs) / Math.min(frames, 120);
    schedule();
  }

  function schedule(): void {
    if (frame !== 0 || destroyed || lost || document.hidden) return;
    frame = requestAnimationFrame(tick);
  }

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr ?? 2);
    let w = Math.round(canvas.clientWidth * dpr);
    let h = Math.round(canvas.clientHeight * dpr);
    const most = options.maxSide ?? 2560;
    const over = Math.max(w, h) / most;
    if (over > 1) {
      w = Math.round(w / over);
      h = Math.round(h / over);
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      // A still figure (reduced motion, a hidden tab) is drawn again at the new size now.
      if (shown && !lost && !destroyed) draw();
    }
  }

  const onVisible = () => {
    if (document.hidden) {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    } else {
      last = 0;
      schedule();
    }
  };
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
        schedule();
      },
      () => undefined,
    );
  };
  document.addEventListener("visibilitychange", onVisible);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  // Physics settles before the first frame is shown: hair and skirt at rest, not falling into place.
  resize();
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
    speak(n) {
      level = Number.isFinite(n) ? n : 0;
    },
    lookAt(x, y) {
      if (x === null || y === undefined) {
        look.set(0, 0);
        lookedAt = 0;
        return;
      }
      // Toward the point from her face (about a fifth of the way down her figure), gently.
      const box = canvas.getBoundingClientRect();
      const f = options.frame();
      const faceY = box.top + box.height * (f.top + f.height * 0.13);
      const faceX = box.left + box.width / 2;
      const reach = Math.max(240, Math.min(box.width, box.height) * 0.6);
      const dx = clamp((x - faceX) / reach, -1, 1);
      const dy = clamp((faceY - y) / reach, -1, 1);
      look.set(dx * 0.7, dy * 0.7);
      lookedAt = performance.now();
    },
    resize,
    stats: () => ({ frameMs, frames }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisible);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      dropGl();
      her.release();
    },
  };
}
