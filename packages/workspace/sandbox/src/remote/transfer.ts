// The person's folder travelling with a job (docs/design/v6-sandbox.md §4): in as a tar when the
// job opens, the changes on Core's side in before each exec, and what the program changed back
// out after it.
//
// What comes back is someone else's computer's word, so nothing of it is trusted: the tar is
// unpacked by `tar-io` (regular files and directories only, every path through
// `normalizeRelativePath`, no `..`, no absolute paths, nothing deeper than the workspace allows,
// the byte and file caps of the folder) into a staging directory beside the workspace, and only
// then moved in, file by file, with every component of the destination checked with `lstat` (no
// link is followed, nothing lands outside the folder, nothing of her own call reaches `people/`).
// The deletions it names go through the same checks. Then the workspace's own `enforce` runs, as
// after a local run.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLogger } from "@miyoria/runtime/kernel";
import { newId, type SandboxJob } from "@miyoria/types";
import { MAX_PATH_DEPTH, normalizeRelativePath, safeJoin } from "../paths.js";
import { PEOPLE_DIR, type WorkspaceScope } from "../people.js";
import { roomLeft } from "../sandbox.js";
import { extractTar, type PackedEntry, stampTrusted, TarError } from "../tar-io.js";
import { SandboxError } from "../types.js";
import type { PersistentWorkspace, Removed, WorkspaceLimits } from "../workspace-store.js";
import type { CountedWorkspace } from "../workspace-totals.js";

const log = getLogger("sandbox.transfer");
const MIB = 1024 * 1024;

/** A call's reach of the workspace: the whole (an owner), without `people/` (hers), one person's folder. */
export interface CallWorkspace {
  root: CountedWorkspace;
  scope: WorkspaceScope;
  /** The folder's name when `scope` is a person's. */
  folder: string | null;
  /** The caps of what the call reaches (a person's folder's own). */
  limits: WorkspaceLimits;
}

/** What a job's `/workspace` holds, as far as Core knows. */
export type Manifest = PackedEntry[];

/** What `RemoteJob` adds to `SandboxJob` for the folder to travel. */
export interface TransferJob extends SandboxJob {
  /** Largest folder one transfer takes, in bytes. */
  readonly maxTransferBytes: number;
  /**
   * Packs `dir` (only the files `only` names, when given) and uploads it into `target`;
   * `manifest` is what Core's side holds now (sent with the commit), `deleted` what to delete
   * there first. Resolves with what was packed.
   */
  uploadTree(
    target: "workspace" | "tools" | "ext" | "work",
    dir: string,
    options: {
      skip?: (relativePath: string) => boolean;
      only?: ReadonlySet<string>;
      replace: boolean;
      manifest?: Manifest;
      deleted?: readonly string[];
      limits: { maxFiles: number; maxBytes: number; maxFileBytes: number };
      signal?: AbortSignal;
    },
  ): Promise<{ entries: PackedEntry[]; skipped: { path: string; why: string }[]; bytes: number }>;
  /** Asks the computer what `/workspace` changed since the last sync; the tar of it, when any. */
  sync(signal?: AbortSignal): Promise<{
    changed: Manifest;
    deleted: string[];
    tar: { bytes: number; sha256: string; body: () => Promise<AsyncIterable<Uint8Array>> } | null;
    done(): Promise<void>;
  }>;
}

/** Whether `path` names `people` or is under it (any case: file systems that ignore it alias). */
function inPeople(path: string): boolean {
  return (path.split("/")[0] ?? "").toLowerCase() === PEOPLE_DIR;
}

/** Where a call's files are on Core's disk, and what of it stays out. */
interface Place {
  dir: string;
  skip: ((relativePath: string) => boolean) | undefined;
  /** What the call's files are checked as afterwards. */
  workspace: PersistentWorkspace;
}

async function placeOf(ws: CallWorkspace): Promise<Place> {
  if (ws.scope.kind === "person") {
    const sub = await ws.root.subdir(`${PEOPLE_DIR}/${ws.scope.folder}`, ws.limits);
    return { dir: sub.dir, skip: undefined, workspace: sub };
  }
  const dir = await ws.root.ensure();
  return {
    dir,
    skip: ws.scope.kind === "own" ? inPeople : undefined,
    workspace: ws.root,
  };
}

