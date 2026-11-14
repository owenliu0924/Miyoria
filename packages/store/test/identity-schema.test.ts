// The `identity` schema: its checked-in migration and its Drizzle tables cannot drift apart, and
// the constraints Drizzle declares (or the migration adds) hold in the database.

import { describe, expect, it } from "vitest";
import { createSql, migrated, pendingSql } from "../scripts/schema-sql.js";
import * as tables from "../src/identity/schema.js";
import { coreSchema, identitySchema, lintSchemas, migrate, orderSchemas } from "../src/index.js";

const TABLES = [
  "accounts",
  "link_codes",
  "persons",
  "rooms",
  "sessions",
  "space_members",
  "spaces",
];

describe("identity schema", () => {
  it("is the SQL drizzle-kit generates from the Drizzle tables, STRICT added", async () => {
    // The first migration is the whole schema. When a second one exists, this check moves to
    // `pendingSql` below (what drizzle-kit would still change) plus the index comparison.
    expect(identitySchema.migrations).toHaveLength(1);
    const generated = (await createSql(tables)).join("\n");
    if (identitySchema.migrations[0]?.sql !== generated) {
      // The message is the migration to check in.
      expect.fail(`identity migration 1 differs from the Drizzle tables; generated:\n${generated}`);
    }
  });

  it("migrates into a database drizzle-kit finds nothing to change in", async () => {
    const { raw, db } = migrated(identitySchema);
    try {
      expect(await pendingSql(raw, tables)).toEqual([]);
      // What drizzle-kit does not compare: STRICT, and the text of every index (a partial
      // index's WHERE, an index on an expression).
      const list = raw.prepare("PRAGMA table_list").all() as { name: string; strict: number }[];
      for (const name of TABLES) {
        expect(list.find((t) => t.name === name)?.strict, name).toBe(1);
      }
      // Identity's own: core's event log is in every database.
      const indexes = (
        raw
          .prepare(
            "SELECT name, sql, tbl_name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL",
          )
          .all() as { name: string; sql: string; tbl_name: string }[]
      ).filter((i) => TABLES.includes(i.tbl_name));
      const wanted = (await createSql(tables)).filter((s) => s.startsWith("CREATE"));
      for (const index of indexes) {
        expect(wanted.map((s) => s.trim().replace(/;$/, ""))).toContain(index.sql);
      }
      expect(indexes.map((i) => i.name).sort()).toEqual([
        "accounts_person_idx",
        "persons_handle_idx",
        "rooms_space_idx",
      ]);
    } finally {
      db.close();
    }
  });

  it("passes the naming lint, and re-running is a no-op", () => {
    expect(lintSchemas(orderSchemas([coreSchema, identitySchema]))).toEqual([]);
    const { db } = migrated(identitySchema);
    try {
      expect(migrate(db, [identitySchema])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("holds its constraints: types, checks, keys, the handle ignoring case", () => {
    const { raw, db } = migrated(identitySchema);
    try {
      const person = (id: string, handle: string) =>
        raw
          .prepare("INSERT INTO persons (id, name, handle, created_at) VALUES (?, 'n', ?, 1)")
          .run(id, handle);
      person("p1", "Owen");
      // Unique ignoring case (an index on `handle COLLATE NOCASE`).
      expect(() => person("p2", "owen")).toThrow(/UNIQUE/);
      // STRICT: an integer column takes no text.
      expect(() =>
        raw
          .prepare(
            "INSERT INTO persons (id, name, handle, created_at) VALUES ('p3', 'n', 'x', 'soon')",
          )
          .run(),
      ).toThrow(/cannot store TEXT value in INTEGER column/);
      // A STRICT table's text primary key is NOT NULL (drizzle-kit does not write NOT NULL).
      expect(() =>
        raw
          .prepare("INSERT INTO persons (id, name, handle, created_at) VALUES (NULL, 'n', 'y', 1)")
          .run(),
      ).toThrow(/NOT NULL/);
      // CHECK and foreign keys.
      expect(() =>
        raw
          .prepare("INSERT INTO sessions (key, lane, created_at, last_at) VALUES ('k', 'x', 1, 1)")
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(
            "INSERT INTO accounts (id, platform, external_id, person_id, display_name, first_seen, last_seen) " +
              "VALUES ('a1', 'discord', '1', 'ghost', 'x', 1, 1)",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
      raw
        .prepare(
          "INSERT INTO accounts (id, platform, external_id, person_id, display_name, first_seen, last_seen) " +
            "VALUES ('a1', 'discord', '1', 'p1', 'x', 1, 1)",
        )
        .run();
      // `link_codes` go with their account.
      raw.prepare("INSERT INTO link_codes VALUES ('h', 'a1', 1)").run();
      raw.prepare("DELETE FROM accounts WHERE id = 'a1'").run();
      expect(raw.prepare("SELECT COUNT(*) AS n FROM link_codes").get()).toEqual({ n: 0 });
      // The defaults Drizzle declared.
      expect(raw.prepare("SELECT prefs, legacy FROM persons WHERE id = 'p1'").get()).toEqual({
        prefs: "{}",
        legacy: null,
      });
    } finally {
      db.close();
    }
  });
});
