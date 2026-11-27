// How much a job's folders hold (docs/design/v6-sandbox.md §2.2, §15): bind mounts have no quota,
// so they are measured every 5 seconds while something runs, and a job over `disk_mb` is stopped.
// The folders are the program's: the walk never follows a link (directory entries are read with
// their types, a link is counted as a link), and it stops at `MAX_ENTRIES`.

import type { Dirent } from "node:fs";
import { chmod, lstat, opendir, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

/** More entries than this counts as over any limit (a walk must stay cheap). */
export const MAX_ENTRIES = 500_000;
/** What a directory or a non-file entry costs, roughly a block. */
const ENTRY_BYTES = 4096;

export interface DiskReading {
  bytes: number;
  entries: number;
  /** The walk stopped at `MAX_ENTRIES`. */
  truncated: boolean;
}

/** Bytes under `dirs` together. A folder that is not there counts nothing. */
export async function measure(
  dirs: readonly string[],
  maxEntries = MAX_ENTRIES,
): Promise<DiskReading> {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    const subdirs: string[] = [];
    try {
      for await (const entry of handle as AsyncIterable<Dirent>) {
        if (++entries > maxEntries) {
          truncated = true;
          break;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          bytes += ENTRY_BYTES;
          subdirs.push(full);
        } else if (entry.isFile()) {
          try {
            const info = await lstat(full);
            bytes += info.isFile() ? info.size : ENTRY_BYTES;
          } catch {
            // Gone since the listing.
          }
        } else bytes += ENTRY_BYTES;
      }
    } catch {
      // A folder that changed under the walk; what was counted stands.
    }
    for (const sub of subdirs) {
      if (truncated) return;
      await walk(sub);
    }
  };
  for (const dir of dirs) {
    if (truncated) break;
    await walk(dir);
  }
  return { bytes, entries, truncated };
}

/**
 * Removes `dir` and everything below, without following links, also when the program left
 * folders without permissions (it runs as this user on Linux and may `chmod 000` them).
 */
export async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
    return;
  } catch {
    // Opened up below, then again.
  }
  await openUp(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 2 });
}

async function openUp(dir: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(dir);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;
  await chmod(dir, 0o700).catch(() => undefined);
  let names: Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    if (entry.isDirectory()) await openUp(join(dir, entry.name));
  }
}

/** Empties `dir` (a mount point stays a directory), without following links. */
export async function emptyDir(dir: string): Promise<void> {
  let names: Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await removeTree(full);
    else await unlink(full).catch(() => removeTree(full));
  }
}
