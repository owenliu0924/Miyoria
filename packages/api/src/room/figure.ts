// Her Live2D figure for the room's page (docs/design/her-room.md §7.3, "Live2D"): what the page needs
// to draw her in the member's browser, made ready once on this machine and served under
// `/api/member/room/figure/` to a member's session.
//
// Ready means: the card studio's figure build (`<studio>/dist/figure/figure.js`) and Live2D's Core
// (`<studio>/vendor/live2dcubismcore.min.js`) are there, and her model (`.model3.json`) and what it
// names can be read. Then the files the page loads are copied into `figure_cache`, named by their
// content's hash: the moc, the physics, the idle motion, the textures made smaller to each of
// `figure_textures` (WebP), the bundle and the Core, the large ones also compressed (Brotli,
// gzip). The page gets a manifest naming those copies and nothing else, so the routes serve only
// what is in it: never another file of the model's folder (VTube Studio's `.vtube.json` and its
// backups, the icon, the full-size textures), and never anything by a path a request names.
//
// The expressions are not files to the page: their parameters are read here and written into the
// manifest's faces (`figure-faces.ts`). Anything missing leaves the page on the recorded loops; it
// is said once in the log, as a warning when a model is set and something it needs is not there.

import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlib } from "node:zlib";
import { ROOM_FIGURE_PATH } from "@miyoria/contracts/api";
import sharp from "sharp";
import { ApiError } from "../errors.js";
import type { RoomConfig } from "./config.js";
import {
  type ExpressionFile,
  type FaceParam,
  FIGURE_FRAMING,
  resolveFaces,
  resolveRig,
} from "./figure-faces.js";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** The card studio's figure build and Live2D's Core, relative to the studio's folder. */
export const FIGURE_BUNDLE = "dist/figure/figure.js";
export const FIGURE_CORE = "vendor/live2dcubismcore.min.js";

/** What the page loads to draw her (the card studio's `FigureManifest`, `src/figure.ts`). */
export interface FigureManifest {
  version: 1;
  /** The bundle to `import()`; its `mount` draws her. */
  bundle: string;
  core: string;
  moc: string;
  physics: string | null;
  idle: string | null;
  /** Texture URLs by size, in the model's order. */
  textures: Record<string, string[]>;
  /** The sizes, smallest first. */
  sizes: number[];
  faces: Record<string, FaceParam[]>;
  rig: ReturnType<typeof resolveRig>;
  framing: { top: number; bottom: number };
}

/** One file the routes serve, from the cache folder. */
interface Served {
  path: string;
  type: string;
  bytes: number;
  br: string | null;
  gzip: string | null;
}

interface Ready {
  manifest: FigureManifest;
  text: string;
  version: string;
  files: Map<string, Served>;
}

export interface FigureLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface FigureOptions {
  config: Pick<RoomConfig, "figure" | "figure_textures">;
  /** The `.model3.json`, absolute; empty: none set. */
  model: string;
  /** The card studio's folder, absolute. */
  studio: string;
  /** Where the served copies are kept, absolute. */
  cache: string;
  log: FigureLog;
}

/** A file name the routes may serve: `<kind>-<hash>[-<size>].<ext>`, nothing else. */
const SERVED_NAME =
  /^(?:figure|core|moc|physics|idle|tex)-[0-9a-f]{20}(?:-\d{2,4})?\.(?:js|json|moc3|png|webp)$/;
/** A file of ours in the cache folder (anything else there is left alone). */
const OURS = /^(?:figure|core|moc|physics|idle|tex)-[0-9a-f]{20}/;

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** A copy stays a year in the browser: its name changes with its content. */
export const FIGURE_IMMUTABLE = "private, max-age=31536000, immutable";

/** The longest model file read whole as JSON. */
const JSON_MAX = 4 * 1024 * 1024;
/** How deep, and how many entries, the model's folder is looked through for expressions. */
const WALK_DEPTH = 3;
const WALK_MAX = 4000;

/** Why the figure cannot be drawn; `level`: how loud the log says it. */
export class FigureUnavailable extends Error {
  override readonly name = "FigureUnavailable";
  constructor(
    message: string,
    readonly level: "info" | "warn" = "warn",
  ) {
    super(message);
  }
}

async function hashOf(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex").slice(0, 20);
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    throw new FigureUnavailable(`${what} ${path} does not exist`);
  }
  if (!info.isFile() || info.size > JSON_MAX)
    throw new FigureUnavailable(`${what} ${path} is not a file to read`);
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, "")) as T;
  } catch {
    throw new FigureUnavailable(`${what} ${path} is not JSON`);
  }
}

