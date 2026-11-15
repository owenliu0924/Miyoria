// The SQL of a plugin's Drizzle tables, for its `PluginSchema` migrations (docs/design/v5-data.md
// §3.1). drizzle-kit writes the DDL; this adds `STRICT` to every table, which Drizzle cannot
// declare. Tests use the same functions to prove the checked-in migrations and the Drizzle tables
// agree.
//
//   pnpm --filter @miyoria/store schema:sql identity
//
// prints the first migration of a plugin that has none yet, or the next one (what the migrated
// database lacks) for a plugin that has some. Review the output before pasting it: drizzle-kit
// cannot see a partial index's WHERE or an index on an expression, and rebuilds a table to
// change a column, which needs `PRAGMA foreign_keys = OFF` outside the migration's transaction.

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { systemClock } from "@miyoria/types";
import { generateDrizzleJson, generateMigration, pushSchema } from "drizzle-kit/payload/sqlite";
import { artifactSchema } from "../src/artifacts/migrations.js";
import * as artifactTables from "../src/artifacts/schema.js";
import { configSchema } from "../src/config/migrations.js";
import * as configTables from "../src/config/schema.js";
import { Db } from "../src/db.js";
import { identitySchema } from "../src/identity/migrations.js";
import * as identityTables from "../src/identity/schema.js";
import { coreSchema, migrate, type PluginSchema, sqlNames } from "../src/migrate.js";

/** Core's tables and indexes (the event log): in every database, and no plugin's business. */
const CORE_NAMES = new Set(coreSchema.migrations.flatMap((m) => sqlNames(m.sql).created));

/**
 * Whether drizzle-kit's statement drops a table or index that `tables` does not own: core's, or
 * one of another Drizzle plugin's that the migrated database carries because `tables` requires it.
 */
function dropsOthers(statement: string, tables: object): boolean {
  const name = /^DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?[`"]?([^`"\s;]+)/i.exec(
    statement.trim(),
  )?.[1];
  if (name === undefined) return false;
  if (CORE_NAMES.has(name)) return true;
  return Object.values(DRIZZLE_PLUGINS).some(
    (other) =>
      other.tables !== tables &&
      other.schema.migrations.some((m) => sqlNames(m.sql).created.includes(name)),
  );
}

/** The Drizzle tables of each plugin that declares its tables with Drizzle. */
export const DRIZZLE_PLUGINS: Record<string, { tables: object; schema: PluginSchema }> = {
  identity: { tables: identityTables, schema: identitySchema },
  config: { tables: configTables, schema: configSchema },
  artifact: { tables: artifactTables, schema: artifactSchema },
};

/** `CREATE TABLE ... );` as `CREATE TABLE ... ) STRICT;`. */
export function strict(statement: string): string {
  return statement.replace(/^(CREATE TABLE [\s\S]*\n\));(\s*)$/, "$1 STRICT;$2");
}

/**
 * A schema module's exports in name order. drizzle-kit emits indexes in the order it is given
 * them, and a module namespace is sorted by name under Node but in declaration order under
 * Vitest: without this, the same tables give two different migrations.
 */
function sorted(tables: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tables).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The statements that create `tables` in an empty database, `STRICT` added. */
export async function createSql(tables: object): Promise<string[]> {
  const empty = await generateDrizzleJson({});
  const current = await generateDrizzleJson(sorted(tables));
  return (await generateMigration(empty, current)).map((s) => `${strict(s.trim())}\n`);
}

/** A drizzle-kit client over one `node:sqlite` connection. */
function kitClient(raw: DatabaseSync) {
  return {
    query: async <T>(query: string, params: unknown[] = []) =>
      raw.prepare(query).all(...(params as never[])) as T[],
    run: async (query: string) => raw.exec(query),
    batch: async (queries: string[]) => {
      for (const q of queries) raw.exec(q);
    },
  };
}

/**
 * What drizzle-kit would change in `raw` to match `tables` (empty when they agree, as far as
 * drizzle-kit can see: not `STRICT`, not a partial index's WHERE, not an expression index).
 */
export async function pendingSql(raw: DatabaseSync, tables: object): Promise<string[]> {
  // `_migrations` is the runner's, the event log is core's, and a required plugin's tables are
  // its own; drizzle-kit would drop them as tables it does not know.
  const result = await pushSchema(sorted(tables), kitClient(raw), { table: "_migrations" });
  return result.sqlStatements.filter((s) => !dropsOthers(s, tables));
}

/**
 * A `:memory:` database with `core`, the Drizzle schemas `schema` requires, and `schema` applied
 * from the checked-in migrations.
 */
export function migrated(schema: PluginSchema): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const db = new Db(raw, systemClock);
  const required = Object.values(DRIZZLE_PLUGINS)
    .map((entry) => entry.schema)
    .filter((s) => schema.requires?.includes(s.plugin));
  migrate(db, [...required, schema]);
  return { raw, db };
}

async function main(plugin: string | undefined): Promise<void> {
  const entry = plugin === undefined ? undefined : DRIZZLE_PLUGINS[plugin];
  if (entry === undefined) {
    const known = Object.keys(DRIZZLE_PLUGINS).join(", ");
    throw new Error(`usage: schema-sql <plugin>; plugins with Drizzle tables: ${known}`);
  }
  if (entry.schema.migrations.length === 0) {
    process.stdout.write((await createSql(entry.tables)).join("\n"));
    return;
  }
  const { raw, db } = migrated(entry.schema);
  try {
    const pending = await pendingSql(raw, entry.tables);
    process.stdout.write(pending.length === 0 ? "-- up to date\n" : `${pending.join("\n")}\n`);
  } finally {
    db.close();
  }
}

const entryFile = process.argv[1];
if (entryFile !== undefined && import.meta.url === pathToFileURL(entryFile).href) {
  await main(process.argv[2]);
}
