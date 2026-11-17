// What a service's `[[install.files]]` look like on this host: where each file goes (inside the
// model folder, never outside), whether it is there, the right size, and verified against its
// SHA-256. A verified hash is remembered with the file's size and modification time in
// `<state>/models.verified.json`, so a later check does not read gigabytes again unless asked to
// (`doctor --deep`).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type InstallFile, relativePathProblem, sourceLabel, sourceUrl } from "../descriptor.js";
import { fileSha256, formatBytes } from "./download.js";

/** `verified`: the checksum matches; `present`: there with the right size, not hashed this time. */
export type FileState = "verified" | "present" | "missing" | "wrong";

export interface FileStatus {
  path: string;
  /** Where it goes, absolute. */
  dest: string;
  state: FileState;
  /** The size the descriptor gives. */
  size: number;
  /** Bytes already in `<dest>.part`, which a download continues. */
  partBytes: number;
  sha256: string;
  what: string;
  licence: string;
  /** The URL it is downloaded from. */
  url: string;
  /** Where it comes from, for a person. */
  source: string;
  optional: boolean;
  /** For `wrong`: what does not match. */
  detail?: string;
}

/**
 * How hard to look: `quick` never reads a file (size, and the remembered hash); `cached` hashes a
 * file whose size or time changed since it was last hashed; `deep` hashes every file.
 */
export type CheckMode = "quick" | "cached" | "deep";

/** The file that remembers verified hashes: next to the model folder, not in it. */
export function verifiedCacheFile(stateRoot: string): string {
  return join(stateRoot, "models.verified.json");
}

/** Where a path of `install.files` goes. Throws when it would leave the model folder. */
export function fileDestIn(models: string, path: string): string {
  const problem = relativePathProblem(path);
  if (problem !== null) throw new Error(`${path} ${problem}`);
  const dest = resolve(models, path);
  const inside = relative(models, dest);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`${path} is not a path inside the model folder`);
  }
  return dest;
}

// ---- the remembered hashes ---------------------------------------------------------------------

interface CacheRecord {
  size: number;
  mtime_ms: number;
  sha256: string;
}

export class VerifiedCache {
  readonly #file: string;
  #records: Record<string, CacheRecord> = {};
  #dirty = false;

  constructor(file: string) {
    this.#file = file;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (data !== null && typeof data === "object" && "files" in data) {
        const files = (data as { files: unknown }).files;
        if (files !== null && typeof files === "object") {
          for (const [key, value] of Object.entries(files)) {
            const r = value as Partial<CacheRecord>;
            if (
              typeof r.size === "number" &&
              typeof r.mtime_ms === "number" &&
              typeof r.sha256 === "string"
            ) {
              this.#records[key] = { size: r.size, mtime_ms: r.mtime_ms, sha256: r.sha256 };
            }
          }
        }
      }
    } catch {
      // none yet, or unreadable: start empty
    }
  }

  /** The remembered hash of a file, when its size and time have not changed since. */
  get(key: string, size: number, mtimeMs: number): string | undefined {
    const r = this.#records[key];
    return r !== undefined && r.size === size && r.mtime_ms === mtimeMs ? r.sha256 : undefined;
  }

  set(key: string, size: number, mtimeMs: number, sha256: string): void {
    this.#records[key] = { size, mtime_ms: mtimeMs, sha256 };
    this.#dirty = true;
  }

  save(): void {
    if (!this.#dirty) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, files: this.#records }, null, 2)}\n`);
      renameSync(tmp, this.#file);
      this.#dirty = false;
    } catch {
      // A cache that cannot be written only means hashing again next time.
    }
  }
}

/** Hashes a file and remembers the hash with its size and time. */
export async function hashAndRemember(
  cache: VerifiedCache,
  key: string,
  file: string,
): Promise<string> {
  const before = statSync(file);
  const sha = await fileSha256(file);
  cache.set(key, before.size, before.mtimeMs, sha);
  return sha;
}

// ---- checking ----------------------------------------------------------------------------------

function base(file: InstallFile, models: string): Omit<FileStatus, "state"> {
  const dest = fileDestIn(models, file.path);
  const part = `${dest}.part`;
  return {
    path: file.path,
    dest,
    size: file.size,
    partBytes: existsSync(part) ? statSync(part).size : 0,
    sha256: file.sha256,
    what: file.what,
    licence: file.licence,
    url: sourceUrl(file),
    source: sourceLabel(file),
    optional: file.optional,
  };
}

