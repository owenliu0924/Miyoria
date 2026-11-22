// The migration runner: bookkeeping, checksums, order, the naming lint, and the refusal to touch
// a V4 database.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openTestDb } from "@miyoria/store/testing";
import { systemClock } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  appliedMigrations,
  checksum,
  coreSchema,
  Db,
  identitySchema,
  legacySchema,
  lintSchemas,
  migrate,
  openStore,
  orderSchemas,
  type PluginSchema,
  SchemaError,
  SqliteStore,
} from "../src/index.js";

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-migrate-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function fileDb(path: string): Db {
  return new Db(new DatabaseSync(path, { enableForeignKeyConstraints: true }), systemClock);
}

function schema(plugin: string, sqls: string[], requires?: string[]): PluginSchema {
  return {
    plugin,
    ...(requires && { requires }),
    migrations: sqls.map((sql, i) => ({ version: i + 1, name: `step${i + 1}`, sql })),
  };
}

function thrown(fn: () => unknown): SchemaError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    return error as SchemaError;
  }
  throw new Error("expected a SchemaError");
}

/** sha256 of every file in a directory, by name. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return out;
}

const SHOP = schema("shop", [
  "CREATE TABLE shop_items (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;",
  "CREATE INDEX shop_items_name_idx ON shop_items (name);",
]);

describe("bookkeeping", () => {
  it("records core and legacy with checksums, and builds the V4 tables as they were", () => {
    const t = openTestDb({ legacy: true });
    try {
      const rows = appliedMigrations(t.db);
      expect(rows.map((r) => `${r.plugin}:${r.version}`)).toEqual([
        "core:1",
        "core:2",
        "core:3",
        "core:4",
        "core:5",
        "core:6",
        "core:7",
        "legacy:1",
      ]);
      expect(rows[0]).toMatchObject({
        name: "bookkeeping",
        checksum: checksum(coreSchema.migrations[0]?.sql ?? ""),
      });
      for (const m of legacySchema.migrations) {
        const row = rows.find((r) => r.plugin === "legacy" && r.version === m.version);
        expect(row?.checksum).toBe(createHash("sha256").update(m.sql).digest("hex"));
      }
      expect(t.applied).toEqual(rows);
      const tables = t.db
        .all("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(["relationships", "member_cards"]));
      expect(tables).not.toContain("schema_version");
      // Chat lines are events (core migration 3); so are decisions, turn outcomes and audit
      // entries (core migration 4). Settings are rows of `plugin_state`, and module on/off is a
      // flag in the current config revision (config migration 1).
      for (const gone of [
        "message_log",
        "decision_log",
        "turn_outcomes",
        "audit_log",
        "profile_settings",
        "module_state",
        // The auth plugin's tables (v5-data §8 step 9a).
        "roles",
        "role_assignments",
        "role_mappings",
        "node_overrides",
        "directives",
        // Runtime persona edits are config's `config_persona_overrides`.
        "persona_overrides",
        // The economy plugin's tables (v5-data §8 step 9a).
        "coin_ledger",
        "coin_wallets",
        "fortunes",
        "bounties",
        "economy_docs",
        // The memory plugin's tables (v5-data §8 step 9b).
        "memory_records",
        "memory_fts",
        "memory_vector_version",
      ]) {
        expect(tables).not.toContain(gone);
      }
      // Re-running is a no-op.
      expect(migrate(t.db, [legacySchema])).toEqual([]);
      expect(appliedMigrations(t.db)).toEqual(rows);
    } finally {
      t.close();
    }
  });

  it("the legacy schema is one migration with LF line ends (what it builds: legacy-schema.test.ts)", () => {
    expect(legacySchema.migrations.map((m) => [m.version, m.name])).toEqual([[1, "init"]]);
    for (const m of legacySchema.migrations) expect(m.sql).not.toContain("\r");
  });

  it("applies a plugin schema after core, and only its new migrations later", () => {
    const first = openTestDb({ plugins: [{ ...SHOP, migrations: SHOP.migrations.slice(0, 1) }] });
    try {
      expect(first.applied.map((m) => `${m.plugin}:${m.version}`)).toEqual([
        "core:1",
        "core:2",
        "core:3",
        "core:4",
        "core:5",
        "core:6",
        "core:7",
        "shop:1",
      ]);
      const later = migrate(first.db, [SHOP]);
      expect(later.map((m) => `${m.plugin}:${m.version}`)).toEqual(["shop:2"]);
    } finally {
      first.close();
    }
  });

  it("a new file gets incremental auto-vacuum before its first table", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "new.db");
      await (await SqliteStore.open(path)).close();
      const raw = new DatabaseSync(path);
      expect(raw.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
      raw.close();
    }));

  it("a failing migration rolls back with its row and names itself", () => {
    const t = openTestDb();
    try {
      const bad = schema("shop", [
        "CREATE TABLE shop_items (id TEXT PRIMARY KEY) STRICT; INSERT INTO shop_nothing VALUES (1);",
      ]);
      const error = thrown(() => migrate(t.db, [bad]));
      expect(error.code).toBe("failed");
      expect(error.message).toMatch(/shop migration 1 \(step1\) failed/);
      expect(appliedMigrations(t.db).map((m) => m.plugin)).toEqual([
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
      ]);
      expect(t.db.get("SELECT name FROM sqlite_schema WHERE name = 'shop_items'")).toBeUndefined();
    } finally {
      t.close();
    }
  });
});

describe("refusals before any write", () => {
  it("an edited migration: checksum mismatch, and nothing else applied", () =>
    withTempDir((dir) => {
      const path = join(dir, "x.db");
      const db = fileDb(path);
      migrate(db, [{ ...SHOP, migrations: SHOP.migrations.slice(0, 1) }], { location: path });
      const edited: PluginSchema = {
        ...SHOP,
        migrations: [
          {
            ...(SHOP.migrations[0] as PluginSchema["migrations"][number]),
            sql: "CREATE TABLE shop_items (id TEXT) STRICT;",
          },
          SHOP.migrations[1] as PluginSchema["migrations"][number],
        ],
      };
      const error = thrown(() => migrate(db, [edited], { location: path }));
      expect(error.code).toBe("checksum_mismatch");
      expect(error.message).toContain(path);
      expect(error.message).toMatch(/shop migration 1 \(step1\) changed after it was applied/);
      expect(appliedMigrations(db).map((m) => `${m.plugin}:${m.version}`)).toEqual([
        "core:1",
        "core:2",
        "core:3",
        "core:4",
        "core:5",
        "core:6",
        "core:7",
        "shop:1",
      ]);
      db.close();
    }));

  it("a recorded migration missing from the code; an uninstalled plugin is left alone", () => {
    const t = openTestDb({ plugins: [SHOP] });
    try {
      const error = thrown(() =>
        migrate(t.db, [{ ...SHOP, migrations: SHOP.migrations.slice(0, 1) }]),
      );
      expect(error.code).toBe("missing_migration");
      expect(error.message).toMatch(/shop migration 2 \(step2\) was applied but this build/);
      // Without `shop` installed at all, its rows and tables stay and nothing fails.
      expect(migrate(t.db, [])).toEqual([]);
      expect(t.db.get("SELECT name FROM sqlite_schema WHERE name = 'shop_items'")).toBeDefined();
    } finally {
      t.close();
    }
  });

  it("a new migration numbered below one already applied", () => {
    const three = schema("shop", ["CREATE TABLE shop_a (x INTEGER) STRICT;"]);
    const t = openTestDb({
      plugins: [
        {
          ...three,
          migrations: [{ version: 3, name: "c", sql: "CREATE TABLE shop_c (x INTEGER) STRICT;" }],
        },
      ],
    });
    try {
      const error = thrown(() =>
        migrate(t.db, [
          {
            plugin: "shop",
            migrations: [
              { version: 2, name: "b", sql: "CREATE TABLE shop_b (x INTEGER) STRICT;" },
              { version: 3, name: "c", sql: "CREATE TABLE shop_c (x INTEGER) STRICT;" },
            ],
          },
        ]),
      );
      expect(error.code).toBe("out_of_order");
      expect(t.db.get("SELECT name FROM sqlite_schema WHERE name = 'shop_b'")).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it("a database with tables but no `_migrations`", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "other.db");
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE notes (x TEXT)");
      raw.close();
      const before = snapshot(dir);
      await expect(SqliteStore.open(path)).rejects.toThrow(/has tables but no `_migrations`/);
      expect(snapshot(dir)).toEqual(before);
    }));
});

describe("a V4 database (`schema_version`)", () => {
  /** A file shaped like the live V4 database: `schema_version` plus a table with a row. */
  function v4(path: string, wal: boolean): DatabaseSync {
    const raw = new DatabaseSync(path);
    if (wal) raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, " +
        "applied_at INTEGER NOT NULL); INSERT INTO schema_version VALUES (17, '0017_goal_fulfilled', 0); " +
        "CREATE TABLE message_log (id TEXT PRIMARY KEY, text TEXT); " +
        "INSERT INTO message_log VALUES ('m1', 'hello');",
    );
    return raw;
  }

  it("is refused by name, and the file is not changed", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "miyoria.db");
      v4(path, false).close();
      const before = snapshot(dir);
      for (const open of [() => SqliteStore.open(path), () => openStore(`sqlite:${path}`)]) {
        const error = await open().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(SchemaError);
        expect((error as SchemaError).code).toBe("old_database");
        expect((error as SchemaError).message).toContain(path);
        expect((error as SchemaError).message).toMatch(/starts from a new database/);
      }
      expect(snapshot(dir)).toEqual(before);
    }));

  it("is refused while another process has it open in WAL mode, without a checkpoint", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "miyoria.db");
      const live = v4(path, true);
      try {
        live.exec("INSERT INTO message_log VALUES ('m2', 'still in the WAL')");
        expect(existsSync(`${path}-wal`)).toBe(true);
        const db = readFileSync(path);
        const wal = readFileSync(`${path}-wal`);
        await expect(SqliteStore.open(path)).rejects.toThrow(/is a V4 database/);
        expect(readFileSync(path).equals(db)).toBe(true);
        expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
        const names = live.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
        expect(names.map((r) => r.name)).not.toContain("_migrations");
      } finally {
        live.close();
      }
    }));

  it("is refused by the runner itself too, before it writes", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    const db = new Db(raw, systemClock);
    try {
      expect(thrown(() => migrate(db, [legacySchema], { location: "x.db" })).code).toBe(
        "old_database",
      );
      expect(raw.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
      expect(
        raw.prepare("SELECT name FROM sqlite_schema WHERE name = '_migrations'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("order", () => {
  it("core, identity, config, then requires with ties by id", () => {
    const ids = orderSchemas([
      schema("c", ["SELECT 1"]),
      schema("b", ["SELECT 1"], ["a"]),
      schema("config", ["SELECT 1"], ["identity"]),
      schema("a", ["SELECT 1"], ["d"]),
      schema("d", ["SELECT 1"]),
      schema("identity", ["SELECT 1"]),
      coreSchema,
    ]).map((s) => s.plugin);
    expect(ids).toEqual(["core", "identity", "config", "c", "d", "a", "b"]);
  });

  it("refuses duplicates, unknown or late requirements, cycles and bad versions", () => {
    const one = (id: string, requires?: string[]) => schema(id, ["SELECT 1"], requires);
    expect(() => orderSchemas([one("a"), one("a")])).toThrow(/declared twice/);
    expect(() => orderSchemas([one("a", ["zz"])])).toThrow(/requires `zz`, which is not installed/);
    expect(() => orderSchemas([one("identity", ["config"]), one("config")])).toThrow(/runs later/);
    expect(() => orderSchemas([one("a", ["b"]), one("b", ["a"]), one("c")])).toThrow(/cycle: a, b/);
    expect(() => orderSchemas([one("Bad-Id")])).toThrow(/schema id/);
    expect(() =>
      orderSchemas([
        {
          plugin: "a",
          migrations: [
            { version: 1, name: "x", sql: "SELECT 1" },
            { version: 1, name: "y", sql: "SELECT 1" },
          ],
        },
      ]),
    ).toThrow(/two migrations 1/);
  });
});

describe("naming lint", () => {
  const identity = schema("identity", ["CREATE TABLE persons (id TEXT PRIMARY KEY) STRICT;"]);

  it("passes prefixed names, shared foreign keys, and ignores comments and strings", () => {
    const ok = schema("shop", [
      "-- CREATE TABLE items (x) is only a comment\n" +
        "CREATE TABLE IF NOT EXISTS shop_items (id TEXT PRIMARY KEY, owner TEXT REFERENCES persons (id), " +
        "note TEXT DEFAULT 'CREATE TABLE nope (x)') STRICT;\n" +
        "CREATE UNIQUE INDEX shop_items_owner_idx ON shop_items (owner);\n" +
        "CREATE VIRTUAL TABLE shop_fts USING fts5 (name);\n" +
        "CREATE TRIGGER \"shop_items_ro\" BEFORE UPDATE ON shop_items BEGIN SELECT RAISE(ABORT, 'no'); END;\n" +
        "CREATE VIEW shop_v AS SELECT * FROM shop_items;",
    ]);
    expect(lintSchemas(orderSchemas([coreSchema, identity, ok]))).toEqual([]);
    expect(lintSchemas([legacySchema])).toEqual([]);
  });

  it("names every unprefixed name, foreign table and cross-plugin key", () => {
    const other = schema("other", ["CREATE TABLE other_things (id TEXT PRIMARY KEY) STRICT;"]);
    const bad = schema("shop", [
      "CREATE TABLE items (id TEXT PRIMARY KEY, thing TEXT REFERENCES other_things (id)) STRICT;",
      "CREATE INDEX shop_idx ON other_things (id); ALTER TABLE people ADD COLUMN x TEXT;",
      "ALTER TABLE shop_a RENAME TO a; DROP VIEW IF EXISTS message_log_v;",
    ]);
    const problems = lintSchemas(orderSchemas([coreSchema, identity, other, bad]));
    expect(problems).toEqual([
      "shop migration 1 (step1) creates `items`, which must start with `shop_`",
      "shop migration 1 (step1) has a foreign key to `other_things`; only its own, core and identity tables may be referenced",
      "shop migration 2 (step2) changes `people`, which it does not own",
      "shop migration 2 (step2) changes `other_things`, which it does not own",
      "shop migration 3 (step3) creates `a`, which must start with `shop_`",
      "shop migration 3 (step3) changes `message_log_v`, which it does not own",
    ]);
    const t = openTestDb();
    try {
      const error = thrown(() => migrate(t.db, [other, bad]));
      expect(error.code).toBe("lint");
      expect(appliedMigrations(t.db).map((m) => m.plugin)).toEqual([
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
      ]);
    } finally {
      t.close();
    }
  });
});

describe("identity v2 (places) on a v1 database", () => {
  const IDENTITY_TABLES = [
    "persons",
    "accounts",
    "link_codes",
    "spaces",
    "rooms",
    "sessions",
    "space_members",
  ];
  const V1: PluginSchema = { ...identitySchema, migrations: identitySchema.migrations.slice(0, 1) };

  /** A database migrated to identity v1 only, with `spaces` guilds and `members[i]` members in each. */
  function v1Database(guilds: { left?: boolean; joined: number; members: number }[]): Db {
    const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), {
      now: () => Date.UTC(2026, 10, 14),
    });
    migrate(db, [V1]);
    db.run(
      "INSERT INTO persons (id, name, handle, created_at) VALUES ('p1', 'Owen', 'Owen', 1), ('p2', 'Ann', 'Ann', 2), ('p3', 'Bo', 'Bo', 3)",
    );
    db.run(
      `INSERT INTO accounts (id, platform, external_id, person_id, display_name, first_seen, last_seen)
       VALUES ('a1', 'discord', '1', 'p1', 'Owen', 1, 1), ('a2', 'discord', '2', 'p2', 'Ann', 2, 2),
              ('a3', 'discord', '3', 'p3', 'Bo', 3, 3)`,
    );
    db.run("INSERT INTO link_codes VALUES ('h', 'a1', 9)");
    guilds.forEach((g, i) => {
      const id = `s${i + 1}`;
      db.run(
        "INSERT INTO spaces (id, platform, external_id, name, joined_at, left_at) VALUES ($id, 'discord', $ext, $name, $joined, $left)",
        {
          id,
          ext: `g${i + 1}`,
          name: `Guild ${i + 1}`,
          joined: g.joined,
          left: g.left ? 50 : null,
        },
      );
      db.run(
        "INSERT INTO rooms (id, platform, external_id, space_id, kind, created_at) VALUES ($id, 'discord', $ext, $space, 'text', 1)",
        { id: `r${i + 1}`, ext: `c${i + 1}`, space: id },
      );
      db.run(
        "INSERT INTO sessions (key, space_id, room_id, created_at, last_at) VALUES ($key, $space, $room, 1, 1)",
        { key: `discord:g${i + 1}:c${i + 1}`, space: id, room: `r${i + 1}` },
      );
      for (let m = 1; m <= g.members; m++) {
        db.run(
          "INSERT INTO space_members (space_id, account_id, last_seen) VALUES ($space, $account, 1)",
          { space: id, account: `a${m}` },
        );
      }
    });
    return db;
  }

  function counts(db: Db): Record<string, number> {
    return Object.fromEntries(
      IDENTITY_TABLES.map((t) => [t, Number(db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n)]),
    );
  }

  function primaries(db: Db): string[] {
    return db.all("SELECT id FROM spaces WHERE is_primary = 1").map((r) => String(r.id));
  }

  function upgrade(db: Db): void {
    const before = counts(db);
    const v1 = appliedMigrations(db).find((m) => m.plugin === "identity" && m.version === 1);
    const applied = migrate(db, [identitySchema]);
    expect(applied.map((m) => [m.plugin, m.version])).toEqual([["identity", 2]]);
    expect(counts(db)).toEqual(before);
    // The applied migration is the one that ran: its checksum is unchanged.
    expect(appliedMigrations(db).find((m) => m.plugin === "identity" && m.version === 1)).toEqual(
      v1,
    );
  }

  it("the one server becomes primary, and no row is lost", () => {
    const db = v1Database([{ joined: 10, members: 2 }]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual(["s1"]);
      expect(db.get("SELECT is_primary FROM spaces WHERE id = 's1'")).toEqual({ is_primary: 1 });
    } finally {
      db.close();
    }
  });

  it("with no server, none is primary", () => {
    const db = v1Database([]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("with two servers, the one with the most members she is still in", () => {
    // s1 is older, s2 has more members, s3 has the most but she left it.
    const db = v1Database([
      { joined: 10, members: 1 },
      { joined: 20, members: 2 },
      { joined: 5, members: 3, left: true },
    ]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual(["s2"]);
      // At most one primary.
      expect(() => db.run("UPDATE spaces SET is_primary = 1 WHERE id = 's1'")).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("with two servers of as many members, the older one", () => {
    const db = v1Database([
      { joined: 20, members: 2 },
      { joined: 10, members: 2 },
    ]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual(["s2"]);
    } finally {
      db.close();
    }
  });
});
