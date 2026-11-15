// SQLite backend on the built-in `node:sqlite` (`DatabaseSync`). A file database or `:memory:`
// (for tests and quick runs).
//
// Every call is synchronous inside an async method, so one call never interleaves with another
// in this process: read-modify-write sequences run inside one `BEGIN IMMEDIATE` transaction
// without awaiting. Other processes on the same file are handled by WAL and the busy timeout.
//
// Timestamps are INTEGER microseconds since the epoch, JSON values are text, embeddings are
// little-endian float32 BLOBs (cosine computed in JS), full text uses FTS5 over `tokens`.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  type JsonObject,
  type PersonId,
  type ProfileId,
  systemClock,
  type Timestamp,
} from "@miyoria/types";
import { artifactSchema } from "./artifacts/migrations.js";
import { ArtifactStore } from "./artifacts/store.js";
import {
  canonicalMemoryScope,
  cleanEmbedding,
  contextLookupKey,
  decodeEmbedding,
  encodeEmbedding,
  fromMicros,
  lazyEmbedding,
  memoryKind,
  memoryOrigin,
  memoryScopeKey,
  memorySourceJson,
  optionalMicros,
  optionalTimestamp,
  parseJson,
  queryTokens,
  StoreError,
  sourceEvents,
  sqlLimit,
  toMicros,
  u32,
} from "./common.js";
import {
  type ConfigImportOptions,
  type ConfigImportResult,
  importConfigToml,
} from "./config/import.js";
import { configSchema } from "./config/migrations.js";
import { PersonaOverrides } from "./config/persona.js";
import { PlaceSettings } from "./config/places.js";
import { ConfigModuleState, ConfigRevisions } from "./config/revisions.js";
import { PluginState, SettingsState } from "./config/state.js";
import {
  addCount,
  type DataCategoryId,
  type DataExport,
  type DataInventory,
  type PartPresent,
  partPresent,
  readExport,
  readInventory,
  type SqlDialect,
  type Stmt,
  type WipeCounts,
  type WipeOptions,
  wipeStatements,
} from "./data.js";
import { Db, type Params, type Row } from "./db.js";
import { AuditTrail } from "./events/audit.js";
import { ChatLog } from "./events/chat.js";
import { LlmCallTotals } from "./events/llm.js";
import { EventStore } from "./events/log.js";
import { TurnLog } from "./events/turns.js";
import type { PersonHandleDirectory } from "./handles.js";
import {
  IdentityHandles,
  IdentityLinks,
  IdentityPeople,
  PrefsSettings,
} from "./identity/adapters.js";
import { Identity } from "./identity/identity.js";
import { identitySchema } from "./identity/migrations.js";
import { legacySchema } from "./legacy-schema/index.js";
import { checkDatabaseFile, migrate, type PluginSchema, schemaVersions } from "./migrate.js";
import { type PluginContext, RoutedSettings, type StorePlugin } from "./plugin.js";
import type {
  MemberCardRecord,
  MemoryFilter,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  PrunePolicy,
  Relationship,
  RelationshipDelta,
} from "./records.js";
import type {
  IdentityStore,
  MemberCardStore,
  MemoryRecordStore,
  MessageLog,
  PeopleStore,
  PersonaOverrideStore,
  ProfileDataStore,
  RelationshipStore,
  SettingsStore,
  Store,
} from "./stores.js";

export interface SqliteStoreOptions {
  /** Source of "now" for rows stamped by the store (`edited_at`, `first_seen`, ...). */
  clock?: Clock;
  /** How long a write waits for another process's lock. Default 5000 ms. */
  busyTimeoutMs?: number;
  /** Plugin schemas to migrate besides the store's own (`core`, `identity`, `config`, `legacy`). */
  schemas?: readonly PluginSchema[];
  /** Plugins whose tables are migrated at open and whose code is attached (`store.plugin`). */
  plugins?: readonly StorePlugin<unknown>[];
  /**
   * Where the artifact store keeps its bytes. Default: `artifacts` beside a database file; none
   * for `:memory:` (then `artifacts` is `null`).
   */
  artifactRoot?: string | null;
}

// ---- row accessors ----------------------------------------------------------------------

function str(row: Row, column: string): string {
  const v = row[column];
  if (typeof v !== "string") throw new StoreError(`column \`${column}\` is not text`);
  return v;
}

function optStr(row: Row, column: string): string | null {
  const v = row[column];
  return v === null || v === undefined ? null : str(row, column);
}

function num(row: Row, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new StoreError(`column \`${column}\` is not a number`);
}

function optNum(row: Row, column: string): number | null {
  const v = row[column];
  return v === null || v === undefined ? null : num(row, column);
}

function bool(row: Row, column: string): boolean {
  return num(row, column) !== 0;
}

function json<T>(row: Row, column: string, what: string): T {
  return parseJson<T>(str(row, column), what);
}