/**
 * `rel` inside `base` (both real paths after links), with the extension `ext`; `null` for anything
 * else: a path that climbs out, a link that points out, another kind of file, nothing there.
 */
export async function insideFolder(
  base: string,
  rel: unknown,
  ext: string,
): Promise<string | null> {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) return null;
  if (!rel.toLowerCase().endsWith(ext)) return null;
  const root = await realpath(base).catch(() => null);
  if (root === null) return null;
  const joined = normalize(join(root, rel));
  if (!joined.startsWith(root + sep)) return null;
  const real = await realpath(joined).catch(() => null);
  if (real === null || !real.startsWith(root + sep)) return null;
  const info = await stat(real).catch(() => null);
  return info?.isFile() ? real : null;
}

/** The model's folder's files by name, for the kinds VTube Studio finds anywhere in it. */
async function folderIndex(root: string, exts: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let seen = 0;
  const walk = async (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > WALK_MAX) return;
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < WALK_DEPTH) await walk(path, depth + 1);
      else if (e.isFile() && exts.some((x) => e.name.toLowerCase().endsWith(x))) {
        if (!found.has(e.name)) found.set(e.name, path);
      }
    }
  };
  await walk(root, 0);
  return found;
}

interface Model3 {
  FileReferences?: {
    Moc?: unknown;
    Textures?: unknown;
    Physics?: unknown;
    DisplayInfo?: unknown;
    Motions?: Record<string, { File?: unknown }[]>;
  };
  Groups?: { Target?: unknown; Name?: unknown; Ids?: unknown }[];
}

interface VtubeJson {
  FileReferences?: { Model?: unknown; IdleAnimation?: unknown };
}

function group(model: Model3, name: string): string[] {
  const g = model.Groups?.find((x) => x.Name === name && x.Target === "Parameter");
  return Array.isArray(g?.Ids) ? g.Ids.filter((id): id is string => typeof id === "string") : [];
}

/** What a model is to the page, before anything is copied: its files, faces and rig. */
export interface ModelPlan {
  moc: string;
  textures: string[];
  physics: string | null;
  idle: string | null;
  faces: Record<string, FaceParam[]>;
  rig: ReturnType<typeof resolveRig>;
}

/**
 * Reads a `.model3.json` and what it names: the moc, the textures (PNG), the physics, the
 * display info (only for the parameters' names), the idle motion (the model's own `Idle` group, or
 * VTube Studio's `IdleAnimation` in the `.vtube.json` beside it) and the expressions the faces use
 * (by name, anywhere in the folder, as VTube Studio finds them). Only files inside the model's
 * folder, of the kind each reference must be.
 */
export async function planModel(modelPath: string): Promise<ModelPlan> {
  if (!modelPath.toLowerCase().endsWith(".model3.json")) {
    throw new FigureUnavailable(`the model ${modelPath} is not a .model3.json`);
  }
  const model = await readJson<Model3>(modelPath, "the model");
  const dir = dirname(modelPath);
  const refs = model.FileReferences ?? {};
  const moc = await insideFolder(dir, refs.Moc, ".moc3");
  if (moc === null)
    throw new FigureUnavailable(`the model's moc (${String(refs.Moc)}) cannot be read`);
  const names = Array.isArray(refs.Textures) ? refs.Textures : [];
  const textures: string[] = [];
  for (const t of names) {
    const path = await insideFolder(dir, t, ".png");
    if (path === null)
      throw new FigureUnavailable(`the model's texture ${String(t)} cannot be read`);
    textures.push(path);
  }
  if (textures.length === 0) throw new FigureUnavailable("the model names no textures");
  const physics =
    refs.Physics === undefined ? null : await insideFolder(dir, refs.Physics, ".physics3.json");

  let params: Set<string> | null = null;
  const cdi = await insideFolder(dir, refs.DisplayInfo, ".cdi3.json");
  if (cdi !== null) {
    const json = await readJson<{ Parameters?: { Id?: unknown }[] }>(cdi, "the display info").catch(
      () => null,
    );
    const ids = (json?.Parameters ?? [])
      .map((p) => p.Id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length > 0) params = new Set(ids);
  }

  const index = await folderIndex(dir, [".exp3.json", ".motion3.json"]);
  const byName = async (name: unknown, ext: string) => {
    if (typeof name !== "string" || name.includes("/") || name.includes("\\")) return null;
    const path = index.get(name);
    return path === undefined ? null : insideFolder(dir, path.slice(dir.length + 1), ext);
  };

  let idle: string | null = null;
  const idleRef = refs.Motions?.Idle?.[0]?.File;
  if (idleRef !== undefined) idle = await insideFolder(dir, idleRef, ".motion3.json");
  if (idle === null) {
    const stem = basename(modelPath).slice(0, -".model3.json".length);
    const vts = await insideFolder(dir, `${stem}.vtube.json`, ".vtube.json");
    if (vts !== null) {
      const json = await readJson<VtubeJson>(vts, "VTube Studio's settings").catch(() => null);
      if (json?.FileReferences?.Model === basename(modelPath)) {
        idle = await byName(json.FileReferences.IdleAnimation, ".motion3.json");
      }
    }
  }

  const faces = await resolveFaces(async (name) => {
    const path = await byName(name, ".exp3.json");
    return path === null ? null : readJson<ExpressionFile>(path, "an expression").catch(() => null);
  }, params);
  const rig = resolveRig(params, {
    blink: group(model, "EyeBlink"),
    mouth: group(model, "LipSync"),
  });
  return { moc, textures, physics, idle, faces, rig };
}

