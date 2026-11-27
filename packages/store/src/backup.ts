// The nightly copy of the database (docs/design/v5-data.md §2.5): `VACUUM INTO` a file of the day
// in a backup folder, the newest few kept, and `PRAGMA incremental_vacuum` after it when the
// database is in incremental auto-vacuum mode (the first core migration sets it; an older file in
// another mode is left in it, since changing the mode takes a full `VACUUM`).
//
// - Off the hot path. `DatabaseSync` is synchronous: `VACUUM INTO` on the store's own connection
//   would hold the event loop, voice included, for as long as the copy takes (about 0.6 s for a
//   200 MB file on a fast disk, measured 2026-11-27; seconds for a bigger one or a slower disk).
//   The copy is made in a worker thread on a connection of its own. In WAL mode that connection is
//   one more reader: the store keeps writing meanwhile, and the copy is the snapshot of the moment
//   it started (WAL can only be checkpointed up to that snapshot until it ends).
// - The disk. The copy is about the database's used pages (`page_count - freelist_count` times
//   `page_size`): with `keep` copies the folder holds about `keep` times that. Nothing is written
//   when the disk would be left with less than `minFreeBytes` after the copy; the run says so,
//   with both sizes, and the copies already there stay.
// - A copy is written under `<name>.partial` and renamed once complete: a crash never leaves a
//   file that looks finished. Only files named like the copies (`<base>-YYYY-MM-DD.db`) are ever
//   removed from the folder.
// - `incremental_vacuum` is a write: it goes in small steps with a pause between them, so the
//   store's own writes (which wait on the lock synchronously) are never held up for long.

import { existsSync, statfsSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Clock } from "@miyoria/types";

/** Pages one `incremental_vacuum` step frees at most (about 1 MB of 4 KiB pages). */
const VACUUM_STEP_PAGES = 256;
/** The pause between two steps, for the store's writes to get the lock. */
const VACUUM_PAUSE_MS = 20;
/** Steps of one run at most (the rest waits for the next night). */
const VACUUM_MAX_STEPS = 4_000;
/** How long the worker's connection waits for a lock. */
const BUSY_MS = 5_000;

export interface BackupOptions {
  /** The folder the copies go to (created when missing). */
  dir: string;
  /** The newest copies kept (at least 1). */
  keep: number;
  /** What must be left free on the disk after the copy, in bytes; else nothing is written. */
  minFreeBytes: number;
  /** The time of the run (epoch ms): its local day names the copy. */
  now: number;
}

interface Sizes {
  /** About what the copy takes: the database's used pages. */
  expected_bytes: number;
  /** Free space on the folder's disk before the copy. */
  free_bytes: number;
}

export type BackupResult =
  | (Sizes & {
      status: "written";
      file: string;
      bytes: number;
      /** Older copies removed to keep `keep`. */
      removed: string[];
      /** Free pages given back by `incremental_vacuum` (0 outside incremental mode). */
      vacuumed_pages: number;
      ms: number;
    })
  | (Sizes & {
      status: "skipped";
      /** `exists`: the day's copy is there already; `low_disk`: it would not fit. */
      reason: "exists" | "low_disk";
      file: string;
    });

/** `YYYY-MM-DD` of `ms` in the machine's local time: a night's copy is named by its day. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The file name of the copy of database `base` (its name without `.db`) made on `day`. */
export function backupName(base: string, day: string): string {
  return `${base}-${day}.db`;
}

const COPY = /^(.+)-(\d{4}-\d{2}-\d{2})\.db$/;