function ts(row: Row, column: string): Timestamp {
  return fromMicros(num(row, column));
}

function optTs(row: Row, column: string): Timestamp | null {
  return optionalTimestamp(optNum(row, column));
}

function isConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === "number" && (code & 0xff) === 19; // SQLITE_CONSTRAINT
}

/** `null` limits are "no limit", SQLite's `LIMIT -1`. */
function limitParam(limit: number): number {
  return sqlLimit(limit) ?? -1;
}

// ---- backend core -----------------------------------------------------------------------

const SQLITE_DIALECT: SqlDialect = {
  startsWith: (column, param) => `substr(${column}, 1, length(${param})) = ${param}`,
  jsonText: (column) => column,
  keyOrder: "key",
  list: (values) => JSON.stringify(values),
  bool: (value) => (value ? 1 : 0),
};

// ---- member cards -------------------------------------------------------------------------

function memberCardFromRow(row: Row): MemberCardRecord {
  return {
    serial: str(row, "serial"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    person: optStr(row, "person_id"),
    issued_at: ts(row, "issued_at"),
    snapshot: json<JsonObject>(row, "snapshot", "member card"),
  };
}

/** `(author_platform = … AND author_id = …) OR …` over `accounts`, its parameters added to `params`. */
function authorsWhere(accounts: readonly AccountRef[], params: Params): string {
  return accounts
    .map((a, i) => {
      params[`p${i}`] = a.platform;
      params[`a${i}`] = a.id;
      return `(author_platform = $p${i} AND author_id = $a${i})`;
    })
    .join(" OR ");
}

class SqliteMemberCards implements MemberCardStore {
  constructor(private readonly db: Db) {}

  async issue(card: MemberCardRecord): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO member_cards (serial, profile_id, author_platform, author_id, person_id, " +
          "issued_at, snapshot) VALUES ($serial, $profile, $platform, $id, $person, $at, $snapshot)",
        {
          serial: card.serial,
          profile: card.profile,
          platform: card.account.platform,
          id: card.account.id,
          person: card.person,
          at: toMicros(card.issued_at),
          snapshot: JSON.stringify(card.snapshot),
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`member card \`${card.serial}\` already exists`, { cause });
      }
      throw new StoreError("cannot store the member card", { cause });
    }
  }

  async bySerial(profile: ProfileId, serial: string): Promise<MemberCardRecord | null> {
    const row = this.db.get(
      "SELECT * FROM member_cards WHERE profile_id = $profile AND serial = $serial",
      { profile, serial },
    );
    return row ? memberCardFromRow(row) : null;
  }

  async amend(profile: ProfileId, serial: string, snapshot: JsonObject): Promise<boolean> {
    const changed = this.db.run(
      "UPDATE member_cards SET snapshot = $snapshot WHERE profile_id = $profile AND serial = $serial",
      { profile, serial, snapshot: JSON.stringify(snapshot) },
    );
    return changed > 0;
  }

  async listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<MemberCardRecord[]> {
    if (accounts.length === 0) return [];
    const params: Params = { profile, limit: limitParam(limit) };
    const rows = this.db.all(
      `SELECT * FROM member_cards WHERE profile_id = $profile AND (${authorsWhere(accounts, params)}) ` +
        "ORDER BY issued_at DESC, rowid DESC LIMIT $limit",
      params,
    );
    return rows.map(memberCardFromRow);
  }

  async countSince(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    since: Timestamp,
  ): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile, since: toMicros(since) };
    const row = this.db.get(
      "SELECT COUNT(*) AS n FROM member_cards WHERE profile_id = $profile AND " +
        `issued_at >= $since AND (${authorsWhere(accounts, params)})`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  async countFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT COUNT(*) AS n FROM member_cards WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  async deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    return this.db.run(
      "DELETE FROM member_cards WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
  }
}

// ---- whole-profile export / wipe ----------------------------------------------------------

class SqliteProfileData implements ProfileDataStore {
  constructor(
    private readonly db: Db,
    private readonly modules: ConfigModuleState,
  ) {}

  #query = async (stmt: Stmt) => this.db.allStmt(stmt);