async function exists(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() === true && info.size > 0;
}

/** Writes `bytes` to `path` whole or not at all. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

/** Copies `source` into the cache as `name` (and compressed copies), once. */
async function copyIn(
  cache: string,
  source: string,
  name: string,
  compress: boolean,
): Promise<Served> {
  const path = join(cache, name);
  if (!(await exists(path))) await writeAtomic(path, await readFile(source));
  const bytes = (await stat(path)).size;
  let br: string | null = null;
  let gzip: string | null = null;
  if (compress) {
    br = `${path}.br`;
    gzip = `${path}.gz`;
    if (!(await exists(br)) || !(await exists(gzip))) {
      const data = await readFile(path);
      const quality = data.byteLength > 1024 * 1024 ? 9 : 11;
      await writeAtomic(
        br,
        await brotli(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: quality } }),
      );
      await writeAtomic(gzip, await gz(data, { level: 9 }));
    }
  }
  return { path, type: TYPES[extname(name)] ?? "application/octet-stream", bytes, br, gzip };
}

/** A texture's width and height. */
async function sizeOf(source: string): Promise<{ width: number; height: number }> {
  // Read whole, not by path: libvips would keep the model's file open in its cache.
  const meta = await sharp(await readFile(source), { limitInputPixels: false }).metadata();
  if (!meta.width || !meta.height)
    throw new FigureUnavailable(`the texture ${source} cannot be read`);
  return { width: meta.width, height: meta.height };
}

/**
 * A texture of the set whose largest is `size` px (every texture scaled by the same `size / full`,
 * so their detail stays even), as WebP, made once; the model's own PNG for the full-size set.
 */
async function textureIn(
  cache: string,
  source: string,
  hash: string,
  size: number,
  full: number,
): Promise<{ name: string; served: Served }> {
  if (size >= full) {
    const name = `tex-${hash}.png`;
    return { name, served: await copyIn(cache, source, name, false) };
  }
  const name = `tex-${hash}-${size}.webp`;
  const path = join(cache, name);
  if (!(await exists(path))) {
    const own = await sizeOf(source);
    const k = size / full;
    const out = await sharp(await readFile(source), { limitInputPixels: false })
      .resize(Math.max(1, Math.round(own.width * k)), Math.max(1, Math.round(own.height * k)), {
        kernel: "lanczos3",
      })
      .webp({ quality: 90, alphaQuality: 100, effort: 4 })
      .toBuffer();
    await writeAtomic(path, out);
  }
  const bytes = (await stat(path)).size;
  return { name, served: { path, type: "image/webp", bytes, br: null, gzip: null } };
}

const urlOf = (name: string) => `${ROOM_FIGURE_PATH}/${name}`;

