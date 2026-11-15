// The `memory` plugin's tables on the store's database (`schema.ts`): the `MemoryRecordStore` the
// memory engine, the social module's `/me link` and the panel read and write. Core opens the store
// with `memoryTables` and provides `store.plugin(memoryTables)` as `MemoryRecordStoreKey`. Moved
// from the store as it was (docs/design/v5-data.md §8 step 9b): the same queries, ranking and
// vector handling; phase 3 redesigns it.
//
// One database is one character, so the `profile` the interface takes is not part of any key, and
// a record read back carries the profile its read named. `get`, which names none, carries the
// last profile a call on these tables named (in Core always the one character).
//
// The reads recall runs on every turn are prepared once: the full-text and vector halves of
// `search` (with the counter and the whole rows of the vector hits), `touch`, `listAbout`,
// `dueFollowups`, and `list` / `count`. Every read and write runs on the store's connection; a
// merge is one `Db.tx` (a savepoint inside a caller's).

import type {
  Db,
  MemoryFilter,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryRecordStore,
  PrunePolicy,
  StorePlugin,
} from "@miyoria/store";
import { StoreError, toMicros } from "@miyoria/store";
import type { PersonId, ProfileId, Timestamp } from "@miyoria/types";
import { and, desc, eq, getColumns, isNull, lt, type SQL, sql } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { memorySchema } from "./migrations.js";
import { type MemoryRow, memoryRecords, memoryVectorVersion } from "./schema.js";
import {
  canonicalContext,
  canonicalMemoryScope,
  canonicalSource,
  cleanEmbedding,
  decodeEmbedding,
  encodeEmbedding,
  ftsMatch,
  lazyEmbedding,
  limitParam,
  memoryKind,
  memoryOrigin,
  memoryScopeKey,
  queryTokens,
  sourceEvents,
  sqlLimit,
  u32,
} from "./stored.js";

const R = memoryRecords;
const ph = (name: string) => sql.placeholder(name);

/**
 * The full-text index, for queries only: its SQL is hand-written (`migrations.ts`), so it is not
 * in `schema.ts`, which drizzle-kit reads.
 */
const memoryFts = sqliteTable("memory_fts", { rowid: integer() });

function recordOf(profile: ProfileId, row: MemoryRow): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    profile,
    kind: memoryKind(row.kind),
    scope: row.scope,
    subjects: row.subjects,
    content: row.content,
    tokens: row.tokens,
    embedding: null,
    importance: row.importance,
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed: row.last_accessed,
    access_count: u32(row.access_count),
    source_context: row.source_context,
    source: row.source,
    origin: memoryOrigin(row.origin),
    source_events: sourceEvents(row.source_events),
    due: row.due,
    done: row.done,
    superseded_by: row.superseded_by,
  };
  const bytes = row.embedding;
  return bytes instanceof Uint8Array ? lazyEmbedding(record, () => decodeEmbedding(bytes)) : record;
}

/** `subjects` holds the person of placeholder `name`. */
function about(name: string): SQL {
  return sql`EXISTS (SELECT 1 FROM json_each(${R.subjects}) WHERE value = ${ph(name)})`;
}

/** What `search` keeps of both halves: the listed scopes and kinds, never a superseded record. */
const SEARCH_FILTER = sql`${R.scope_key} IN (SELECT value FROM json_each(${ph("scopes")})) AND (${ph("kinds")} IS NULL OR ${R.kind} IN (SELECT value FROM json_each(${ph("kinds")}))) AND ${R.superseded_by} IS NULL`;

/** What `list` and `count` select (`listParams`). */
const LIST_FILTER = sql`(${ph("subject")} IS NULL OR ${about("subject")}) AND (${ph("scope")} IS NULL OR ${R.scope_key} = ${ph("scope")}) AND (${ph("kind")} IS NULL OR ${R.kind} = ${ph("kind")}) AND (${ph("before")} IS NULL OR ${R.created_at} < ${ph("before")}) AND (${ph("all")} = 1 OR ${R.superseded_by} IS NULL)`;

function listParams(filter: MemoryFilter) {
  return {
    subject: filter.subject,
    scope: filter.scope === null ? null : memoryScopeKey(filter.scope),
    kind: filter.kind,
    before: filter.before == null ? null : toMicros(filter.before),
    all: filter.include_superseded ? 1 : 0,
  };
}

