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
import { Db } from "../src/db.js";
import { identitySchema } from "../src/identity/migrations.js";
import * as identityTables from "../src/identity/schema.js";
import { migrate, type PluginSchema } from "../src/migrate.js";

/** The Drizzle tables of each plugin that declares its tables with Drizzle. */
export const DRIZZLE_PLUGINS: Record<string, { tables: object; schema: PluginSchema }> = {
  identity: { tables: identityTables, schema: identitySchema },
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
  // `_migrations` is the runner's; drizzle-kit would drop it as a table it does not know.
  const result = await pushSchema(sorted(tables), kitClient(raw), { table: "_migrations" });
  return result.sqlStatements;
}

/** A `:memory:` database with `core` and `schema` applied from the checked-in migrations. */
export function migrated(schema: PluginSchema): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const db = new Db(raw, systemClock);
  migrate(db, [schema]);
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