/** Makes everything ready: the copies in `cache` and the manifest naming them. */
export async function prepareFigure(
  options: Omit<FigureOptions, "log" | "config"> & { sizes: readonly number[] },
): Promise<Ready> {
  const bundle = join(options.studio, FIGURE_BUNDLE);
  const core = join(options.studio, FIGURE_CORE);
  if (!(await exists(bundle))) {
    throw new FigureUnavailable(
      `the figure is not built (${bundle}; see tools/card-studio/vendor.md)`,
    );
  }
  if (!(await exists(core))) {
    throw new FigureUnavailable(
      `Live2D's Core is missing (${core}; see tools/card-studio/vendor.md)`,
    );
  }
  if (options.model === "") {
    throw new FigureUnavailable("no model is set ([modules.cards] portrait_model)", "info");
  }
  const plan = await planModel(options.model);
  const cache = options.cache;
  await mkdir(cache, { recursive: true });
  const files = new Map<string, Served>();
  const put = async (kind: string, source: string, ext: string, compress: boolean) => {
    const name = `${kind}-${await hashOf(source)}${ext}`;
    files.set(name, await copyIn(cache, source, name, compress));
    return urlOf(name);
  };
  const bundleUrl = await put("figure", bundle, ".js", true);
  const coreUrl = await put("core", core, ".js", true);
  const mocUrl = await put("moc", plan.moc, ".moc3", true);
  const physicsUrl =
    plan.physics === null ? null : await put("physics", plan.physics, ".json", true);
  const idleUrl = plan.idle === null ? null : await put("idle", plan.idle, ".json", true);
  const sizes = [...new Set(options.sizes)].sort((a, b) => a - b);
  const textures: Record<string, string[]> = {};
  const hashes = await Promise.all(plan.textures.map((t) => hashOf(t)));
  const own = await Promise.all(plan.textures.map((t) => sizeOf(t)));
  const full = Math.max(...own.map((d) => Math.max(d.width, d.height)));
  for (const size of sizes) {
    const urls: string[] = [];
    // One at a time: a 4096 px texture is 64 MB while it is made smaller.
    for (const [i, source] of plan.textures.entries()) {
      const { name, served } = await textureIn(cache, source, hashes[i] as string, size, full);
      files.set(name, served);
      urls.push(urlOf(name));
    }
    textures[String(size)] = urls;
  }
  const manifest: FigureManifest = {
    version: 1,
    bundle: bundleUrl,
    core: coreUrl,
    moc: mocUrl,
    physics: physicsUrl,
    idle: idleUrl,
    textures,
    sizes,
    faces: plan.faces,
    rig: plan.rig,
    framing: { ...FIGURE_FRAMING },
  };
  const text = JSON.stringify(manifest);
  const version = createHash("sha256").update(text).digest("hex").slice(0, 16);
  await sweep(cache, files);
  return { manifest, text, version, files };
}

/** Removes our copies the manifest no longer names (an older model, bundle or size). */
async function sweep(cache: string, keep: Map<string, Served>): Promise<void> {
  const kept = new Set<string>();
  for (const s of keep.values()) {
    for (const p of [s.path, s.br, s.gzip]) if (p !== null) kept.add(basename(p));
  }
  let names: string[];
  try {
    names = await readdir(cache);
  } catch {
    return;
  }
  for (const name of names) {
    if (OURS.test(name) && !kept.has(name))
      await rm(join(cache, name), { force: true }).catch(() => undefined);
  }
}

/** Which compressed copy to send for an `Accept-Encoding`. */
export function encodingFor(
  accept: string | undefined,
  file: Pick<Served, "br" | "gzip">,
): "br" | "gzip" | null {
  const wants = (name: string) =>
    (accept ?? "")
      .split(",")
      .map((s) => s.trim().split(";"))
      .some(
        ([n, ...q]) =>
          n?.trim().toLowerCase() === name && !q.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p)),
      );
  if (file.br !== null && wants("br")) return "br";
  if (file.gzip !== null && wants("gzip")) return "gzip";
  return null;
}

/** How often the sources are looked at again for a change (a rebuilt bundle, another model). */
const RECHECK_MS = 60_000;

/** Her figure for the room: made ready in the background, then served. */
export class RoomFigure {
  readonly #o: FigureOptions;
  #ready: Ready | null = null;
  #working: Promise<void> | null = null;
  #stamp = "";
  #checkedAt = 0;
  #said = "";

  constructor(options: FigureOptions) {
    this.#o = options;
  }

