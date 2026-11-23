// `miyoria db import-links / archive / doctor`: the printers over the store's cut-over functions,
// on a small V4 database from `@miyoria/store/testing`.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@miyoria/store";
import { v4File } from "@miyoria/store/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands, helpText, parseArgs } from "../src/cli.js";
import { archiveCommand, doctorCommand, importLinksCommand } from "../src/commands/db.js";
import { setOutput } from "../src/ui.js";
import { Scripted, Text } from "./scripted.js";

let root = "";
let out: string[] = [];
let restore: () => void = () => undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-cli-db-"));
  mkdirSync(join(root, "data"));
  out = [];
  restore = setOutput({ out: (t) => out.push(t), err: (t) => out.push(t) });
});
afterEach(() => {
  restore();
  rmSync(root, { recursive: true, force: true });
});

const text = () => out.join("");
/** Paths as the commands print them: with forward slashes, which every shell takes. */
const slashed = (path: string) => path.replaceAll("\\", "/");
const lastLines = (n: number) => text().trimEnd().split("\n").slice(-n);

function config(databaseUrl: string): string {
  const path = join(root, "miyoria.toml");
  writeFileSync(path, `[core]\nprofile = "deepseek-chan"\ndatabase_url = "${databaseUrl}"\n`);
  return path;
}

function oldDatabase(name = "miyoria.db"): string {
  const path = join(root, "data", name);
  v4File(path).close();
  return path;
}

describe("miyoria db import-links", () => {
  it("lists what it would bring in a dry run, then imports, ending with the counts", async () => {
    const old = oldDatabase();
    const cfg = config("sqlite:data/core.db");
    await importLinksCommand(cfg, { from: old, dryRun: true });
    expect(text()).toContain("Dry run complete; nothing was written");
    expect(text()).toContain("owen → owen#2");
    expect(existsSync(join(root, "data", "core.db"))).toBe(false);

    out = [];
    await importLinksCommand(cfg, { from: old, dryRun: false });
    expect(lastLines(7)).toEqual([
      "Counts",
      "  People: 4 (plus 1 created only to keep preferences), accounts: 6",
      "  Handles: 4 kept, 1 renamed, 0 new",
      "  Preferences: privacy 1, voice consent 3",
      "  Keepsake card data: 2 people with an old bond level, 3 old cards",
      "  Skipped: 0 already imported, 1 without accounts, 1 accounts without a person, 1 unused handles",
      `✓ Import complete: 5 people, 6 accounts, 5 identity.imported events; created ${slashed(join(root, "data", "core.db"))}`,
    ]);
  });

  it("needs --from, and refuses a new database still named miyoria.db", async () => {
    const old = oldDatabase("old.db");
    await expect(
      importLinksCommand(config("sqlite:data/core.db"), { from: undefined, dryRun: true }),
    ).rejects.toThrow("--from");
    await expect(
      importLinksCommand(config("sqlite:data/miyoria.db"), { from: old, dryRun: true }),
    ).rejects.toThrow("core.database_url sqlite:data/core.db");
  });
});

describe("miyoria db archive", () => {
  it("asks for the word, then archives and prints the next commands", async () => {
    oldDatabase();
    const cfg = config("sqlite:data/miyoria.db");
    const options = { file: undefined, dryRun: false, yes: false };
    await expect(archiveCommand(cfg, options, null)).rejects.toThrow("--yes");
    await archiveCommand(cfg, options, new Scripted([Text("yes")]));
    expect(text()).toContain("Cancelled; no files were moved.");
    expect(readdirSync(join(root, "data")).sort()).toEqual(["miyoria.db"]);

    out = [];
    await archiveCommand(cfg, options, new Scripted([Text("archive")]));
    expect(readdirSync(join(root, "data")).sort()).toEqual(["archive"]);
    expect(text()).toContain("no files were deleted");
    const next = lastLines(7);
    expect(next[0]).toBe("Next steps");
    expect(next[1]).toBe(
      `  miyoria config set core.database_url sqlite:data/core.db -c ${slashed(cfg)}`,
    );
    expect(next[2]).toMatch(/^ {2}miyoria db import-links --from .*\.single\.db --dry-run -c /);
  });
});

describe("miyoria db doctor", () => {
  it("describes a V4 file with what the guard says and what an import would bring", async () => {
    const old = oldDatabase();
    await doctorCommand(join(root, "none.toml"), old);
    expect(text()).toContain("V4 database (schema_version 18)");
    expect(text()).toContain("Core will refuse to open this file");
    expect(text()).toContain("What import-links would bring over");
    expect(text()).toContain("People: 5, accounts: 6, events (log_events): 1");
  });

  it("lists a V5 file's servers, their members and the primary", async () => {
    const path = join(root, "core.db");
    const store = await SqliteStore.open(path);
    store.places.seen("discord", "111", "魚缸");
    store.places.seen("discord", "222", "第二");
    await store.close();
    await doctorCommand(join(root, "none.toml"), path);
    expect(text()).toContain("Servers");
    expect(text()).toMatch(/魚缸 {2}.*discord:111.* {2}0 members {2}primary/);
    expect(text()).toMatch(/第二 {2}.*discord:222.* {2}0 members\n/);
  });

  it("fails on a file that is not a database", async () => {
    const path = join(root, "notes.db");
    writeFileSync(path, "x".repeat(200));
    await expect(doctorCommand(join(root, "none.toml"), path)).rejects.toThrow("1 check failed");
  });
});

describe("the db commands", () => {
  it("are under `miyoria db` with their options", () => {
    const parsed = parseArgs(["db", "import-links", "--from", "x.db", "--dry-run"]);
    expect(parsed.path.map((c) => c.name)).toEqual(["miyoria", "db", "import-links"]);
    expect(parsed.ctx.options).toMatchObject({ from: "x.db", "dry-run": true });
    const root = commands();
    const db = root.subcommands?.find((c) => c.name === "db");
    expect(db?.subcommands?.map((c) => c.name)).toEqual(["import-links", "archive", "doctor"]);
    expect(helpText([root, db as NonNullable<typeof db>])).toContain("import-links");
  });
});
