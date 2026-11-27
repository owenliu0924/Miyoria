// Changes of /workspace back to Core (docs/design/v6-sandbox.md §4.3): the folder is walked (one
// `lstat` per entry, links and devices left out, every path through `normalizeRelativePath`),
// compared with what Core has (`job.base`: size and time first, the hash only when they differ),
// and what is new or changed is packed by `tar-io` into `outgoing/<sync>.tar`. Core fetches it
// (ETag, length, range), then deletes the sync, and only then is the comparison base moved on: a
// sync Core never received is sent again by the next one. The walk and the packing happen while
// nothing of the program runs (`whileQuiet`).

import { createHash } from "node:crypto";
import { createWriteStream, constants as fsConstants } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ManifestEntry, SyncResult, SyncStart } from "@miyoria/contracts/workers";
import { normalizeRelativePath, pathKey } from "../paths.js";
import { packTree, stampTrusted, TarError } from "../tar-io.js";
import type { Job } from "./jobs.js";
import { whileQuiet } from "./quiet.js";
import { MIB, requestHash, ServiceError } from "./util.js";

const MAX_FILES = 200_000;
const MAX_DEPTH = 10;

interface Walked {
  entries: Map<string, ManifestEntry>;
  skipped: { path: string; why: string }[];
}

function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function shown(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces
  return path.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
}

async function hashFile(full: string): Promise<string | null> {
  const handle = await open(full, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(
    () => null,
  );
  if (handle === null) return null;
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Every regular file below `root`, with its hash (taken from `base` when size and time agree). */
async function walk(root: string, base: ReadonlyMap<string, ManifestEntry>): Promise<Walked> {
  const entries = new Map<string, ManifestEntry>();
  const skipped: Walked["skipped"] = [];
  const seen = new Set<string>();
  let count = 0;
  const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const names = (await readdir(dir).catch(() => [] as string[])).sort();
    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (++count > MAX_FILES * 2)
        throw new TarError("too_many_files", "too many entries in /workspace");
      let normalized: string;
      try {
        // The rules `tar-io` packs by, so what is listed here is what can go into the tar.
        normalized = normalizeRelativePath(path);
      } catch (error) {
        skipped.push({
          path: shown(path),
          why: error instanceof Error ? error.message : "bad path",
        });
        continue;
      }
      const full = join(dir, name);
      const info = await lstat(full).catch(() => null);
      if (info === null) continue;
      if (info.isSymbolicLink()) {
        skipped.push({ path: shown(path), why: "link" });
        continue;
      }
      if (info.isDirectory()) {
        if (depth >= MAX_DEPTH) skipped.push({ path: shown(path), why: "too deep" });
        else await visit(full, path, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ path: shown(path), why: "not a regular file" });
        continue;
      }
      const key = pathKey(normalized);
      if (seen.has(key)) {
        skipped.push({ path: shown(path), why: "same name as another file apart from case" });
        continue;
      }
      seen.add(key);
      const mtime = wholeSeconds(info.mtimeMs);
      const known = base.get(normalized);
      let sha =
        known !== undefined &&
        stampTrusted(info.size, known.size === info.size && wholeSeconds(known.mtime_ms) === mtime)
          ? known.sha256
          : null;
      sha ??= await hashFile(full);
      if (sha === null) {
        skipped.push({ path: shown(path), why: "unreadable" });
        continue;
      }
      entries.set(normalized, { path: normalized, size: info.size, sha256: sha, mtime_ms: mtime });
    }
  };
  await visit(root, "", 1);
  return { entries, skipped };
}

function tarFile(job: Job, sync: string): string {
  return join(job.dirs.outgoing, `${sync}.tar`);
}

/** `PUT .../syncs/{sync}`. */
export async function startSync(job: Job, sync: string, start: SyncStart): Promise<SyncResult> {
  const hash = requestHash(start);
  return await job.lock.run(async () => {
    const known = job.syncs.get(sync);
    if (known !== undefined) {
      if (known.hash !== hash)
        throw new ServiceError("conflict", "this sync id was used for another sync");
      return known.result as SyncResult;
    }
    job.assertLive();
    const root = job.dirs.workspace;
    const file = tarFile(job, sync);
    let outcome: { result: SyncResult; manifest: Map<string, ManifestEntry> };
    try {
      outcome = await whileQuiet(job, async () => {
        const walked = await walk(root, job.base);
        const changed = [...walked.entries.values()].filter(
          (e) => job.base.get(e.path)?.sha256 !== e.sha256,
        );
        const deleted = [...job.base.keys()].filter((path) => !walked.entries.has(path));
        if (changed.length === 0) {
          return {
            result: { changed: [], deleted, skipped: walked.skipped, tar: null },
            manifest: walked.entries,
          };
        }
        // Only the changed files, and the directories on the way to them.
        const wanted = new Set<string>();
        for (const entry of changed) {
          const parts = entry.path.split("/");
          for (let i = 1; i <= parts.length; i++) wanted.add(parts.slice(0, i).join("/"));
        }
        const packed = packTree(root, {
          skip: (relative) => !wanted.has(relative),
          limits: {
            maxFiles: MAX_FILES,
            maxBytes: job.limits.disk_mb * MIB,
            maxFileBytes: job.limits.file_mb * MIB,
          },
        });
        await pipeline(packed.stream, createWriteStream(file, { flags: "wx" }));
        const done = await packed.done;
        // What went into the tar is what Core gets; its hashes are the ones read while packing.
        const manifest = new Map(walked.entries);
        for (const entry of done.entries) manifest.set(entry.path, entry);
        return {
          result: {
            changed: done.entries,
            deleted,
            skipped: [...walked.skipped, ...done.skipped],
            tar: { bytes: done.bytes, sha256: done.sha256 },
          },
          manifest,
        };
      });
    } catch (error) {
      await rm(file, { force: true }).catch(() => undefined);
      if (error instanceof TarError) throw new ServiceError("too_large", error.message);
      throw error;
    }
    job.syncs.set(sync, {
      hash,
      result: outcome.result,
      manifest: outcome.manifest,
      tar: outcome.result.tar === null ? null : file,
    });
    job.used();
    return outcome.result;
  });
}

/** The tar of a sync, for the download route. */
export function syncTar(job: Job, sync: string): { file: string; sha256: string; bytes: number } {
  const known = job.syncs.get(sync);
  if (known === undefined) throw new ServiceError("not_found", "no such sync");
  const result = known.result as SyncResult;
  if (known.tar === null || result.tar === null)
    throw new ServiceError("not_found", "this sync has no tar");
  return { file: known.tar, sha256: result.tar.sha256, bytes: result.tar.bytes };
}

/** `DELETE .../syncs/{sync}`: Core has it; what it got is the new comparison base. */
export async function finishSync(job: Job, sync: string): Promise<void> {
  await job.lock.run(async () => {
    const known = job.syncs.get(sync);
    if (known === undefined) return;
    job.base = known.manifest;
    job.syncs.delete(sync);
    if (known.tar !== null) await rm(known.tar, { force: true }).catch(() => undefined);
  });
}