  /** Makes it ready now (again); resolves when done, never rejects. */
  prepare(): Promise<void> {
    if (this.#o.config.figure !== "live2d") return Promise.resolve();
    if (this.#working !== null) return this.#working;
    const work = (async () => {
      try {
        const stamp = await this.#stampNow();
        const ready = await prepareFigure({
          model: this.#o.model,
          studio: this.#o.studio,
          cache: this.#o.cache,
          sizes: this.#o.config.figure_textures,
        });
        this.#ready = ready;
        this.#stamp = stamp;
        const bytes = [...ready.files.values()].reduce((n, f) => n + f.bytes, 0);
        this.#say(
          "info",
          `her Live2D figure is ready for the room (${ready.manifest.sizes.join(", ")} px textures)`,
          {
            version: ready.version,
            cache_mb: Math.round(bytes / 1e5) / 10,
          },
        );
      } catch (error) {
        this.#ready = null;
        this.#stamp = await this.#stampNow().catch(() => "");
        const level = error instanceof FigureUnavailable ? error.level : "warn";
        const why = error instanceof Error ? error.message : String(error);
        this.#say(level, `the room shows her recorded loops: ${why}`, {});
      } finally {
        this.#checkedAt = Date.now();
        this.#working = null;
      }
    })();
    this.#working = work;
    return work;
  }

  /** The room state's `figure`: the manifest's URL with its version, or `null` (the loops). */
  state(): { manifest: string } | null {
    this.#recheck();
    const r = this.#ready;
    return r === null ? null : { manifest: `${ROOM_FIGURE_PATH}?v=${r.version}` };
  }

  /** `GET /api/member/room/figure`: the manifest, checked again each time (it is small). */
  manifest(ifNoneMatch: string | undefined): Response {
    const r = this.#ready;
    if (r === null) throw ApiError.notFound("her figure is not here");
    const etag = `"${r.version}"`;
    const headers = {
      etag,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    };
    if (ifNoneMatch?.split(",").some((t) => t.trim() === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(r.text, {
      status: 200,
      headers: { ...headers, "content-type": "application/json; charset=utf-8" },
    });
  }

  /** `GET /api/member/room/figure/{name}`: one of the manifest's files, or a 404. */
  async file(name: string, acceptEncoding: string | undefined): Promise<Response> {
    const served = SERVED_NAME.test(name) ? this.#ready?.files.get(name) : undefined;
    if (served === undefined) throw ApiError.notFound("no such file");
    const encoding = encodingFor(acceptEncoding, served);
    const path = encoding === "br" ? served.br : encoding === "gzip" ? served.gzip : served.path;
    let info: Stats;
    try {
      info = await stat(path as string);
    } catch {
      // The cache was emptied under it: make it again, and say so as missing for now.
      void this.prepare();
      throw ApiError.notFound("no such file");
    }
    const headers: Record<string, string> = {
      "content-type": served.type,
      "content-length": String(info.size),
      "cache-control": FIGURE_IMMUTABLE,
      "x-content-type-options": "nosniff",
    };
    if (served.br !== null || served.gzip !== null) headers.vary = "accept-encoding";
    if (encoding !== null) headers["content-encoding"] = encoding;
    const body = Readable.toWeb(createReadStream(path as string)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  }

  /** Sources changed since they were made ready (at most once a minute): ready them again. */
  #recheck(): void {
    if (this.#o.config.figure !== "live2d" || this.#working !== null) return;
    const now = Date.now();
    if (now - this.#checkedAt < RECHECK_MS) return;
    this.#checkedAt = now;
    void this.#stampNow()
      .then((stamp) => (stamp !== this.#stamp ? this.prepare() : undefined))
      .catch(() => undefined);
  }

  /** The sources' sizes and times: the bundle, the Core and the model's file. */
  async #stampNow(): Promise<string> {
    const paths = [
      join(this.#o.studio, FIGURE_BUNDLE),
      join(this.#o.studio, FIGURE_CORE),
      this.#o.model,
    ];
    const parts = await Promise.all(
      paths.map(async (p) => {
        const s = p === "" ? null : await stat(p).catch(() => null);
        return s === null ? "-" : `${s.size}:${s.mtimeMs}`;
      }),
    );
    return parts.join("|");
  }

  /** Says the figure's state, once per change of what is said. */
  #say(level: "info" | "warn", msg: string, extra: object): void {
    if (this.#said === msg) return;
    this.#said = msg;
    this.#o.log[level](extra, msg);
  }
}

/** The figure's options from the room's config and the cards' (`[modules.cards] portrait_*`). */
export function figureOptions(
  config: RoomConfig,
  cards: { model: string; studio: string },
  log: FigureLog,
  cwd = process.cwd(),
): FigureOptions {
  const model = config.figure_model !== "" ? config.figure_model : cards.model;
  return {
    config,
    model: model === "" ? "" : resolve(cwd, model),
    studio: resolve(cwd, cards.studio === "" ? "tools/card-studio" : cards.studio),
    cache: resolve(cwd, config.figure_cache),
    log,
  };
}
