// Files into a job (docs/design/v6-sandbox.md §4.2): a tar in parts of at most 8 MiB, each checked
// against its own SHA-256 as it arrives, then the whole checked and unpacked by `tar-io` (the one
// place a tar is opened: regular files and directories only, every path through
// `normalizeRelativePath`, nothing written through a link). Unpacking into /work or /workspace
// happens while nothing of the program runs (`whileQuiet`).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestEntry, UploadCommit, UploadResult } from "@miyoria/contracts/workers";
import { normalizeRelativePath } from "../paths.js";
import { extractTar, TarError } from "../tar-io.js";
import { emptyDir, removeTree } from "./disk.js";
import type { Job } from "./jobs.js";
import { whileQuiet } from "./quiet.js";
import { MIB, requestHash, ServiceError } from "./util.js";

/** Largest part (the design's 8 MiB, with room). */
export const MAX_PART_BYTES = 16 * MIB;
/** Parts of one upload, and all bytes waiting in a job's `incoming/`. */
export const MAX_PARTS = 4096;
export const MAX_INCOMING_BYTES = 2048 * MIB;
/** Files of one upload, and how deep (two more than a path's eight for `people/<folder>/`). */
const MAX_FILES = 200_000;
const MAX_DEPTH = 10;
const SHA256 = /^[0-9a-f]{64}$/;

function partsDir(job: Job, upload: string): string {
  return join(job.dirs.incoming, upload);
}

async function incomingBytes(job: Job): Promise<number> {
  let total = 0;
  let uploads: string[] = [];
  try {
    uploads = await readdir(job.dirs.incoming);
  } catch {
    return 0;
  }
  for (const upload of uploads) {
    for (const part of await readdir(join(job.dirs.incoming, upload)).catch(() => [] as string[])) {
      total += (await lstat(join(job.dirs.incoming, upload, part)).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/** `PUT .../uploads/{upload}/parts/{n}` with header `x-sha256`. */
export async function putPart(
  job: Job,
  upload: string,
  n: number,
  data: Buffer,
  sha256: string | undefined,
): Promise<{ status: 200 | 201; result: { n: number; bytes: number; sha256: string } }> {
  if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS) {
    throw new ServiceError("bad_request", `part number from 0 to ${MAX_PARTS - 1}`);
  }
  if (sha256 === undefined || !SHA256.test(sha256)) {
    throw new ServiceError("bad_request", "x-sha256 must be the part's SHA-256 in hex");
  }
  if (data.length > MAX_PART_BYTES) throw new ServiceError("too_large", "a part is at most 16 MiB");
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== sha256)
    throw new ServiceError("bad_request", "the part does not match its x-sha256");
  if (job.uploads.has(upload))
    throw new ServiceError("conflict", "this upload is already committed");
  const dir = partsDir(job, upload);
  const file = join(dir, String(n));
  const existing = await lstat(file).catch(() => null);
  if (existing !== null) {
    // A resent part: the same bytes are fine, others are not.
    const known = await fileHash(file);
    if (known !== sha256) throw new ServiceError("conflict", `part ${n} was sent with other bytes`);
    job.touch();
    return { status: 200, result: { n, bytes: data.length, sha256 } };
  }
  if ((await incomingBytes(job)) + data.length > MAX_INCOMING_BYTES) {
    throw new ServiceError("too_large", "too much is waiting to be unpacked in this job");
  }
  await mkdir(dir, { recursive: true });
  await writeFile(`${file}.tmp`, data, { flag: "w" });
  await rename(`${file}.tmp`, file);
  job.touch();
  return { status: 201, result: { n, bytes: data.length, sha256 } };
}

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The parts joined, in order, as one stream. */
async function* joined(files: readonly string[]): AsyncGenerator<Uint8Array> {
  for (const file of files) {
    for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
      yield chunk as Buffer;
    }
  }
}

/** Removes the regular file at `path` below `root`, never through a link. Other things stay. */
async function removeFile(root: string, path: string): Promise<boolean> {
  let normalized: string;
  try {
    normalized = normalizeRelativePath(path);
  } catch {
    return false;
  }
  let current = root;
  const parts = normalized.split("/");
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (info === null) return false;
    const last = i === parts.length - 1;
    if (!last && !info.isDirectory()) return false;
    if (last) {
      if (!info.isFile()) return false;
      await unlink(current);
      return true;
    }
  }
  return false;
}

