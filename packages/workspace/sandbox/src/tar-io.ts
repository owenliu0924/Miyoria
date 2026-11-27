// The one place that makes and opens the tar files a folder travels in between Core and a sandbox
// computer (docs/design/v6-sandbox.md §4). Both sides use it: whatever arrives is unpacked here,
// and nothing else unpacks a tar. Only regular files and directories exist on the way in or out;
// links, devices and anything else are left behind and named in `skipped`.

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";
import { normalizeRelativePath, pathKey, safeJoin } from "./paths.js";

/** A file in a tar: path relative to the folder, `/` between segments. */
export interface PackedEntry {
  path: string;
  size: number;
  sha256: string;
  mtime_ms: number;
}

export interface PackOptions {
  /**
   * Called with the relative path of every file and directory; `true` leaves it out (a directory
   * with everything below it). Left-out entries are the caller's choice, so they are not in
   * `skipped`.
   */
  skip?: (relativePath: string) => boolean;
  gzip?: boolean;
  limits: { maxFiles: number; maxBytes: number; maxFileBytes: number };
}

export interface ExtractOptions {
  gzip?: boolean;
  limits: { maxFiles: number; maxBytes: number; maxFileBytes: number; maxDepth: number };
  /**
   * What to do with a file that is already there: `replace` it (deleted first, then written with
   * `O_EXCL`), or move the old one to `<name>.conflict-<time>` and put the new one in its place
   * (listed in `conflicts`). Not given: `replace`.
   */
  onExisting?: (relativePath: string) => "replace" | "keep-as-conflict";
  /** The clock of the conflict names (epoch ms); tests set it. */
  now?: () => number;
}

/** What this file uses of a tar-stream entry: its streams are not Node's, and the types say they are. */
interface EntrySink {
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(error: Error): void;
  once(event: "drain", listener: () => void): void;
}

export type TarErrorCode = "too_many_files" | "too_large" | "corrupt" | "changed";