function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

async function hashFile(full: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * The regular files under `dir` (one `lstat` per entry; links and anything else are not files),
 * with their hashes: taken from `last` when the size and the time match, computed otherwise.
 */
export async function scanTree(
  dir: string,
  options: {
    skip?: ((relativePath: string) => boolean) | undefined;
    last?: Manifest;
    maxEntries: number;
  },
): Promise<{ entries: Manifest; truncated: boolean }> {
  const known = new Map((options.last ?? []).map((e) => [e.path, e]));
  const entries: Manifest = [];
  let seen = 0;
  let truncated = false;
  const walk = async (full: string, prefix: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(full)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (++seen > options.maxEntries) {
        truncated = true;
        return;
      }
      const path = prefix === "" ? name : `${prefix}/${name}`;
      try {
        if (normalizeRelativePath(path) !== path) continue;
      } catch {
        continue;
      }
      if (options.skip?.(path)) continue;
      const child = join(full, name);
      const stat = await lstat(child).catch(() => null);
      if (stat === null) continue;
      if (stat.isDirectory()) {
        if (depth < MAX_PATH_DEPTH) await walk(child, path, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const mtime = wholeSeconds(stat.mtimeMs);
      const before = known.get(path);
      const sha256 =
        before !== undefined &&
        stampTrusted(stat.size, before.size === stat.size && before.mtime_ms === mtime)
          ? before.sha256
          : await hashFile(child).catch(() => null);
      if (sha256 === null) continue;
      entries.push({ path, size: stat.size, sha256, mtime_ms: mtime });
    }
  };
  await walk(dir, "", 1);
  return { entries, truncated };
}

/** The upload caps of a call: its folder's, and no more than one transfer takes. */
function packLimits(job: TransferJob, ws: CallWorkspace) {
  return {
    maxFiles: ws.limits.maxFiles,
    maxBytes: Math.min(job.maxTransferBytes, ws.limits.maxBytes),
    maxFileBytes: ws.limits.maxFileBytes,
  };
}

function mb(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / MIB))} MB`;
}

/** The refusal of a folder over what one transfer takes (§10.3), in words she can pass on. */
async function tooLarge(job: TransferJob, place: Place, error: TarError): Promise<SandboxError> {
  const scanned = await scanTree(place.dir, { skip: place.skip, maxEntries: 1_000_000 }).catch(
    () => null,
  );
  const bytes = scanned?.entries.reduce((n, e) => n + e.size, 0) ?? 0;
  const what =
    error.code === "too_many_files"
      ? `這個資料夾的檔案太多了(${scanned?.entries.length ?? "很多"} 個)`
      : `這個資料夾太大了(${mb(bytes)}),一次最多送 ${mb(job.maxTransferBytes)} 進沙箱`;
  return new SandboxError(
    "too_large",
    `${what};先刪掉用不到的,或只把要用的檔案放到一個子資料夾。`,
    { cause: error },
  );
}

/** First upload of a job: the whole of the call's folder into `/workspace` (replacing it). */
export async function sendWorkspace(
  job: TransferJob,
  ws: CallWorkspace,
  signal?: AbortSignal,
): Promise<Manifest> {
  const place = await placeOf(ws);
  try {
    const sent = await job.uploadTree("workspace", place.dir, {
      ...(place.skip === undefined ? {} : { skip: place.skip }),
      replace: true,
      limits: packLimits(job, ws),
      ...(signal === undefined ? {} : { signal }),
    });
    return sent.entries;
  } catch (error) {
    if (error instanceof TarError && error.code !== "corrupt" && error.code !== "changed") {
      throw await tooLarge(job, place, error);
    }
    throw error;
  }
}

/** More deletions than fit in a header: the folder goes again whole instead. */
const MAX_DELETE_HEADER = 8 * 1024;

/** Before an exec: what changed on Core's side since `last` goes in first. */
export async function pushChanges(
  job: TransferJob,
  ws: CallWorkspace,
  last: Manifest,
  signal?: AbortSignal,
): Promise<Manifest> {
  const place = await placeOf(ws);
  const limits = packLimits(job, ws);
  const now = await scanTree(place.dir, {
    skip: place.skip,
    last,
    maxEntries: limits.maxFiles * 2 + 100,
  });
  const before = new Map(last.map((e) => [e.path, e]));
  const changed = now.entries.filter((e) => before.get(e.path)?.sha256 !== e.sha256);
  const current = new Set(now.entries.map((e) => e.path));
  const deleted = now.truncated ? [] : last.map((e) => e.path).filter((p) => !current.has(p));
  if (changed.length === 0 && deleted.length === 0) return last;
  if (now.truncated || JSON.stringify(deleted).length > MAX_DELETE_HEADER) {
    return sendWorkspace(job, ws, signal);
  }
  const only = new Set<string>();
  for (const e of changed) {
    const parts = e.path.split("/");
    for (let i = 1; i <= parts.length; i++) only.add(parts.slice(0, i).join("/"));
  }
  try {
    const sent = await job.uploadTree("workspace", place.dir, {
      ...(place.skip === undefined ? {} : { skip: place.skip }),
      only,
      replace: false,
      manifest: now.entries,
      deleted,
      limits,
      ...(signal === undefined ? {} : { signal }),
    });
    // What went in has the hashes of the bytes sent; the rest is as scanned.
    const sentBy = new Map(sent.entries.map((e) => [e.path, e]));
    return now.entries.map((e) => sentBy.get(e.path) ?? e);
  } catch (error) {
    if (error instanceof TarError && error.code !== "corrupt" && error.code !== "changed") {
      throw await tooLarge(job, place, error);
    }
    throw error;
  }
}

function stamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Whether Core's own copy of `path` changed since `last` (she wrote it during the exec). */
async function coreChanged(full: string, before: PackedEntry | undefined): Promise<boolean> {
  const stat = await lstat(full).catch(() => null);
  if (stat === null || !stat.isFile()) return false;
  if (before === undefined) return true;
  const same = stat.size === before.size && wholeSeconds(stat.mtimeMs) === before.mtime_ms;
  if (stampTrusted(stat.size, same)) return false;
  return (await hashFile(full).catch(() => "")) !== before.sha256;
}

/**
 * The destination of `path` under `dir`: every existing component a real directory (missing
 * ones made), never through a link. `null` when something is in the way.
 */
async function destination(dir: string, path: string): Promise<string | null> {
  const parts = path.split("/");
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = await lstat(current).catch(() => null);
    if (stat === null) {
      await mkdir(current).catch(() => undefined);
      // As `PersistentWorkspace` makes them: a container of the local backend writes in it too.
      await chmod(current, 0o777).catch(() => undefined);
      const made = await lstat(current).catch(() => null);
      if (made === null || !made.isDirectory()) return null;
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }
  return safeJoin(dir, path);
}

/** Bytes of `source` with their SHA-256 counted on the way; gzip found by its magic bytes. */
async function* counted(
  source: AsyncIterable<Uint8Array>,
  sink: { hash: ReturnType<typeof createHash>; bytes: number },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    sink.hash.update(chunk);
    sink.bytes += chunk.byteLength;
    yield chunk;
  }
}

async function peekGzip(
  source: AsyncIterable<Uint8Array>,
): Promise<{ gzip: boolean; stream: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  const head = first.done ? new Uint8Array(0) : first.value;
  const gzip = head.byteLength >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  async function* rest(): AsyncGenerator<Uint8Array> {
    if (head.byteLength > 0) yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  return { gzip, stream: rest() };
}

/**
 * After an exec: what the program changed in `/workspace` comes back into the call's folder,
 * then the folder is held to its caps (`enforce`, only what this exec changed goes first) and the
 * whole workspace's counts learn it. A file she changed on Core's side meanwhile is kept as
 * `<name>.conflict-<time>`; the program's version takes its place.
 */
export async function receiveWorkspace(
  job: TransferJob,
  ws: CallWorkspace,
  last: Manifest,
  signal?: AbortSignal,
): Promise<{ manifest: Manifest; removed: Removed[]; conflicts: string[] }> {
  const place = await placeOf(ws);
  const sync = await job.sync(signal);
  const known = new Map(last.map((e) => [e.path, e]));
  const conflicts: string[] = [];
  const before = await place.workspace.snapshot();
  const usage = await place.workspace.usage();
  const staging = join(dirname(ws.root.dir), "sandbox-incoming", newId().toLowerCase());
  try {
    if (sync.tar !== null) {
      await mkdir(staging, { recursive: true });
      const sink = { hash: createHash("sha256"), bytes: 0 };
      const { gzip, stream } = await peekGzip(counted(await sync.tar.body(), sink));
      let written: PackedEntry[] = [];
      try {
        written = (
          await extractTar(stream, staging, {
            gzip,
            limits: {
              maxFiles: ws.limits.maxFiles,
              maxBytes: ws.limits.maxBytes,
              maxFileBytes: ws.limits.maxFileBytes,
              maxDepth: MAX_PATH_DEPTH,
            },
          })
        ).written;
      } catch (error) {
        if (!(error instanceof TarError)) throw error;
        // Over the folder's caps as a whole: none of it is taken.
        log.warn({ job: job.id, err: error.message }, "the changes of a job were refused");
        written = [];
      }
      if (sink.hash.digest("hex") !== sync.tar.sha256 || sink.bytes !== sync.tar.bytes) {
        throw new SandboxError(
          "docker_failed",
          "the files that came back from the sandbox were damaged on the way",
        );
      }
      for (const entry of written) {
        if (place.skip?.(entry.path)) continue;
        const target = await destination(place.dir, entry.path);
        if (target === null) continue;
        const existing = await lstat(target).catch(() => null);
        if (existing !== null && !existing.isFile()) continue;
        if (existing !== null && (await coreChanged(target, known.get(entry.path)))) {
          const mine = await hashFile(target).catch(() => "");
          if (mine !== entry.sha256) {
            let moved = `${target}.conflict-${stamp(Date.now())}`;
            for (
              let n = 1;
              await lstat(moved).then(
                () => true,
                () => false,
              );
              n++
            ) {
              moved = `${target}.conflict-${stamp(Date.now())}-${n}`;
            }
            await rename(target, moved);
            conflicts.push(`${entry.path}${moved.slice(target.length)}`);
          }
        }
        await rename(safeJoin(staging, entry.path), target);
        known.set(entry.path, entry);
      }
    }
    for (const raw of sync.deleted) {
      let path: string;
      try {
        path = normalizeRelativePath(raw);
      } catch {
        continue;
      }
      if (place.skip?.(path)) continue;
      const target = await destination(place.dir, path).catch(() => null);
      if (target === null) continue;
      const stat = await lstat(target).catch(() => null);
      // She changed it on Core's side meanwhile: hers stays.
      if (stat?.isFile() === true && !(await coreChanged(target, known.get(path)))) {
        await unlink(target).catch(() => undefined);
      }
      known.delete(path);
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await sync.done().catch(() => undefined);
  }

  // As after a local run: the folder's own caps, and no more than the whole has left.
  let removed: Removed[] = [];
  const checked =
    ws.scope.kind === "person"
      ? await ws.root.subdir(
          `${PEOPLE_DIR}/${ws.scope.folder}`,
          roomLeft(ws.limits, usage, ws.root.limits, await ws.root.usage()),
        )
      : place.workspace;
  removed = await checked.enforce(before).catch((error: unknown) => {
    log.warn({ job: job.id, err: String(error) }, "could not check the workspace after a job");
    return [];
  });
  if (ws.scope.kind === "person") {
    const after = await checked.list().catch(() => null);
    if (after === null) ws.root.invalidate();
    else ws.root.replaceFolder(`${PEOPLE_DIR}/${ws.scope.folder}`, after.entries, after.truncated);
  } else ws.root.invalidate();
  return { manifest: [...known.values()], removed, conflicts };
}