/** The `x-delete` header: a JSON list of paths. */
export function parseDeleteList(header: string | undefined): string[] {
  if (header === undefined || header === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(header);
  } catch {
    throw new ServiceError("bad_request", "x-delete must be a JSON list of paths");
  }
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string") || raw.length > 10_000) {
    throw new ServiceError("bad_request", "x-delete must be a JSON list of paths");
  }
  return raw as string[];
}

/** `PUT .../uploads/{upload}`: checks the parts, unpacks them, forgets them. */
export async function commitUpload(
  job: Job,
  upload: string,
  commit: UploadCommit,
  deletes: readonly string[],
): Promise<UploadResult> {
  const hash = requestHash({ commit, deletes });
  return await job.lock.run(async () => {
    const done = job.uploads.get(upload);
    if (done !== undefined) {
      if (done.hash !== hash)
        throw new ServiceError("conflict", "this upload id was committed with another body");
      return done.result as UploadResult;
    }
    job.assertLive();
    const target = commit.target;
    if (target === "tools" && !job.request.mounts.tools) {
      throw new ServiceError("bad_request", "this job has no /tools");
    }
    if (target === "ext" && job.request.kind !== "plugin" && !job.request.mounts.ext) {
      throw new ServiceError("bad_request", "this job has no /ext");
    }
    if (!SHA256.test(commit.sha256)) throw new ServiceError("bad_request", "sha256 must be hex");
    if (!Number.isInteger(commit.parts) || commit.parts < 0 || commit.parts > MAX_PARTS) {
      throw new ServiceError("bad_request", "bad part count");
    }
    const dir = partsDir(job, upload);
    const files: string[] = [];
    let bytes = 0;
    for (let n = 0; n < commit.parts; n++) {
      const file = join(dir, String(n));
      const info = await lstat(file).catch(() => null);
      if (info === null || !info.isFile())
        throw new ServiceError("bad_request", `part ${n} is missing`);
      files.push(file);
      bytes += info.size;
    }
    if (bytes !== commit.bytes) {
      throw new ServiceError("bad_request", `the parts hold ${bytes} bytes, not ${commit.bytes}`);
    }
    const whole = createHash("sha256");
    for await (const chunk of joined(files)) whole.update(chunk);
    if (whole.digest("hex") !== commit.sha256) {
      throw new ServiceError("bad_request", "the parts together do not match sha256");
    }

    const into = job.dirs[target];
    const writable = target === "workspace" || target === "work";
    const unpack = async () => {
      if (commit.replace) await emptyDir(into);
      for (const path of deletes) {
        await removeFile(into, path);
        if (target === "workspace") job.base.delete(path);
      }
      return await extractTar(joined(files), into, {
        gzip: commit.format === "tar.gz",
        limits: {
          maxFiles: MAX_FILES,
          maxBytes: job.limits.disk_mb * MIB,
          maxFileBytes: job.limits.file_mb * MIB,
          maxDepth: MAX_DEPTH,
        },
        onExisting: () => "replace",
      });
    };
    let unpacked: Awaited<ReturnType<typeof extractTar>>;
    try {
      unpacked = writable ? await whileQuiet(job, unpack) : await unpack();
    } catch (error) {
      if (error instanceof TarError) {
        throw new ServiceError(
          error.code === "corrupt" ? "bad_request" : "too_large",
          error.message,
        );
      }
      throw error;
    }
    if (target === "workspace") {
      if (commit.replace) job.base = new Map();
      // What Core has now: the list it sent, as far as it was really unpacked here.
      const written = new Map(unpacked.written.map((e) => [e.path, e]));
      for (const entry of commit.manifest) {
        const got = written.get(entry.path);
        if (got !== undefined)
          job.base.set(entry.path, { ...entry, sha256: got.sha256, size: got.size });
        else if (!commit.replace) job.base.set(entry.path, entry as ManifestEntry);
      }
      for (const entry of unpacked.written)
        if (!job.base.has(entry.path)) job.base.set(entry.path, entry);
    }
    await removeTree(dir).catch(() => undefined);
    const result: UploadResult = {
      files: unpacked.written.length,
      bytes: unpacked.written.reduce((sum, e) => sum + e.size, 0),
      skipped: unpacked.skipped,
    };
    job.uploads.set(upload, { hash, result });
    job.used();
    const disk = await job.measureDisk();
    if (disk.over) {
      void job.end("disk");
      throw new ServiceError("limit", "the job's folders are over their disk limit");
    }
    return result;
  });
}