/** The tar as a whole cannot be used (over a limit, not a tar, or a file changed while it was read). */
export class TarError extends Error {
  override readonly name = "TarError";
  constructor(
    readonly code: TarErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Modes: nothing of the source's own permissions is carried. */
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
/** Room for the headers and padding on top of the content when the unpacked size is counted. */
const TAR_OVERHEAD_PER_ENTRY = 2048;
const TAR_OVERHEAD_BASE = 1024 * 1024;

interface Skipped {
  path: string;
  why: string;
}

/** A name from outside, safe to put in a message or a list: cut, and without control characters. */
function shown(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces
  return name.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
}

function whyOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // `invalid path \`x\`: why` -> `why`
  const at = message.lastIndexOf("`: ");
  return at >= 0 ? message.slice(at + 3) : message;
}

interface Planned {
  path: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

async function plan(
  root: string,
  options: PackOptions,
): Promise<{ items: Planned[]; skipped: Skipped[] }> {
  const { limits } = options;
  const items: Planned[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new TarError("corrupt", "not a directory");

  async function walk(relative: string): Promise<void> {
    const dir = relative === "" ? root : join(root, ...relative.split("/"));
    const names = (await readdir(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (options.skip?.(path) === true) continue;
      let normalized: string;
      try {
        normalized = normalizeRelativePath(path);
      } catch (error) {
        skipped.push({ path: shown(path), why: whyOf(error) });
        continue;
      }
      const info = await lstat(join(dir, name));
      if (info.isSymbolicLink()) {
        skipped.push({ path: shown(path), why: "link" });
        continue;
      }
      const isDir = info.isDirectory();
      if (!isDir && !info.isFile()) {
        skipped.push({ path: shown(path), why: "not a regular file" });
        continue;
      }
      const key = pathKey(normalized);
      if (seen.has(key)) {
        skipped.push({ path: shown(path), why: "same name as another file apart from case" });
        continue;
      }
      seen.add(key);
      if (isDir) {
        items.push({ path: normalized, dir: true, size: 0, mtimeMs: wholeSeconds(info.mtimeMs) });
        if (items.length > limits.maxFiles * 2) {
          throw new TarError("too_many_files", `more than ${limits.maxFiles * 2} entries`);
        }
        await walk(path);
        continue;
      }
      if (info.size > limits.maxFileBytes) {
        skipped.push({ path: shown(path), why: "file too large" });
        continue;
      }
      files += 1;
      bytes += info.size;
      if (files > limits.maxFiles) {
        throw new TarError("too_many_files", `more than ${limits.maxFiles} files`);
      }
      if (bytes > limits.maxBytes) {
        throw new TarError("too_large", `more than ${limits.maxBytes} bytes`);
      }
      items.push({
        path: normalized,
        dir: false,
        size: info.size,
        mtimeMs: wholeSeconds(info.mtimeMs),
      });
    }
  }

  await walk("");
  return { items, skipped };
}

/** Streams one file into a tar entry; its hash comes out with the entry. */
async function addFile(pack: tar.Pack, root: string, item: Planned): Promise<PackedEntry | null> {
  const full = join(root, ...item.path.split("/"));
  // Open without following a link that appeared since the walk, and trust the handle's own size.
  const handle = await open(full, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const changed = () =>
      new TarError("changed", `\`${shown(item.path)}\` changed while it was packed`);
    if (info.size !== item.size) throw changed();
    const hash = createHash("sha256");
    let read = 0;
    // tar-stream's streams are not Node's: they are driven by hand, and the entry's own callback
    // says when the pack has taken all of it.
    let entry: ReturnType<tar.Pack["entry"]> | null = null;
    const taken = new Promise<void>((resolve, reject) => {
      entry = pack.entry(
        {
          name: item.path,
          size: item.size,
          type: "file",
          mode: FILE_MODE,
          uid: 0,
          gid: 0,
          mtime: new Date(item.mtimeMs),
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const sink = entry as unknown as EntrySink;
    const feeding = (async () => {
      if (item.size > 0) {
        const source = handle.createReadStream({ start: 0, end: item.size - 1, autoClose: false });
        for await (const chunk of source) {
          const part = chunk as Buffer;
          read += part.length;
          hash.update(part);
          if (!sink.write(part)) await new Promise<void>((resolve) => sink.once("drain", resolve));
        }
      }
      if (read !== item.size) {
        const error = changed();
        sink.destroy(error);
        throw error;
      }
      sink.end();
    })();
    feeding.catch(() => {});
    await Promise.all([taken, feeding]);
    return {
      path: item.path,
      size: item.size,
      sha256: hash.digest("hex"),
      mtime_ms: item.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Walks `dir` (one `lstat` per entry, so a link is seen as a link) and writes what it holds as a
 * tar, handing the bytes out as they are made. Only regular files and directories go in, with
 * the same mode for every file and no owner. A path that `normalizeRelativePath` refuses, or that
 * is the same as another apart from case, or a file over `maxFileBytes`, stays out and is named in
 * `skipped`. Too many files or too many bytes in all fail the stream before it yields anything.
 * `done` resolves once the stream was read to the end: `bytes` and `sha256` are of what the
 * stream gave (the gzip, with `gzip`); `entries` lists the files.
 */
export function packTree(
  dir: string,
  options: PackOptions,
): {
  stream: AsyncIterable<Uint8Array>;
  done: Promise<{ entries: PackedEntry[]; skipped: Skipped[]; bytes: number; sha256: string }>;
} {
  let settle: {
    resolve: (value: Awaited<ReturnType<typeof packTree>["done"]>) => void;
    reject: (error: unknown) => void;
  };
  const done = new Promise<Awaited<ReturnType<typeof packTree>["done"]>>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller may only look at `stream`; its failure is then thrown there.
  done.catch(() => {});

  async function* stream(): AsyncGenerator<Uint8Array> {
    try {
      const planned = await plan(dir, options);
      const pack = tar.pack();
      const entries: PackedEntry[] = [];
      const produce = (async () => {
        for (const item of planned.items) {
          if (item.dir) {
            const entry = pack.entry({
              name: `${item.path}/`,
              type: "directory",
              mode: DIR_MODE,
              uid: 0,
              gid: 0,
              mtime: new Date(item.mtimeMs),
            });
            (entry as unknown as EntrySink).end();
            continue;
          }
          const packed = await addFile(pack, dir, item);
          if (packed === null) {
            planned.skipped.push({ path: shown(item.path), why: "not a regular file" });
          } else entries.push(packed);
        }
        pack.finalize();
      })();
      produce.catch((error) => pack.destroy(error as Error));

      const gzip = options.gzip === true ? createGzip({ level: 1 }) : null;
      let source = pack as unknown as Readable;
      if (gzip !== null) {
        pack.on("error", (error) => gzip.destroy(error));
        source = source.pipe(gzip);
      }
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of source) {
        const part = chunk as Buffer;
        hash.update(part);
        bytes += part.length;
        yield part;
      }
      await produce;
      settle.resolve({
        entries,
        skipped: planned.skipped,
        bytes,
        sha256: hash.digest("hex"),
      });
    } catch (error) {
      settle.reject(error);
      throw error;
    }
  }

  return { stream: stream(), done };
}

/** Counts what passes and fails when it is more than `limit`: the guard against a gzip bomb. */
function capped(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        callback(new TarError("too_large", `the tar holds more than ${limit} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Every existing part of `segments` below `root` must be a real directory; missing ones are made. */
async function ensureDirectory(
  root: string,
  segments: string[],
  known: Set<string>,
): Promise<string | null> {
  let current = root;
  let key = "";
  for (const segment of segments) {
    current = join(current, segment);
    key = key === "" ? segment : `${key}/${segment}`;
    if (known.has(key)) continue;
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) return info.isSymbolicLink() ? "link in the way" : "file in the way";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: DIR_MODE });
    }
    known.add(key);
  }
  return null;
}

function stamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * Unpacks a tar into `dir`, which has to exist. Only regular files and directories are taken;
 * the rest (links, devices, a path `normalizeRelativePath` refuses, deeper than `maxDepth`, a
 * file over `maxFileBytes`, the same name as another apart from case, something in the way) is
 * named in `skipped`. A leading `./` is accepted. Permissions in the tar are ignored (files are
 * 0644, directories 0755); the modification time is kept. Files are made with `O_EXCL` after any
 * old one was removed or moved aside (`onExisting`), and no existing link is followed. Over
 * `maxFiles` or `maxBytes`, or a tar that cannot be read, rejects with `TarError`.
 */
export async function extractTar(
  source: AsyncIterable<Uint8Array>,
  dir: string,
  options: ExtractOptions,
): Promise<{ written: PackedEntry[]; skipped: Skipped[]; conflicts: string[] }> {
  const { limits } = options;
  const now = options.now ?? Date.now;
  const written: PackedEntry[] = [];
  const skipped: Skipped[] = [];
  const conflicts: string[] = [];
  const seen = new Set<string>();
  const directories = new Set<string>();
  let files = 0;
  let bytes = 0;

  const extract = tar.extract();
  const input = Readable.from(source, { objectMode: false });
  const guard = capped(
    limits.maxBytes + limits.maxFiles * TAR_OVERHEAD_PER_ENTRY + TAR_OVERHEAD_BASE,
  );
  // tar-stream's streams are not Node's, so they are joined with `pipe` and a failure anywhere
  // destroys the extractor, which ends the loop below.
  let failure: { error: unknown } | null = null;
  const fail = (error: unknown) => {
    failure ??= { error };
    extract.destroy(error instanceof Error ? error : new Error(String(error)));
  };
  const stages: Readable[] = [input];
  if (options.gzip === true) stages.push(createGunzip());
  stages.push(guard);
  for (const stage of stages) stage.on("error", fail);
  extract.on("error", fail);
  for (let i = 1; i < stages.length; i++) {
    (stages[i - 1] as Readable).pipe(stages[i] as unknown as NodeJS.WritableStream);
  }
  (guard as Readable).pipe(extract as unknown as NodeJS.WritableStream);

  try {
    for await (const entry of extract) {
      const header = entry.header;
      let name = header.name;
      if (name.startsWith("./")) name = name.slice(2);
      if (name === "" || name === ".") {
        entry.resume();
        continue;
      }
      if (name.endsWith("/")) name = name.slice(0, -1);
      const isDirectory = header.type === "directory";
      const isFile = header.type === "file";
      if (!isDirectory && !isFile) {
        skipped.push({
          path: shown(name),
          why: header.type === "symlink" || header.type === "link" ? "link" : "not a regular file",
        });
        entry.resume();
        continue;
      }
      let path: string;
      try {
        path = normalizeRelativePath(name);
        if (path.split("/").length > limits.maxDepth) throw new Error("too deep");
      } catch (error) {
        skipped.push({ path: shown(name), why: whyOf(error) });
        entry.resume();
        continue;
      }
      const key = pathKey(path);
      if (seen.has(key)) {
        // A directory listed twice is harmless; a file with a name already used is not.
        if (!isDirectory) {
          skipped.push({ path: shown(path), why: "same name as another entry apart from case" });
        }
        entry.resume();
        continue;
      }
      seen.add(key);
      const segments = path.split("/");
      if (isDirectory) {
        const blocked = await ensureDirectory(dir, segments, directories);
        if (blocked !== null) skipped.push({ path: shown(path), why: blocked });
        entry.resume();
        continue;
      }

      const size = header.size ?? 0;
      if (size > limits.maxFileBytes) {
        skipped.push({ path: shown(path), why: "file too large" });
        entry.resume();
        continue;
      }
      files += 1;
      bytes += size;
      if (files > limits.maxFiles) {
        throw new TarError("too_many_files", `more than ${limits.maxFiles} files`);
      }
      if (bytes > limits.maxBytes) {
        throw new TarError("too_large", `more than ${limits.maxBytes} bytes`);
      }
      const blocked = await ensureDirectory(dir, segments.slice(0, -1), directories);
      if (blocked !== null) {
        skipped.push({ path: shown(path), why: blocked });
        entry.resume();
        continue;
      }

      const target = safeJoin(dir, path);
      let existing: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        existing = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing !== null) {
        if (existing.isDirectory()) {
          skipped.push({ path: shown(path), why: "a directory is in the way" });
          entry.resume();
          continue;
        }
        if (options.onExisting?.(path) === "keep-as-conflict") {
          const base = `${target}.conflict-${stamp(now())}`;
          let moved = base;
          for (let n = 1; ; n += 1) {
            try {
              await lstat(moved);
              moved = `${base}-${n}`;
            } catch {
              break;
            }
          }
          await rename(target, moved);
          conflicts.push(`${path}${moved.slice(target.length)}`);
        } else {
          await unlink(target);
        }
      }

      const hash = createHash("sha256");
      const handle = await open(target, "wx", FILE_MODE);
      try {
        for await (const chunk of entry) {
          const part = chunk as Buffer;
          hash.update(part);
          await handle.write(part);
        }
        const modified = header.mtime instanceof Date ? header.mtime.getTime() : Number.NaN;
        const mtimeMs = Number.isFinite(modified) && modified >= 0 ? modified : now();
        await handle.utimes(mtimeMs / 1000, mtimeMs / 1000);
        written.push({ path, size, sha256: hash.digest("hex"), mtime_ms: mtimeMs });
      } catch (error) {
        await handle.close();
        await unlink(target).catch(() => {});
        throw error;
      }
      await handle.close();
    }
  } catch (error) {
    if (error instanceof TarError) throw error;
    const cause = (failure as { error: unknown } | null)?.error ?? error;
    if (cause instanceof TarError) throw cause;
    throw new TarError("corrupt", "the tar cannot be read", { cause });
  }
  const broken = failure as { error: unknown } | null;
  if (broken !== null) {
    if (broken.error instanceof TarError) throw broken.error;
    throw new TarError("corrupt", "the tar cannot be read", { cause: broken.error });
  }
  return { written, skipped, conflicts };
}

/** A tar keeps whole seconds; the manifest says the same number the extracting side will see. */
function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}