// The worker's code, run from a string so it needs no file of its own next to either the
// sources or the build. It only uses Node's own modules.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { statfsSync } = require("node:fs");
const { source, target, folder, minFreeBytes, step, pauseMs, maxSteps, busyMs } = workerData;
const one = (db, sql) => Object.values(db.prepare(sql).get())[0];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let db;
try {
  db = new DatabaseSync(source);
  db.exec("PRAGMA busy_timeout = " + busyMs);
  const pageSize = Number(one(db, "PRAGMA page_size"));
  const used = Number(one(db, "PRAGMA page_count")) - Number(one(db, "PRAGMA freelist_count"));
  const fs = statfsSync(folder);
  const sizes = { expected_bytes: used * pageSize, free_bytes: Number(fs.bavail) * Number(fs.bsize) };
  if (sizes.free_bytes - sizes.expected_bytes < minFreeBytes) {
    parentPort.postMessage({ status: "low_disk", ...sizes });
  } else {
    db.exec("VACUUM INTO '" + target.replaceAll("'", "''") + "'");
    let vacuumed = 0;
    if (Number(one(db, "PRAGMA auto_vacuum")) === 2 && step > 0) {
      for (let i = 0; i < maxSteps; i++) {
        const before = Number(one(db, "PRAGMA freelist_count"));
        if (before === 0) break;
        db.exec("PRAGMA incremental_vacuum(" + step + ")");
        vacuumed += before - Number(one(db, "PRAGMA freelist_count"));
        sleep(pauseMs);
      }
    }
    parentPort.postMessage({ status: "written", vacuumed, ...sizes });
  }
} catch (error) {
  parentPort.postMessage({ status: "error", message: error instanceof Error ? error.message : String(error) });
} finally {
  try { db?.close(); } catch {}
}
`;

type WorkerReply =
  | (Sizes & { status: "low_disk" })
  | (Sizes & { status: "written"; vacuumed: number })
  | { status: "error"; message: string };

function inWorker(data: Record<string, unknown>): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: data });
    let replied = false;
    worker.once("message", (reply: WorkerReply) => {
      replied = true;
      resolve(reply);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!replied) reject(new Error(`the backup worker stopped (exit ${code})`));
    });
  });
}

/** The copies of one database file. */
export class DatabaseBackups {
  readonly path: string;
  /** The copies' base name: the file's name without `.db`. */
  readonly base: string;

  constructor(path: string) {
    this.path = path;
    this.base = basename(path).replace(/\.db$/i, "");
  }

  /** `backups/auto` beside the database: the default folder. */
  get defaultDir(): string {
    return join(dirname(this.path), "backups", "auto");
  }

  /** The copies in `dir`, newest first. */
  async list(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const names = await readdir(dir);
    return names
      .filter((n) => COPY.exec(n)?.[1] === this.base)
      .sort()
      .reverse()
      .map((n) => join(dir, n));
  }

  /** Makes the copy of the day `options.now` falls on, unless it is there or would not fit. */
  async run(options: BackupOptions): Promise<BackupResult> {
    const started = Date.now();
    const dir = options.dir;
    await mkdir(dir, { recursive: true });
    const file = join(dir, backupName(this.base, localDay(options.now)));
    if (existsSync(file)) {
      return { status: "skipped", reason: "exists", file, ...this.#sizes(dir) };
    }
    const partial = `${file}.partial`;
    await rm(partial, { force: true });
    const reply = await inWorker({
      source: this.path,
      target: partial,
      folder: dir,
      minFreeBytes: Math.max(0, options.minFreeBytes),
      step: VACUUM_STEP_PAGES,
      pauseMs: VACUUM_PAUSE_MS,
      maxSteps: VACUUM_MAX_STEPS,
      busyMs: BUSY_MS,
    });
    if (reply.status === "error") {
      await rm(partial, { force: true });
      throw new Error(`cannot back up the database: ${reply.message}`);
    }
    const sizes = { expected_bytes: reply.expected_bytes, free_bytes: reply.free_bytes };
    if (reply.status === "low_disk")
      return { status: "skipped", reason: "low_disk", file, ...sizes };
    await rename(partial, file);
    const removed: string[] = [];
    for (const old of (await this.list(dir)).slice(Math.max(1, Math.floor(options.keep)))) {
      await rm(old, { force: true });
      removed.push(old);
    }
    return {
      status: "written",
      file,
      bytes: statSync(file).size,
      removed,
      vacuumed_pages: reply.vacuumed,
      ms: Date.now() - started,
      ...sizes,
    };
  }

  /** The sizes as they are now, for a run that wrote nothing (read here, cheaply). */
  #sizes(dir: string): Sizes {
    let free = 0;
    try {
      const fs = statfsSync(dir);
      free = Number(fs.bavail) * Number(fs.bsize);
    } catch {
      free = 0;
    }
    let expected = 0;
    try {
      expected = statSync(this.path).size;
    } catch {
      expected = 0;
    }
    return { expected_bytes: expected, free_bytes: free };
  }
}

export interface BackupScheduleOptions {
  /** The local hour (0-23) from which the night's copy is made. */
  hour: number;
  dir: string;
  keep: number;
  minFreeBytes: number;
}

/**
 * When the night's copy is made: once per local day, at the first check from `hour` on. A day
 * whose run was skipped or failed is not tried again before the next one; a restart tries again
 * (the day's copy, if there is one, is found by its name).
 */
export class BackupSchedule {
  readonly #backups: DatabaseBackups;
  readonly #clock: Clock;
  readonly #options: BackupScheduleOptions;
  #lastDay: string | null = null;

  constructor(backups: DatabaseBackups, clock: Clock, options: BackupScheduleOptions) {
    this.#backups = backups;
    this.#clock = clock;
    this.#options = options;
  }

  /** How often `tick` is worth calling. */
  readonly checkMs = 10 * 60_000;

  /** Runs the night's copy if it is due; `null` when it is not. Errors go to the caller. */
  async tick(): Promise<BackupResult | null> {
    const now = this.#clock.now();
    const day = localDay(now);
    if (day === this.#lastDay || new Date(now).getHours() < this.#options.hour) return null;
    this.#lastDay = day;
    return this.#backups.run({
      dir: this.#options.dir,
      keep: this.#options.keep,
      minFreeBytes: this.#options.minFreeBytes,
      now,
    });
  }
}