  /** The parts whose tables exist: a plugin's are there once it is installed. */
  #present(): PartPresent {
    const rows = this.db.all("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')");
    return partPresent(new Set(rows.map((r) => String(r.name))));
  }

  async inventory(profile: ProfileId): Promise<DataInventory> {
    const now = fromMicros(this.db.nowMicros());
    return readInventory(SQLITE_DIALECT, this.#query, profile, now, this.#present());
  }

  async export(profile: ProfileId, categories: readonly DataCategoryId[]): Promise<DataExport> {
    const now = fromMicros(this.db.nowMicros());
    return readExport(SQLITE_DIALECT, this.#query, profile, categories, now, this.#present());
  }

  async wipe(
    profile: ProfileId,
    categories: readonly DataCategoryId[],
    options: WipeOptions = {},
  ): Promise<WipeCounts> {
    const statements = wipeStatements(
      SQLITE_DIALECT,
      profile,
      categories,
      options,
      this.#present(),
    );
    try {
      return this.db.tx(() => {
        const counts: WipeCounts = {};
        for (const step of statements) {
          const n = step.stmt === null ? this.modules.clear("wipe") : this.db.runStmt(step.stmt);
          addCount(counts, step.part, n);
        }
        return counts;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot wipe the profile data", { cause });
    }
  }
}

// ---- memory records -----------------------------------------------------------------------

function memoryFromRow(row: Row): MemoryRecord {
  const embedding = row.embedding;
  const sourceContext = optStr(row, "source_context");
  const source = optStr(row, "source");
  const record: MemoryRecord = {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    kind: memoryKind(str(row, "kind")),
    scope: json<MemoryScope>(row, "scope", "memory scope"),
    subjects: json<PersonId[]>(row, "subjects", "memory subjects"),
    content: str(row, "content"),
    tokens: str(row, "tokens"),
    embedding: null,
    importance: num(row, "importance"),
    confidence: num(row, "confidence"),
    created_at: ts(row, "created_at"),
    updated_at: ts(row, "updated_at"),
    last_accessed: optTs(row, "last_accessed"),
    access_count: u32(num(row, "access_count")),
    source_context:
      sourceContext === null ? null : parseJson<ContextKey>(sourceContext, "memory source context"),
    source: source === null ? null : parseJson<MemorySource>(source, "memory source"),
    origin: memoryOrigin(str(row, "origin")),
    source_events: sourceEvents(json<unknown>(row, "source_events", "memory source events")),
    due: optTs(row, "due"),
    done: bool(row, "done"),
    superseded_by: optStr(row, "superseded_by"),
  };
  return embedding instanceof Uint8Array
    ? lazyEmbedding(record, () => decodeEmbedding(embedding))
    : record;
}

/** An FTS5 query string matching any of the tokens (each one a quoted phrase). */
function ftsMatch(tokens: readonly string[]): string {
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

const SEARCH_FILTER =
  "m.profile_id = $profile AND m.scope_key IN (SELECT value FROM json_each($scopes)) " +
  "AND ($kinds IS NULL OR m.kind IN (SELECT value FROM json_each($kinds))) " +
  "AND m.superseded_by IS NULL";

/** What `list` and `count` select (`listParams`). */
const LIST_FILTER =
  "profile_id = $profile " +
  "AND ($subject IS NULL OR EXISTS (SELECT 1 FROM json_each(subjects) WHERE value = " +
  "$subject)) AND ($scope IS NULL OR scope_key = $scope) " +
  "AND ($kind IS NULL OR kind = $kind) AND ($before IS NULL OR created_at < $before) " +
  "AND ($all = 1 OR superseded_by IS NULL)";

function listParams(profile: ProfileId, filter: MemoryFilter): Params {
  return {
    profile,
    subject: filter.subject,
    scope: filter.scope === null ? null : memoryScopeKey(filter.scope),
    kind: filter.kind,
    before: optionalMicros(filter.before),
    all: filter.include_superseded ? 1 : 0,
  };
}

/** What vector search needs of a record, its vector decoded once. */
interface VectorRow {
  seq: number;
  id: string;
  /** Microseconds, as stored. */
  created_at: number;
  scope_key: string;
  kind: string;
  values: Float32Array;
  /** `sqrt` of the sum of squares of `values`. */
  norm: number;
}

interface Scored {
  row: VectorRow;
  score: number;
}

/** Profiles and dimensions whose vectors are kept at once. */
const VECTOR_SETS = 4;

/** Higher score first, then newest, then id descending. */
function scoredBefore(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.row.created_at !== b.row.created_at) return b.row.created_at - a.row.created_at;
  return a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0;
}

/**
 * The first `k` of `items` in `before` order (all of them when `k` is null), without sorting
 * the rest: what `sort(before).slice(0, k)` gives, for an order with no ties.
 */
function firstK(items: Iterable<Scored>, k: number | null): Scored[] {
  if (k === null) return [...items].sort(scoredBefore);
  const best: Scored[] = [];
  for (const item of items) {
    if (best.length === k && scoredBefore(item, best[k - 1] as Scored) >= 0) continue;
    let lo = 0;
    let hi = best.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (scoredBefore(best[mid] as Scored, item) <= 0) lo = mid + 1;
      else hi = mid;
    }
    best.splice(lo, 0, item);
    if (best.length > k) best.pop();
  }
  return best;
}

class SqliteMemories implements MemoryRecordStore {
  /**
   * Decoded vectors of the live records, per profile and dimension, valid while
   * `memory_vector_version` (bumped by triggers on every relevant write, by anyone) is `version`.
   */
  readonly #vectors = new Map<string, VectorRow[]>();
  #vectorVersion: number | null = null;

  constructor(private readonly db: Db) {}

  /** The live records of `profile` with a vector of `dims` values, from memory when unchanged. */
  #vectorRows(profile: ProfileId, dims: number): VectorRow[] {
    const row = this.db.get("SELECT n FROM memory_vector_version WHERE id = 1", {});
    const version = row ? num(row, "n") : null;
    if (version === null || version !== this.#vectorVersion) {
      this.#vectors.clear();
      this.#vectorVersion = version;
    }
    const key = `${profile}\n${dims}`;
    const cached = this.#vectors.get(key);
    if (cached !== undefined) {
      // Most recently used last.
      this.#vectors.delete(key);
      this.#vectors.set(key, cached);
      return cached;
    }
    const rows = this.db.all(
      "SELECT seq, id, created_at, scope_key, kind, embedding FROM memory_records " +
        "WHERE profile_id = $profile AND superseded_by IS NULL AND embedding IS NOT NULL " +
        "AND length(embedding) = $bytes",
      { profile, bytes: dims * 4 },
    );
    const out = rows.map((r): VectorRow => {
      const values = decodeEmbedding(r.embedding as Uint8Array);
      let squares = 0;
      for (let i = 0; i < values.length; i++) {
        const x = values[i] as number;
        squares += x * x;
      }
      return {
        seq: num(r, "seq"),
        id: str(r, "id"),
        created_at: num(r, "created_at"),
        scope_key: str(r, "scope_key"),
        kind: str(r, "kind"),
        values,
        norm: Math.sqrt(squares),
      };
    });
    // Inside a transaction the counter may be rolled back to a number another write then reuses.
    if (version !== null && !this.db.inTransaction) {
      this.#vectors.set(key, out);
      const oldest = this.#vectors.keys().next().value;
      if (this.#vectors.size > VECTOR_SETS && oldest !== undefined) this.#vectors.delete(oldest);
    }
    return out;
  }

  async upsert(record: MemoryRecord): Promise<void> {
    const embedding = cleanEmbedding(record.embedding);
    const scope = canonicalMemoryScope(record.scope);
    try {
      this.db.run(
        "INSERT INTO memory_records (id, profile_id, kind, scope, scope_key, subjects, " +
          "content, tokens, embedding, importance, confidence, created_at, updated_at, " +
          "last_accessed, access_count, source_context, source, origin, source_events, due, done, " +
          "superseded_by) " +
          "VALUES ($id, $profile, $kind, $scope, $scope_key, $subjects, $content, $tokens, " +
          "$embedding, $importance, $confidence, $created_at, $updated_at, $last_accessed, " +
          "$access_count, $source_context, $source, $origin, $source_events, $due, $done, " +
          "$superseded_by) " +
          "ON CONFLICT (id) DO UPDATE SET " +
          "profile_id = excluded.profile_id, kind = excluded.kind, scope = excluded.scope, " +
          "scope_key = excluded.scope_key, subjects = excluded.subjects, content = " +
          "excluded.content, tokens = excluded.tokens, embedding = excluded.embedding, " +
          "importance = excluded.importance, confidence = excluded.confidence, created_at = " +
          "excluded.created_at, updated_at = excluded.updated_at, last_accessed = " +
          "excluded.last_accessed, access_count = excluded.access_count, source_context = " +
          "excluded.source_context, source = excluded.source, origin = excluded.origin, " +
          "source_events = excluded.source_events, due = excluded.due, " +
          "done = excluded.done, superseded_by = excluded.superseded_by",
        {
          id: record.id,
          profile: record.profile,
          kind: memoryKind(record.kind),
          scope: JSON.stringify(scope),
          scope_key: JSON.stringify(scope),
          subjects: JSON.stringify(record.subjects),
          content: record.content,
          tokens: record.tokens,
          embedding: embedding === null ? null : encodeEmbedding(embedding),
          importance: record.importance,
          confidence: record.confidence,
          created_at: toMicros(record.created_at),
          updated_at: toMicros(record.updated_at),
          last_accessed: optionalMicros(record.last_accessed),
          access_count: u32(record.access_count),
          source_context:
            record.source_context === null ? null : contextLookupKey(record.source_context),
          source: memorySourceJson(record.source),
          origin: memoryOrigin(record.origin ?? "unknown"),
          source_events: JSON.stringify(sourceEvents(record.source_events)),
          due: optionalMicros(record.due),
          done: record.done ? 1 : 0,
          superseded_by: record.superseded_by,
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store memory record", { cause });
    }
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = this.db.get("SELECT * FROM memory_records WHERE id = $id", { id });
    return row ? memoryFromRow(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    return this.db.run("DELETE FROM memory_records WHERE id = $id", { id }) > 0;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const embedding = cleanEmbedding(query.embedding);
    const limit = sqlLimit(query.limit);
    if (limit === 0) return [];
    const filter = {
      profile: query.profile,
      scopes: JSON.stringify(query.scopes.map(memoryScopeKey)),
      kinds: query.kinds === null ? null : JSON.stringify(query.kinds),
    };
    const hits: MemoryHit[] = [];

    // Full text: OR of the tokens; relevance is FTS5's BM25 (negated, so higher is better).
    const tokens = queryTokens(query.tokens);
    if (tokens.length > 0) {
      let rows: Row[];
      try {
        rows = this.db.all(
          "SELECT m.*, -bm25(memory_fts) AS score FROM memory_fts " +
            "JOIN memory_records m ON m.seq = memory_fts.rowid " +
            `WHERE memory_fts MATCH $match AND ${SEARCH_FILTER} ` +
            "ORDER BY score DESC, m.created_at DESC, m.id DESC LIMIT $limit",
          { ...filter, match: ftsMatch(tokens), limit: limit ?? -1 },
        );
      } catch (cause) {
        if (cause instanceof StoreError) throw cause;
        throw new StoreError("memory text search failed", { cause });
      }
      for (const row of rows) {
        hits.push({
          record: memoryFromRow(row),
          text_score: num(row, "score"),
          vector_score: null,
        });
      }
    }

    // Nearest neighbours: exact cosine over the rows with the query's dimension, their vectors
    // kept decoded between searches (`#vectorRows`). The whole row is read only for the ones kept.
    if (embedding !== null) {
      const query32 = Float32Array.from(embedding);
      let squares = 0;
      for (let i = 0; i < query32.length; i++) {
        const y = query32[i] as number;
        squares += y * y;
      }
      const queryNorm = Math.sqrt(squares);
      const scopes = new Set(query.scopes.map(memoryScopeKey));
      const kinds = query.kinds === null ? null : new Set<string>(query.kinds);
      const rows = this.#vectorRows(query.profile, query32.length);
      const candidates = function* (): Generator<Scored> {
        for (const row of rows) {
          if (!scopes.has(row.scope_key) || (kinds !== null && !kinds.has(row.kind))) continue;
          const v = row.values;
          let dot = 0;
          for (let i = 0; i < v.length; i++) dot += (v[i] as number) * (query32[i] as number);
          // As `cosine` computes it.
          const score = row.norm === 0 || queryNorm === 0 ? 0 : dot / (row.norm * queryNorm);
          yield { row, score };
        }
      };
      const scored = firstK(candidates(), limit);
      const byId = new Map(hits.map((h) => [h.record.id, h]));
      const missing = scored.filter(({ row }) => !byId.has(row.id));
      const full = new Map<number, Row>();
      if (missing.length > 0) {
        const fullRows = this.db.all(
          "SELECT * FROM memory_records WHERE seq IN (SELECT value FROM json_each($seqs))",
          { seqs: JSON.stringify(missing.map(({ row }) => row.seq)) },
        );
        for (const row of fullRows) full.set(num(row, "seq"), row);
      }
      for (const { row, score } of scored) {
        const hit = byId.get(row.id);
        if (hit) {
          hit.vector_score = score;
          continue;
        }
        const whole = full.get(row.seq);
        if (whole) hits.push({ record: memoryFromRow(whole), text_score: 0, vector_score: score });
      }
    }
    return hits;
  }

  async list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]> {
    const rows = this.db.all(
      `SELECT * FROM memory_records WHERE ${LIST_FILTER} ` +
        "ORDER BY created_at DESC, id DESC LIMIT $limit",
      { ...listParams(profile, filter), limit: limitParam(filter.limit) },
    );
    return rows.map(memoryFromRow);
  }

  async count(profile: ProfileId, filter: MemoryFilter): Promise<number> {
    const row = this.db.get(
      `SELECT count(*) AS n FROM memory_records WHERE ${LIST_FILTER}`,
      listParams(profile, filter),
    );
    return row ? num(row, "n") : 0;
  }

  async listAbout(
    profile: ProfileId,
    people: readonly PersonId[],
    limitEach: number,
  ): Promise<MemoryRecord[]> {
    const limit = sqlLimit(limitEach);
    if (people.length === 0 || limit === 0) return [];
    // One pass over the profile's rows (there is no index on `subjects`), not one per person.
    const rows = this.db.all(
      "WITH about AS (SELECT DISTINCT m.seq, m.created_at, m.id, p.value AS person " +
        "FROM memory_records m, json_each(m.subjects) p WHERE m.profile_id = $profile " +
        "AND m.superseded_by IS NULL AND p.value IN (SELECT value FROM json_each($people))), " +
        "ranked AS (SELECT seq, row_number() OVER (PARTITION BY person " +
        "ORDER BY created_at DESC, id DESC) AS rn FROM about) " +
        "SELECT * FROM memory_records WHERE seq IN " +
        "(SELECT seq FROM ranked WHERE $limit IS NULL OR rn <= $limit) " +
        "ORDER BY created_at DESC, id DESC",
      { profile, people: JSON.stringify([...new Set(people)]), limit },
    );
    return rows.map(memoryFromRow);
  }

  async missingEmbeddings(profile: ProfileId, limit: number): Promise<MemoryRecord[]> {
    const rows = this.db.all(
      "SELECT * FROM memory_records WHERE profile_id = $profile AND embedding IS NULL " +
        "AND superseded_by IS NULL ORDER BY created_at DESC, id DESC LIMIT $limit",
      { profile, limit: limitParam(limit) },
    );
    return rows.map(memoryFromRow);
  }

  async touch(ids: readonly string[], at: Timestamp): Promise<void> {
    if (ids.length === 0) return;
    this.db.run(
      "UPDATE memory_records SET access_count = min(access_count + 1, 4294967295), " +
        "last_accessed = $at WHERE id IN (SELECT value FROM json_each($ids))",
      { ids: JSON.stringify([...new Set(ids)]), at: toMicros(at) },
    );
  }

  async dueFollowups(
    profile: ProfileId,
    now: Timestamp,
    maxAgeMs: number | null = null,
  ): Promise<MemoryRecord[]> {
    const rows = this.db.all(
      "SELECT * FROM memory_records WHERE profile_id = $profile AND kind = 'followup' AND " +
        "NOT done AND due IS NOT NULL AND superseded_by IS NULL AND due <= $now AND " +
        "($since IS NULL OR due >= $since) ORDER BY due DESC, id DESC",
      {
        profile,
        now: toMicros(now),
        since: maxAgeMs === null ? null : toMicros(now) - Math.round(maxAgeMs * 1000),
      },
    );
    return rows.map(memoryFromRow);
  }

  async expireFollowups(profile: ProfileId, dueBefore: Timestamp): Promise<number> {
    return this.db.run(
      "UPDATE memory_records SET done = 1 WHERE profile_id = $profile AND kind = 'followup' " +
        "AND NOT done AND due IS NOT NULL AND due < $before",
      { profile, before: toMicros(dueBefore) },
    );
  }

  async prune(profile: ProfileId, policy: PrunePolicy): Promise<number> {
    return this.db.run(
      "DELETE FROM memory_records WHERE profile_id = $profile AND kind = 'episode' AND " +
        "created_at < $before AND importance <= $max AND (last_accessed IS NULL OR " +
        "last_accessed < $since)",
      {
        profile,
        before: toMicros(policy.created_before),
        max: policy.max_importance,
        since: toMicros(policy.not_accessed_since),
      },
    );
  }

  async deleteBySubject(profile: ProfileId, person: PersonId): Promise<number> {
    return this.db.run(
      "DELETE FROM memory_records WHERE profile_id = $profile AND (EXISTS (SELECT 1 FROM " +
        "json_each(subjects) WHERE value = $person) OR scope_key = $scope)",
      { profile, person, scope: memoryScopeKey({ type: "person", person }) },
    );
  }

  async mergePerson(keep: PersonId, absorb: PersonId): Promise<number> {
    if (keep === absorb) return 0;
    const absorbScope = memoryScopeKey({ type: "person", person: absorb });
    const keepScope = memoryScopeKey({ type: "person", person: keep });
    // `tokens` is untouched, so the FTS triggers do not fire and `seq` (the FTS rowid) stays.
    return this.db.tx(() => {
      const rows = this.db.all(
        "SELECT id, subjects, scope_key FROM memory_records WHERE EXISTS (SELECT 1 FROM " +
          "json_each(subjects) WHERE value = $absorb) OR scope_key = $scope",
        { absorb, scope: absorbScope },
      );
      for (const row of rows) {
        const subjects = json<PersonId[]>(row, "subjects", "memory subjects");
        const moved = [...new Set(subjects.map((s) => (s === absorb ? keep : s)))];
        const rescoped = str(row, "scope_key") === absorbScope;
        this.db.run(
          "UPDATE memory_records SET subjects = $subjects, " +
            "scope = CASE WHEN $rescope THEN $scope ELSE scope END, " +
            "scope_key = CASE WHEN $rescope THEN $scope ELSE scope_key END WHERE id = $id",
          {
            id: str(row, "id"),
            subjects: JSON.stringify(moved),
            rescope: rescoped ? 1 : 0,
            scope: keepScope,
          },
        );
      }
      return rows.length;
    });
  }
}

// ---- relationships ------------------------------------------------------------------------

function relationshipFromRow(row: Row): Relationship {
  return {
    profile: str(row, "profile_id"),
    person: str(row, "person_id"),
    affinity: num(row, "affinity"),
    trust: num(row, "trust"),
    familiarity: num(row, "familiarity"),
    tags: json<string[]>(row, "tags", "relationship tags"),
    notes: str(row, "notes"),
    call_name: optStr(row, "call_name"),
    interactions: u32(num(row, "interactions")),
    last_interaction: optTs(row, "last_interaction"),
    updated_at: ts(row, "updated_at"),
  };
}

class SqliteRelationships implements RelationshipStore {
  constructor(private readonly db: Db) {}

  async get(profile: ProfileId, person: PersonId): Promise<Relationship | null> {
    const row = this.db.get(
      "SELECT * FROM relationships WHERE profile_id = $profile AND person_id = $person",
      { profile, person },
    );
    return row ? relationshipFromRow(row) : null;
  }

  async upsert(r: Relationship): Promise<void> {
    this.db.run(
      "INSERT INTO relationships (profile_id, person_id, affinity, trust, familiarity, tags, " +
        "notes, call_name, interactions, last_interaction, updated_at) VALUES ($profile, " +
        "$person, $affinity, $trust, $familiarity, $tags, $notes, $call_name, $interactions, " +
        "$last_interaction, $updated_at) ON CONFLICT (profile_id, person_id) DO UPDATE SET " +
        "affinity = excluded.affinity, trust = excluded.trust, familiarity = " +
        "excluded.familiarity, tags = excluded.tags, notes = excluded.notes, call_name = " +
        "excluded.call_name, interactions = excluded.interactions, last_interaction = " +
        "excluded.last_interaction, updated_at = excluded.updated_at",
      {
        profile: r.profile,
        person: r.person,
        affinity: r.affinity,
        trust: r.trust,
        familiarity: r.familiarity,
        tags: JSON.stringify(r.tags),
        notes: r.notes,
        call_name: r.call_name,
        interactions: u32(r.interactions),
        last_interaction: optionalMicros(r.last_interaction),
        updated_at: toMicros(r.updated_at),
      },
    );
  }

  async list(profile: ProfileId): Promise<Relationship[]> {
    return this.db
      .all("SELECT * FROM relationships WHERE profile_id = $profile ORDER BY person_id", {
        profile,
      })
      .map(relationshipFromRow);
  }

  async delete(profile: ProfileId, person: PersonId): Promise<boolean> {
    return this.db.tx(() => {
      this.db.run(
        "DELETE FROM relationship_deltas WHERE profile_id = $profile AND person_id = $person",
        { profile, person },
      );
      const removed = this.db.run(
        "DELETE FROM relationships WHERE profile_id = $profile AND person_id = $person",
        { profile, person },
      );
      return removed > 0;
    });
  }

  async recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void> {
    this.db.run(
      "INSERT INTO relationship_deltas (profile_id, person_id, at, affinity, trust, " +
        "familiarity, reason) VALUES ($profile, $person, $at, $affinity, $trust, $familiarity, " +
        "$reason)",
      {
        profile,
        person,
        at: toMicros(delta.at),
        affinity: delta.affinity,
        trust: delta.trust,
        familiarity: delta.familiarity,
        reason: delta.reason,
      },
    );
  }

  async deltasSince(
    profile: ProfileId,
    person: PersonId,
    since: Timestamp,
  ): Promise<RelationshipDelta[]> {
    const rows = this.db.all(
      "SELECT at, affinity, trust, familiarity, reason FROM relationship_deltas WHERE " +
        "profile_id = $profile AND person_id = $person AND at >= $since ORDER BY at, seq",
      { profile, person, since: toMicros(since) },
    );
    return rows.map((r) => ({
      at: ts(r, "at"),
      affinity: num(r, "affinity"),
      trust: num(r, "trust"),
      familiarity: num(r, "familiarity"),
      reason: str(r, "reason"),
    }));
  }
}

// ---- the store ----------------------------------------------------------------------------

/** Every storage area on one SQLite database. */
export class SqliteStore implements Store {
  readonly messages: MessageLog;
  /** Module on/off: the `enabled` flags of the current config revision. */
  readonly moduleState: ConfigModuleState;
  readonly personaOverrides: PersonaOverrideStore;
  readonly people: PeopleStore;
  /** Decisions and turn outcomes on the event log. */
  readonly decisions: TurnLog;
  readonly settings: SettingsStore;
  readonly memories: MemoryRecordStore;
  readonly relationships: RelationshipStore;
  readonly identity: IdentityStore;
  /** Audit entries on the event log. */
  readonly audit: AuditTrail;
  readonly profileData: ProfileDataStore;
  readonly events: EventStore;
  /** Chat lines on the event log; `messages` is the same object. */
  readonly chat: ChatLog;
  /** LLM calls on the event log, as cost and usage totals. */
  readonly llmCalls: LlmCallTotals;
  readonly cards: MemberCardStore;
  /** Persons, accounts and places (the `identity` plugin's tables). */
  readonly persons: Identity;
  /** Config revisions, per-place settings and plugin state (the `config` plugin's tables). */
  readonly config: {
    readonly revisions: ConfigRevisions;
    readonly places: PlaceSettings;
    readonly state: PluginState;
  };
  readonly handles: PersonHandleDirectory;
  /** The files she makes (the `artifact` plugin's tables, bytes under the artifact root). */
  readonly artifacts: ArtifactStore | null;
  readonly #db: Db;
  readonly #location: string;
  /** Every schema migrated on this database by this store (the store's own and plugins'). */
  readonly #schemas: PluginSchema[];
  readonly #settings: RoutedSettings;
  readonly #plugins = new Map<string, { plugin: StorePlugin<unknown>; opened: unknown }>();

  private constructor(
    db: Db,
    artifactRoot: string | null,
    schemas: readonly PluginSchema[],
    location: string,
  ) {
    this.#db = db;
    this.#location = location;
    this.#schemas = [...schemas];
    this.persons = new Identity(db);
    this.events = new EventStore(db, { identity: this.persons });
    this.artifacts =
      artifactRoot === null ? null : new ArtifactStore(db, this.events, { root: artifactRoot });
    const revisions = new ConfigRevisions(db, this.events);
    this.config = {
      revisions,
      places: new PlaceSettings(db, this.events),
      state: new PluginState(db),
    };
    this.moduleState = new ConfigModuleState(db, revisions);
    this.personaOverrides = new PersonaOverrides(db);
    this.people = new IdentityPeople(this.persons);
    this.#settings = new RoutedSettings(new PrefsSettings(new SettingsState(db), this.persons));
    this.settings = this.#settings;
    this.memories = new SqliteMemories(db);
    this.relationships = new SqliteRelationships(db);
    this.identity = new IdentityLinks(this.persons);
    this.handles = new IdentityHandles(this.persons);
    this.profileData = new SqliteProfileData(db, this.moduleState);
    this.chat = new ChatLog(db, this.events, this.persons);
    this.messages = this.chat;
    this.decisions = new TurnLog(db, this.events, this.persons);
    this.audit = new AuditTrail(db, this.events, this.persons);
    this.llmCalls = new LlmCallTotals(db);
    this.cards = new SqliteMemberCards(db);
  }

  /**
   * Opens (creating it and its directory if needed) a database file, or `":memory:"` for a
   * fresh in-memory database, and runs pending migrations. A file this build must not migrate
   * (a V4 database, see `migrate.ts`) is refused before anything is written to it.
   */
  static async open(path: string, options: SqliteStoreOptions = {}): Promise<SqliteStore> {
    const memory = path === ":memory:";
    if (!memory) {
      mkdirSync(dirname(path), { recursive: true });
      checkDatabaseFile(path);
    }
    let raw: DatabaseSync;
    try {
      raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot open the SQLite database", { cause });
    }
    const db = new Db(raw, options.clock ?? systemClock);
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
      if (!memory) {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
      }
      db.exec("PRAGMA foreign_keys = ON");
      const plugins = options.plugins ?? [];
      const schemas = [
        identitySchema,
        configSchema,
        legacySchema,
        artifactSchema,
        ...(options.schemas ?? []),
        ...plugins.map((p) => p.schema),
      ];
      migrate(db, schemas, { location: path });
      const root = options.artifactRoot ?? (memory ? null : join(dirname(path), "artifacts"));
      const store = new SqliteStore(db, root, schemas, path);
      for (const plugin of plugins) store.plugin(plugin);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  plugin<T>(plugin: StorePlugin<T>): T {
    const id = plugin.schema.plugin;
    const attached = this.#plugins.get(id);
    if (attached !== undefined) {
      if (attached.plugin !== plugin) {
        throw new StoreError(`another plugin with the schema \`${id}\` is attached already`);
      }
      return attached.opened as T;
    }
    this.#db.ensureOpen();
    if (!this.#schemas.some((s) => s.plugin === id)) {
      migrate(this.#db, [...this.#schemas, plugin.schema], { location: this.#location });
      this.#schemas.push(plugin.schema);
    }
    const ctx: PluginContext = { db: this.#db, events: this.events, identity: this.persons };
    const opened = plugin.open(ctx);
    for (const family of plugin.settings?.(opened) ?? []) this.#settings.route(family);
    this.#plugins.set(id, { plugin: plugin as StorePlugin<unknown>, opened });
    return opened;
  }

  /**
   * Imports the text of `miyoria.toml` as config revision 1, its per-channel levels as place
   * settings (`config/import.ts`). For the cut-over's first start; once only.
   */
  importConfig(text: string, options: ConfigImportOptions = {}): ConfigImportResult {
    const { revisions, places } = this.config;
    return importConfigToml(
      { db: this.#db, revisions, places, identity: this.persons },
      text,
      options,
    );
  }

  /** Versions of the `legacy` schema recorded in `_migrations`, ascending. */
  async schemaVersions(): Promise<number[]> {
    return schemaVersions(this.#db, legacySchema.plugin);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