/** The columns an upsert replaces: all but the keys. */
const REPLACED = [
  "kind",
  "scope",
  "scope_key",
  "subjects",
  "content",
  "tokens",
  "embedding",
  "importance",
  "confidence",
  "created_at",
  "updated_at",
  "last_accessed",
  "access_count",
  "source_context",
  "source",
  "origin",
  "source_events",
  "due",
  "done",
  "superseded_by",
] as const satisfies readonly (keyof MemoryRow)[];
const UPSERT_SET = Object.fromEntries(REPLACED.map((c) => [c, sql.raw(`excluded.${c}`)])) as Record<
  (typeof REPLACED)[number],
  SQL
>;

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

/** Dimensions whose vectors are kept at once. */
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

function prepared(db: Db) {
  const orm = db.orm;
  const all = getColumns(R);
  return {
    // Full text: OR of the tokens; relevance is FTS5's BM25 (negated, so higher is better).
    text: orm
      .select({ ...all, score: sql<number>`-bm25(${memoryFts})`.mapWith(Number) })
      .from(memoryFts)
      .innerJoin(R, eq(R.seq, memoryFts.rowid))
      .where(sql`${memoryFts} MATCH ${ph("match")} AND ${SEARCH_FILTER}`)
      .orderBy(sql`-bm25(${memoryFts}) DESC`, desc(R.created_at), desc(R.id))
      .limit(ph("limit"))
      .prepare(),
    version: orm
      .select({ n: memoryVectorVersion.n })
      .from(memoryVectorVersion)
      .where(eq(memoryVectorVersion.id, 1))
      .prepare(),
    vectors: orm
      .select({
        seq: R.seq,
        id: R.id,
        created_at: sql<number>`${R.created_at}`.mapWith(Number),
        scope_key: R.scope_key,
        kind: R.kind,
        embedding: R.embedding,
      })
      .from(R)
      .where(
        sql`${R.superseded_by} IS NULL AND ${R.embedding} IS NOT NULL AND length(${R.embedding}) = ${ph("bytes")}`,
      )
      .prepare(),
    bySeq: orm
      .select(all)
      .from(R)
      .where(sql`${R.seq} IN (SELECT value FROM json_each(${ph("seqs")}))`)
      .prepare(),
    touch: orm
      .update(R)
      .set({
        access_count: sql`min(${R.access_count} + 1, 4294967295)`,
        last_accessed: sql`${ph("at")}`,
      })
      .where(sql`${R.id} IN (SELECT value FROM json_each(${ph("ids")}))`)
      .prepare(),
    // One pass over the rows (there is no index on `subjects`), not one per person.
    about: orm
      .select(all)
      .from(R)
      .where(
        sql`${R.seq} IN (SELECT seq FROM (SELECT seq, row_number() OVER (PARTITION BY person ORDER BY created_at DESC, id DESC) AS rn FROM (SELECT DISTINCT m.seq, m.created_at, m.id, p.value AS person FROM memory_records m, json_each(m.subjects) p WHERE m.superseded_by IS NULL AND p.value IN (SELECT value FROM json_each(${ph("people")})))) WHERE ${ph("limit")} IS NULL OR rn <= ${ph("limit")})`,
      )
      .orderBy(desc(R.created_at), desc(R.id))
      .prepare(),
    due: orm
      .select(all)
      .from(R)
      .where(
        sql`${R.kind} = 'followup' AND NOT ${R.done} AND ${R.due} IS NOT NULL AND ${R.superseded_by} IS NULL AND ${R.due} <= ${ph("now")} AND (${ph("since")} IS NULL OR ${R.due} >= ${ph("since")})`,
      )
      .orderBy(desc(R.due), desc(R.id))
      .prepare(),
    list: orm
      .select(all)
      .from(R)
      .where(LIST_FILTER)
      .orderBy(desc(R.created_at), desc(R.id))
      .limit(ph("limit"))
      .prepare(),
    count: orm
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(R)
      .where(LIST_FILTER)
      .prepare(),
  };
}

/** Long-term memory records (`MemoryRecordStore`) on `memory_records` and its full-text index. */
export class MemoryTables implements MemoryRecordStore {
  readonly #db: Db;
  readonly #q: ReturnType<typeof prepared>;
  /**
   * Decoded vectors of the live records, per dimension, valid while `memory_vector_version`
   * (bumped by triggers on every relevant write, by anyone) is `version`.
   */
  readonly #vectors = new Map<number, VectorRow[]>();
  #vectorVersion: number | null = null;
  /** The profile the last call named: what `get` reports (see the file comment). */
  #profile: ProfileId = "";

  constructor(db: Db) {
    this.#db = db;
    this.#q = prepared(db);
  }

