// The nightly copy of the database (`backup.ts`): a consistent copy made on a connection of its
// own in a worker thread, the newest few kept, none written when the disk would run low, and the
// free pages given back only to a database in incremental auto-vacuum mode.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupSchedule,
  backupName,
  DatabaseBackups,
  localDay,
  SqliteStore,
} from "../src/index.js";

const DAY = 86_400_000;
const T0 = new Date(2026, 10, 27, 4, 30).getTime(); // 04:30 local time

let dirs: string[] = [];
const opened: SqliteStore[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-backup-"));
  dirs.push(dir);
  const path = join(dir, "miyoria.db");
  const store = await SqliteStore.open(path);
  opened.push(store);
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("CREATE TABLE filler (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = raw.prepare("INSERT INTO filler (v) VALUES (?)");
  raw.exec("BEGIN");
  for (let i = 0; i < 2_000; i++) insert.run(`${"x".repeat(400)}${i}`);
  raw.exec("COMMIT");
  return { dir, path, store, raw, out: join(dir, "backups", "auto") };
}

const options = (out: string, now = T0) => ({ dir: out, keep: 3, minFreeBytes: 0, now });

describe("the database backup", () => {
  it("writes a consistent copy named by the local day, readable on its own", async () => {
    const r = await rig();
    const backups = r.store.backups as DatabaseBackups;
    expect(backups.defaultDir).toBe(r.out);
    const result = await backups.run(options(r.out));
    expect(result).toMatchObject({
      status: "written",
      file: join(r.out, backupName("miyoria", localDay(T0))),
    });
    if (result.status !== "written") throw new Error("not written");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.expected_bytes).toBeGreaterThan(0);
    const copy = new DatabaseSync(result.file, { readOnly: true });
    expect(copy.prepare("SELECT count(*) AS n FROM filler").get()).toEqual({ n: 2_000 });
    copy.close();
    // Nothing half-written is left beside it.
    expect(readdirSync(r.out)).toEqual([backupName("miyoria", localDay(T0))]);
    r.raw.close();
  });

  it("lets the store write while the copy is made, off the main thread", async () => {
    const r = await rig();
    const backups = r.store.backups as DatabaseBackups;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const running = backups.run(options(r.out));
    await r.store.settings.set("p", "during:backup", { ok: true });
    const result = await running;
    clearInterval(timer);
    expect(result.status).toBe("written");
    expect(await r.store.settings.get("p", "during:backup")).toEqual({ ok: true });
    expect(ticks).toBeGreaterThan(0);
    r.raw.close();
  });

  it("keeps the newest copies and never touches other files", async () => {
    const r = await rig();
    const backups = r.store.backups as DatabaseBackups;
    mkdirSync(r.out, { recursive: true });
    writeFileSync(join(r.out, "notes.txt"), "mine");
    for (let d = 0; d < 5; d++) await backups.run({ ...options(r.out, T0 + d * DAY), keep: 3 });
    const names = readdirSync(r.out).sort();
    expect(names).toEqual(
      [...[2, 3, 4].map((d) => backupName("miyoria", localDay(T0 + d * DAY))), "notes.txt"].sort(),
    );
    // The same day again is not copied twice.
    expect(await backups.run(options(r.out, T0 + 4 * DAY))).toMatchObject({
      status: "skipped",
      reason: "exists",
    });
    r.raw.close();
  });

  it("skips with the sizes when the disk would be left with too little", async () => {
    const r = await rig();
    const backups = r.store.backups as DatabaseBackups;
    const result = await backups.run({ ...options(r.out), minFreeBytes: Number.MAX_SAFE_INTEGER });
    expect(result).toMatchObject({ status: "skipped", reason: "low_disk" });
    expect(result.expected_bytes).toBeGreaterThan(0);
    expect(result.free_bytes).toBeGreaterThan(0);
    expect(existsSync(r.out) ? readdirSync(r.out) : []).toEqual([]);
    r.raw.close();
  });

  it("replaces a copy an earlier run left unfinished", async () => {
    const r = await rig();
    const backups = r.store.backups as DatabaseBackups;
    mkdirSync(r.out, { recursive: true });
    const name = backupName("miyoria", localDay(T0));
    writeFileSync(join(r.out, `${name}.partial`), "half");
    expect((await backups.run(options(r.out))).status).toBe("written");
    expect(readdirSync(r.out)).toEqual([name]);
    r.raw.close();
  });

  it("gives free pages back only in incremental auto-vacuum mode", async () => {
    const r = await rig();
    expect(r.raw.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    r.raw.exec("DELETE FROM filler");
    const free = () =>
      Number(
        (r.raw.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
      );
    const before = free();
    expect(before).toBeGreaterThan(0);
    const result = await (r.store.backups as DatabaseBackups).run(options(r.out));
    expect(result).toMatchObject({ status: "written", vacuumed_pages: before });
    expect(free()).toBe(0);
    r.raw.close();

    // A database in another mode is left in it, with its free pages.
    const dir = mkdtempSync(join(tmpdir(), "miyoria-backup-none-"));
    dirs.push(dir);
    const plain = join(dir, "plain.db");
    const db = new DatabaseSync(plain);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT)");
    db.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) " +
        "INSERT INTO t SELECT hex(randomblob(500)) FROM n",
    );
    db.exec("DELETE FROM t");
    const left = Number(
      (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
    );
    const out = await new DatabaseBackups(plain).run(options(join(dir, "out")));
    expect(out).toMatchObject({ status: "written", vacuumed_pages: 0 });
    expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    expect(
      Number(
        (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
      ),
    ).toBe(left);
    db.close();
  });

  it("has no copies for a database in memory", async () => {
    const store = await SqliteStore.open(":memory:");
    opened.push(store);
    expect(store.backups).toBeNull();
  });
});

describe("the nightly schedule", () => {
  it("runs once a local day, from its hour on", async () => {
    const r = await rig();
    const clock = { at: new Date(2026, 10, 27, 3, 0).getTime() };
    const schedule = new BackupSchedule(
      r.store.backups as DatabaseBackups,
      { now: () => clock.at },
      {
        hour: 4,
        dir: r.out,
        keep: 3,
        minFreeBytes: 0,
      },
    );
    expect(await schedule.tick()).toBeNull();
    clock.at += 90 * 60_000; // 04:30
    expect((await schedule.tick())?.status).toBe("written");
    clock.at += 60 * 60_000;
    expect(await schedule.tick()).toBeNull();
    clock.at += DAY;
    expect((await schedule.tick())?.status).toBe("written");
    expect(readdirSync(r.out)).toHaveLength(2);
    r.raw.close();
  });
});