/** The state of one file without reading it: missing, a wrong size, or what the cache knows. */
function quickState(
  file: InstallFile,
  status: Omit<FileStatus, "state">,
  cache: VerifiedCache,
): Pick<FileStatus, "state" | "detail"> & { hashable: boolean } {
  if (!existsSync(status.dest)) return { state: "missing", hashable: false };
  const stat = statSync(status.dest);
  if (!stat.isFile()) return { state: "wrong", detail: "不是檔案", hashable: false };
  if (stat.size !== file.size) {
    return {
      state: "wrong",
      detail: `大小是 ${stat.size} bytes,應該是 ${file.size} bytes`,
      hashable: false,
    };
  }
  const remembered = cache.get(file.path, stat.size, stat.mtimeMs);
  if (remembered === undefined) return { state: "present", hashable: true };
  return remembered === file.sha256
    ? { state: "verified", hashable: true }
    : { state: "wrong", detail: shaDetail(remembered, file.sha256), hashable: true };
}

function shaDetail(actual: string, expected: string): string {
  return `SHA-256 是 ${actual},應該是 ${expected}`;
}

/** The files of a descriptor without reading any of them (`quick`). */
export function checkFilesQuick(
  files: readonly InstallFile[],
  models: string,
  stateRoot: string,
): FileStatus[] {
  const cache = new VerifiedCache(verifiedCacheFile(stateRoot));
  return files.map((file) => {
    const status = base(file, models);
    const { hashable: _, ...quick } = quickState(file, status, cache);
    return { ...status, ...quick };
  });
}

/** The files of a descriptor, hashed as `mode` says; new hashes are remembered. */
export async function checkFiles(
  files: readonly InstallFile[],
  models: string,
  stateRoot: string,
  mode: CheckMode,
): Promise<FileStatus[]> {
  const cache = new VerifiedCache(verifiedCacheFile(stateRoot));
  const out: FileStatus[] = [];
  for (const file of files) {
    const status = base(file, models);
    const { hashable, ...quick } = quickState(file, status, cache);
    const hash = mode === "deep" ? hashable : mode === "cached" && quick.state === "present";
    if (!hash) {
      out.push({ ...status, ...quick });
      continue;
    }
    const sha = await hashAndRemember(cache, file.path, status.dest);
    out.push(
      sha === file.sha256
        ? { ...status, state: "verified" }
        : { ...status, state: "wrong", detail: shaDetail(sha, file.sha256) },
    );
  }
  cache.save();
  return out;
}

/**
 * The paths of the files a service cannot start without that are missing or the wrong size. Reads
 * no file: it runs before every start.
 */
export function missingRequiredFiles(files: readonly InstallFile[], models: string): string[] {
  return files
    .filter((file) => !file.optional)
    .filter((file) => {
      let dest: string;
      try {
        dest = fileDestIn(models, file.path);
      } catch {
        return true;
      }
      try {
        const stat = statSync(dest);
        return !stat.isFile() || stat.size !== file.size;
      } catch {
        return true;
      }
    })
    .map((file) => file.path);
}

// ---- free space --------------------------------------------------------------------------------

/** Kept free on the drive besides what a download needs. */
export const SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

/** Free bytes for this user on the drive of `dir` (or of its nearest existing parent); `null` when unknown. */
export function freeBytes(dir: string): number | null {
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  try {
    const s = statfsSync(current);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** The bytes still to download for these files (what a `.part` already holds is not counted). */
export function bytesToFetch(files: readonly FileStatus[]): number {
  return files.reduce((sum, f) => sum + Math.max(f.size - f.partBytes, 0), 0);
}

/** Why there is not room for `need` bytes in `dir`, or `null` when there is (or nobody can tell). */
export function spaceProblem(
  dir: string,
  need: number,
  free: (dir: string) => number | null = freeBytes,
): string | null {
  const available = free(dir);
  if (available === null || need === 0) return null;
  const margin = SPACE_MARGIN_BYTES;
  if (available >= need + margin) return null;
  return `磁碟空間不夠:要下載 ${formatBytes(need)},另外要留 ${formatBytes(margin)} 的餘裕,但 ${dir} 所在的磁碟只剩 ${formatBytes(available)}`;
}