  /** Remembers the profile a call names, and checks the store is open for a prepared query. */
  #named(profile: ProfileId): ProfileId {
    this.#db.ensureOpen();
    this.#profile = profile;
    return profile;
  }

  /** The live records with a vector of `dims` values, from memory when unchanged. */
  #vectorRows(dims: number): VectorRow[] {
    const row = this.#q.version.get();
    const version = row ? Number(row.n) : null;
    if (version === null || version !== this.#vectorVersion) {
      this.#vectors.clear();
      this.#vectorVersion = version;
    }
    const cached = this.#vectors.get(dims);
    if (cached !== undefined) {
      // Most recently used last.
      this.#vectors.delete(dims);
      this.#vectors.set(dims, cached);
      return cached;
    }
    const out = this.#q.vectors.all({ bytes: dims * 4 }).map((r): VectorRow => {
      const values = decodeEmbedding(r.embedding as Uint8Array);
      let squares = 0;
      for (let i = 0; i < values.length; i++) {
        const x = values[i] as number;
        squares += x * x;
      }
      return {
        seq: r.seq,
        id: r.id,
        created_at: r.created_at,
        scope_key: r.scope_key,
        kind: r.kind,
        values,
        norm: Math.sqrt(squares),
      };
    });
    // Inside a transaction the counter may be rolled back to a number another write then reuses.
    if (version !== null && !this.#db.inTransaction) {
      this.#vectors.set(dims, out);
      const oldest = this.#vectors.keys().next().value;
      if (this.#vectors.size > VECTOR_SETS && oldest !== undefined) this.#vectors.delete(oldest);
    }
    return out;
  }

  async upsert(record: MemoryRecord): Promise<void> {
    const embedding = cleanEmbedding(record.embedding);
    const scope = canonicalMemoryScope(record.scope);
    try {
      this.#named(record.profile);
      this.#db.orm
        .insert(R)
        .values({
          id: record.id,
          kind: memoryKind(record.kind),
          scope,
          scope_key: JSON.stringify(scope),
          subjects: record.subjects,
          content: record.content,
          tokens: record.tokens,
          embedding: embedding === null ? null : encodeEmbedding(embedding),
          importance: record.importance,
          confidence: record.confidence,
          created_at: record.created_at,
          updated_at: record.updated_at,
          last_accessed: record.last_accessed ?? null,
          access_count: u32(record.access_count),
          source_context:
            record.source_context === null ? null : canonicalContext(record.source_context),
          source: canonicalSource(record.source),
          origin: memoryOrigin(record.origin ?? "unknown"),
          source_events: sourceEvents(record.source_events),
          due: record.due ?? null,
          done: record.done,
          superseded_by: record.superseded_by,
        })
        .onConflictDoUpdate({ target: R.id, set: UPSERT_SET })
        .run();
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store memory record", { cause });
    }
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = this.#db.orm.select().from(R).where(eq(R.id, id)).get();
    return row ? recordOf(this.#profile, row) : null;
  }

  async delete(id: string): Promise<boolean> {
    return Number(this.#db.orm.delete(R).where(eq(R.id, id)).run().changes) > 0;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const embedding = cleanEmbedding(query.embedding);
    const limit = sqlLimit(query.limit);
    if (limit === 0) return [];
    const profile = this.#named(query.profile);
    const filter = {
      scopes: JSON.stringify(query.scopes.map(memoryScopeKey)),
      kinds: query.kinds === null ? null : JSON.stringify(query.kinds),
    };
    const hits: MemoryHit[] = [];

    const tokens = queryTokens(query.tokens);
    if (tokens.length > 0) {
      let rows: (MemoryRow & { score: number })[];
      try {
        rows = this.#q.text.all({ ...filter, match: ftsMatch(tokens), limit: limit ?? -1 });
      } catch (cause) {
        if (cause instanceof StoreError) throw cause;
        throw new StoreError("memory text search failed", { cause });
      }
      for (const { score, ...row } of rows) {
        hits.push({ record: recordOf(profile, row), text_score: score, vector_score: null });
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
      const rows = this.#vectorRows(query32.length);
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
      const full = new Map<number, MemoryRow>();
      if (missing.length > 0) {
        const seqs = JSON.stringify(missing.map(({ row }) => row.seq));
        for (const row of this.#q.bySeq.all({ seqs })) full.set(row.seq, row);
      }
      for (const { row, score } of scored) {
        const hit = byId.get(row.id);
        if (hit) {
          hit.vector_score = score;
          continue;
        }
        const whole = full.get(row.seq);
        if (whole) {
          hits.push({ record: recordOf(profile, whole), text_score: 0, vector_score: score });
        }
      }
    }
    return hits;
  }

  async list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]> {
    this.#named(profile);
    const rows = this.#q.list.all({ ...listParams(filter), limit: limitParam(filter.limit) });
    return rows.map((row) => recordOf(profile, row));
  }

  async count(profile: ProfileId, filter: MemoryFilter): Promise<number> {
    this.#named(profile);
    return this.#q.count.get(listParams(filter))?.n ?? 0;
  }

  async listAbout(
    profile: ProfileId,
    people: readonly PersonId[],
    limitEach: number,
  ): Promise<MemoryRecord[]> {
    const limit = sqlLimit(limitEach);
    if (people.length === 0 || limit === 0) return [];
    this.#named(profile);
    const rows = this.#q.about.all({ people: JSON.stringify([...new Set(people)]), limit });
    return rows.map((row) => recordOf(profile, row));
  }

  async missingEmbeddings(profile: ProfileId, limit: number): Promise<MemoryRecord[]> {
    this.#named(profile);
    const rows = this.#db.orm
      .select()
      .from(R)
      .where(and(isNull(R.embedding), isNull(R.superseded_by)))
      .orderBy(desc(R.created_at), desc(R.id))
      .limit(limitParam(limit))
      .all();
    return rows.map((row) => recordOf(profile, row));
  }

  async touch(ids: readonly string[], at: Timestamp): Promise<void> {
    if (ids.length === 0) return;
    this.#db.ensureOpen();
    this.#q.touch.run({ ids: JSON.stringify([...new Set(ids)]), at: toMicros(at) });
  }

  async dueFollowups(
    profile: ProfileId,
    now: Timestamp,
    maxAgeMs: number | null = null,
  ): Promise<MemoryRecord[]> {
    this.#named(profile);
    const nowMicros = toMicros(now);
    const rows = this.#q.due.all({
      now: nowMicros,
      since: maxAgeMs === null ? null : nowMicros - Math.round(maxAgeMs * 1000),
    });
    return rows.map((row) => recordOf(profile, row));
  }

  async expireFollowups(profile: ProfileId, dueBefore: Timestamp): Promise<number> {
    this.#named(profile);
    const { changes } = this.#db.orm
      .update(R)
      .set({ done: true })
      .where(
        and(
          eq(R.kind, "followup"),
          sql`NOT ${R.done}`,
          sql`${R.due} IS NOT NULL`,
          lt(R.due, dueBefore),
        ),
      )
      .run();
    return Number(changes);
  }

  async prune(profile: ProfileId, policy: PrunePolicy): Promise<number> {
    this.#named(profile);
    const { changes } = this.#db.orm
      .delete(R)
      .where(
        and(
          eq(R.kind, "episode"),
          lt(R.created_at, policy.created_before),
          sql`${R.importance} <= ${policy.max_importance}`,
          sql`(${R.last_accessed} IS NULL OR ${R.last_accessed} < ${toMicros(policy.not_accessed_since)})`,
        ),
      )
      .run();
    return Number(changes);
  }

  async deleteBySubject(profile: ProfileId, person: PersonId): Promise<number> {
    this.#named(profile);
    const scope = memoryScopeKey({ type: "person", person });
    const { changes } = this.#db.orm
      .delete(R)
      .where(
        sql`EXISTS (SELECT 1 FROM json_each(${R.subjects}) WHERE value = ${person}) OR ${R.scope_key} = ${scope}`,
      )
      .run();
    return Number(changes);
  }

  async mergePerson(keep: PersonId, absorb: PersonId): Promise<number> {
    if (keep === absorb) return 0;
    const absorbScope = memoryScopeKey({ type: "person", person: absorb });
    const keepScope = canonicalMemoryScope({ type: "person", person: keep });
    const orm = this.#db.orm;
    // `tokens` is untouched, so the FTS triggers do not fire and `seq` (the FTS rowid) stays.
    return this.#db.tx(() => {
      const rows = orm
        .select({ id: R.id, subjects: R.subjects, scope_key: R.scope_key })
        .from(R)
        .where(
          sql`EXISTS (SELECT 1 FROM json_each(${R.subjects}) WHERE value = ${absorb}) OR ${R.scope_key} = ${absorbScope}`,
        )
        .all();
      for (const row of rows) {
        const subjects = [...new Set(row.subjects.map((s) => (s === absorb ? keep : s)))];
        const rescoped = row.scope_key === absorbScope;
        orm
          .update(R)
          .set(
            rescoped
              ? { subjects, scope: keepScope, scope_key: JSON.stringify(keepScope) }
              : { subjects },
          )
          .where(eq(R.id, row.id))
          .run();
      }
      return rows.length;
    });
  }
}

/** The memory records as a plugin of the store: Core opens the store with it (`STORE_PLUGINS`). */
export const memoryTables: StorePlugin<MemoryTables> = {
  schema: memorySchema,
  open: ({ db }) => new MemoryTables(db),
};
