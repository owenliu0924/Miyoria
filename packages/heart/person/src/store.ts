// The `heart` plugin's tables on the store's database (`schema.ts`): her numbers and words for each
// person (`HeartStore`, on `heart_person`) and her own state (`HeartSelfStore`, on `heart_self`).
//
// A number moves only through `apply` (and `applyDecay`, `adminSet`, `migrateLegacy`, which go the
// same way): the rules of `rules.ts` decide what is applied, and the row and its `heart.changed`
// event are written in one `Db.tx` (a savepoint inside a caller's), as the coin ledger writes
// `economy.posted`. `upsert` writes a row as it is given, for her words and tags; it records no
// change, so it is not the way to move a number.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `heart` (`module.ts`) owns it.

import {
  type CategoryData,
  type Db,
  type EventStore,
  type HeartEvidenceData,
  type PersonForget,
  type PersonHookResult,
  type PersonMerge,
  persons,
  StoreError,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import {
  type Clock,
  type HeartLine,
  type JsonObject,
  type JsonValue,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import {
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { type HeartPersonConfig, heartPersonConfig } from "./config.js";
import { type LegacyInput, type LegacyResult, migrateLegacy } from "./legacy.js";
import { changeWrite, evidenceWrite, HeartLog } from "./log.js";
import { heartSchema } from "./migrations.js";
import {
  BLOCKED_TAG,
  clampField,
  type HeartField,
  type HeartPerson,
  hasTag,
  newPerson,
  type TierAnchor,
} from "./model.js";
import {
  ANCHORED_TIERS,
  applyChange,
  applyDecay,
  decayDay,
  emptyLedger,
  familiarityGain,
  type HeartChange,
  type HeartChangeRequest,
  lineDepth,
  localDay,
} from "./rules.js";
import { type HeartPersonRow, heartPerson, heartSelf } from "./schema.js";

const P = heartPerson;

/** At most this many people per page of `list`. */
const MAX_PAGE = 200;

/** Options of a write that moves a number. */
export interface HeartApplyOptions {
  /** Epoch ms; default: the store's clock. Decides her local day for the caps. */
  now?: number;
  /** The turn the change came from (a `feel` proposal's), on the event's envelope. */
  turn?: string | null;
}

/** What one change did. */
export interface HeartApplied {
  /** The row as written. */
  person: HeartPerson;
  /** The `heart.changed` payload as appended (`delta` 0 when the caps took all of it). */
  change: HeartChange;
  /** The event's id. */
  event_id: string;
  /** The tier a bond rise stopped under for want of an anchor (H4); `null`: none. */
  held: number | null;
  /** The person had no row: this change made it. */
  created: boolean;
}

/** One person as the panel's list shows them. */
export interface HeartListEntry {
  person: HeartPerson;
  /** Identity's name and handle for them; `null` when identity has no such person. */
  name: string | null;
  handle: string | null;
}

export interface HeartListOptions {
  /**
   * Part of their name, handle or call name (any case), or their exact person id. Empty: all.
   */
  search?: string;
  /** Rows to skip (the previous page's `next`). */
  offset?: number;
  /** Rows per page, 1..200; default 50. */
  limit?: number;
}

/** One page of `list`, closest first (bond, then person id). */
export interface HeartPersonPage {
  entries: HeartListEntry[];
  /** How many match in all. */
  total: number;
  /** The `offset` of the next page; `null`: this is the last. */
  next: number | null;
}

/** A row as `HeartPerson` (and back: the fields are the same), with copies of its lists. */
function personOf(row: HeartPersonRow | HeartPerson): HeartPerson {
  return {
    person_id: row.person_id,
    bond: row.bond,
    trust: row.trust,
    familiarity: row.familiarity,
    warmth: row.warmth,
    respect: row.respect,
    ease: row.ease,
    grudge: row.grudge,
    longing: row.longing,
    rapport: row.rapport,
    stance: row.stance,
    impression: row.impression,
    unfinished: row.unfinished,
    jokes: row.jokes,
    dislikes: row.dislikes,
    public_feeling: row.public_feeling,
    call_name: row.call_name,
    tags: [...row.tags],
    tier_floor: row.tier_floor,
    anchors: row.anchors.map((a) => ({ ...a })),
    interactions: row.interactions,
    last_interaction: row.last_interaction,
    last_seen: row.last_seen,
    last_together: row.last_together,
    decayed_on: row.decayed_on,
    legacy: row.legacy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** `HeartPerson` as a row (the same fields; whole numbers where the column is an integer). */
function rowOf(p: HeartPerson): HeartPersonRow {
  return {
    ...personOf(p),
    tier_floor: Math.round(p.tier_floor),
    interactions: Math.max(0, Math.round(p.interactions)),
    decayed_on: p.decayed_on === null ? null : Math.round(p.decayed_on),
  };
}

/** `text` as a LIKE pattern matching it anywhere, with `%`, `_` and `\` taken literally. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Her numbers and words for each person (`heart_person`), and the changes on the event log. */
export class HeartStore {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #clock: Clock;
  #rules: HeartPersonConfig;
  #log: HeartLog;

  constructor(
    db: Db,
    events: EventStore,
    options: { rules?: HeartPersonConfig; clock?: Clock } = {},
  ) {
    this.#db = db;
    this.#events = events;
    this.#clock = options.clock ?? db.clock;
    this.#rules = options.rules ?? heartPersonConfig();
    this.#log = new HeartLog(events, this.#rules);
  }

  /** The rules in force (the owning module's config section). */
  get rules(): HeartPersonConfig {
    return this.#rules;
  }

  /** Puts `rules` in force from now on (the module that owns the heart, on start and reload). */
  setRules(rules: HeartPersonConfig): void {
    this.#rules = rules;
    this.#log = new HeartLog(this.#events, rules);
  }

  /** The changes and evidence on the event log: a person's history, the day's ledger. */
  get log(): HeartLog {
    return this.#log;
  }

  #now(now: number | undefined): number {
    return now ?? this.#clock.now();
  }

  // ---- reading ------------------------------------------------------------------------------

  get(person: PersonId): HeartPerson | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(P).where(eq(P.person_id, person)).get();
    return row === undefined ? null : personOf(row);
  }

  has(person: PersonId): boolean {
    this.#db.ensureOpen();
    return (
      this.#db.orm.select({ id: P.person_id }).from(P).where(eq(P.person_id, person)).get() !==
      undefined
    );
  }

  /** People closest first, a page at a time, optionally only those `search` finds. */
  list(options: HeartListOptions = {}): HeartPersonPage {
    this.#db.ensureOpen();
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), MAX_PAGE);
    const offset = Math.max(Math.floor(options.offset ?? 0), 0);
    const q = options.search?.trim() ?? "";
    let where: SQL | undefined;
    if (q !== "") {
      const pattern = contains(q);
      const like = (column: SQLWrapper) => sql`${column} LIKE ${pattern} ESCAPE '\\'`;
      where = or(eq(P.person_id, q), like(persons.name), like(persons.handle), like(P.call_name));
    }
    const orm = this.#db.orm;
    const total = orm
      .select({ n: count() })
      .from(P)
      .leftJoin(persons, eq(persons.id, P.person_id))
      .where(where)
      .get();
    const rows = orm
      .select({ row: P, name: persons.name, handle: persons.handle })
      .from(P)
      .leftJoin(persons, eq(persons.id, P.person_id))
      .where(where)
      .orderBy(desc(P.bond), asc(P.person_id))
      .limit(limit)
      .offset(offset)
      .all();
    const n = Number(total?.n ?? 0);
    return {
      entries: rows.map((r) => ({ person: personOf(r.row), name: r.name, handle: r.handle })),
      total: n,
      next: offset + rows.length < n ? offset + rows.length : null,
    };
  }

  /** The people the daily pass has not run for on the local day of `now`. */
  decayDue(now?: number): PersonId[] {
    this.#db.ensureOpen();
    const today = localDay(this.#now(now), this.#rules);
    return this.#db.orm
      .select({ id: P.person_id })
      .from(P)
      .where(or(isNull(P.decayed_on), lt(P.decayed_on, today)))
      .orderBy(asc(P.person_id))
      .all()
      .map((r) => r.id);
  }

  // ---- writing ------------------------------------------------------------------------------

  /** Writes `person` as it is (a new row, or every field of the existing one). Records no change. */
  upsert(person: HeartPerson): void {
    const row = rowOf(person);
    const { person_id: _id, ...rest } = row;
    this.#db.ensureOpen();
    this.#db.orm.insert(P).values(row).onConflictDoUpdate({ target: P.person_id, set: rest }).run();
  }

  /**
   * Applies one change to `person` (a row is made for someone new) by the rules, and writes the
   * row and its `heart.changed` event in one transaction.
   */
  apply(
    person: PersonId,
    request: HeartChangeRequest,
    options: HeartApplyOptions = {},
  ): HeartApplied {
    return this.applyAll(person, [request], options)[0] as HeartApplied;
  }

  /** Applies `requests` to `person` in order, in one transaction, each seeing the ones before. */
  applyAll(
    person: PersonId,
    requests: readonly HeartChangeRequest[],
    options: HeartApplyOptions = {},
  ): HeartApplied[] {
    const now = this.#now(options.now);
    const at = toTimestamp(now);
    return this.#write(() => {
      const stored = this.get(person);
      let current = stored ?? newPerson(person, at, this.#rules.default_trust);
      let ledger = this.#log.dayLedger(person, now);
      const out: HeartApplied[] = [];
      for (const request of requests) {
        const applied = applyChange(current, request, ledger, this.#rules, now);
        current = applied.person;
        ledger = applied.ledger;
        const event = this.#events.appendNow(changeWrite(applied.change, at, options.turn ?? null));
        out.push({
          person: current,
          change: applied.change,
          event_id: event.id,
          held: applied.held,
          created: stored === null,
        });
      }
      if (out.length > 0) this.upsert(current);
      return out;
    });
  }

  /**
   * `person` said a line (a row is made for someone new): when she last saw them, and, for a line
   * said with her (to her, or in the voice channel she is in), an interaction and when they last
   * talked and were together; familiarity grows by the line's depth (`lineDepth`,
   * `familiarityGain`). Bookkeeping, not a change of hers: no `heart.changed` is written, as
   * `interactions` writes none. Someone tagged `blocked` is left as they are. The row as written.
   */
  seen(person: PersonId, line: HeartLine): HeartPerson {
    const at = toTimestamp(line.at);
    return this.#write(() => {
      const current = this.get(person) ?? newPerson(person, at, this.#rules.default_trust);
      if (hasTag(current, BLOCKED_TAG)) return current;
      const together = line.together || line.directed;
      const gain = familiarityGain(
        current.familiarity,
        lineDepth(line.text, line.directed),
        this.#rules,
      );
      const next: HeartPerson = {
        ...current,
        familiarity: clampField("familiarity", current.familiarity + gain),
        interactions: current.interactions + (together ? 1 : 0),
        last_seen: at,
        last_interaction: together ? at : current.last_interaction,
        last_together: together ? at : current.last_together,
        updated_at: at,
      };
      this.upsert(next);
      return next;
    });
  }

  /**
   * The owner sets `field` of `person` to `value` (cause `admin`: no cap, no anchor; the range
   * and the owner's floor still hold).
   */
  adminSet(
    person: PersonId,
    field: HeartField,
    value: number,
    options: HeartApplyOptions & { quote?: string } = {},
  ): HeartApplied {
    if (!Number.isFinite(value)) throw new StoreError(`not a number for \`${field}\``);
    return this.#write(() => {
      const current =
        this.get(person) ??
        newPerson(person, toTimestamp(this.#now(options.now)), this.#rules.default_trust);
      return this.apply(
        person,
        {
          type: "adjust",
          field,
          delta: value - current[field],
          cause: "admin",
          quote: options.quote ?? "",
        },
        options,
      );
    });
  }

  /**
   * The daily pass for `person` on the local day of `now` (`decayDay`), written with one `decay`
   * change per field it moved. `null` for someone without a row. The day is recorded also when
   * nothing moved, so a second call that day writes nothing.
   */
  applyDecay(
    person: PersonId,
    options: { now?: number } = {},
  ): { person: HeartPerson; changes: HeartChange[] } | null {
    const now = this.#now(options.now);
    const at = toTimestamp(now);
    return this.#write(() => {
      const current = this.get(person);
      if (current === null) return null;
      const pass = decayDay(current, now, this.#rules);
      if (pass.changes.length === 0 && current.decayed_on === pass.day) {
        return { person: current, changes: [] };
      }
      // Decay is not capped, so the day's ledger does not matter to it.
      const result = applyDecay(current, pass, emptyLedger(pass.day), this.#rules, now);
      for (const change of result.changes) this.#events.appendNow(changeWrite(change, at));
      const next = { ...result.person, updated_at: at };
      this.upsert(next);
      return { person: next, changes: result.changes };
    });
  }

  /**
   * Sets the anchor of `anchor.tier` (one per tier; a new one replaces the old). The bond is not
   * moved: a bond held below the tier passes it with the next rise.
   */
  setAnchor(person: PersonId, anchor: TierAnchor, options: { now?: number } = {}): HeartPerson {
    if (!ANCHORED_TIERS.includes(anchor.tier)) {
      throw new StoreError(`tier \`${anchor.tier}\` takes no anchor`);
    }
    return this.#write(() => {
      const current = this.get(person);
      if (current === null) throw new StoreError(`no heart row for person \`${person}\``);
      const anchors = [...current.anchors.filter((a) => a.tier !== anchor.tier), { ...anchor }];
      anchors.sort((a, b) => a.tier - b.tier);
      const next = { ...current, anchors, updated_at: toTimestamp(this.#now(options.now)) };
      this.upsert(next);
      return next;
    });
  }

  /** Removes the anchor of `tier`; `null` when the person has no row. The bond stays. */
  removeAnchor(person: PersonId, tier: number, options: { now?: number } = {}): HeartPerson | null {
    return this.#write(() => {
      const current = this.get(person);
      if (current === null) return null;
      if (!current.anchors.some((a) => a.tier === tier)) return current;
      const anchors = current.anchors.filter((a) => a.tier !== tier);
      const next = { ...current, anchors, updated_at: toTimestamp(this.#now(options.now)) };
      this.upsert(next);
      return next;
    });
  }

  /** Appends a piece of evidence (`heart.evidence`); the session decides its scope. Its id. */
  appendEvidence(evidence: HeartEvidenceData, session: string | null = null): string {
    return this.#events.appendNow(evidenceWrite(evidence, session)).id;
  }

  /**
   * The migration from the old records (`legacy.ts`): a row and a `migrate` change for everyone
   * without a row yet, in one transaction. Running it again changes nothing.
   */
  migrateLegacy(input: LegacyInput, options: { now?: number } = {}): LegacyResult {
    const now = this.#now(options.now);
    const at = toTimestamp(now);
    return this.#write(() => {
      const result = migrateLegacy(input, (p) => this.has(p), this.#rules, now);
      for (const row of result.rows) this.upsert(row);
      for (const change of result.changes) this.#events.appendNow(changeWrite(change, at));
      return result;
    });
  }

  /** Deletes the rows of `ids` (a forgotten person); how many. Their events go with the log's. */
  forget(ids: readonly PersonId[]): number {
    if (ids.length === 0) return 0;
    this.#db.ensureOpen();
    return Number(
      this.#db.orm
        .delete(P)
        .where(inArray(P.person_id, [...ids]))
        .run().changes,
    );
  }

  /**
   * `absorb` turned out to be `keep`: its row becomes `keep`'s when `keep` has none. When both
   * have one, both stay and the merge is declined (the owner decides which numbers are right).
   */
  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    return this.#write(() => {
      const from = this.get(absorb);
      if (from === null) return { counts: { moved: 0 } };
      if (this.has(keep)) {
        return {
          counts: { moved: 0 },
          declined: "both people have a heart row; the absorbed one is left for the owner",
        };
      }
      this.#db.orm.update(P).set({ person_id: keep }).where(eq(P.person_id, absorb)).run();
      return { counts: { moved: 1 } };
    });
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }
}

/** JSON text with every object's keys sorted: the same state gives the same text. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Her own emotions and drives (`heart_self`): one JSON row, written only when it changed. */
export class HeartSelfStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, options: { clock?: Clock } = {}) {
    this.#db = db;
    this.#clock = options.clock ?? db.clock;
  }

  /** The state as last saved; `null` before the first save. */
  get(): JsonObject | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(heartSelf).where(eq(heartSelf.id, 1)).get();
    return row?.state ?? null;
  }

  /**
   * Saves `state` when it differs from what is stored (key order aside). Whether it wrote.
   */
  save(state: JsonObject, options: { now?: number } = {}): boolean {
    this.#db.ensureOpen();
    return this.#db.tx(() => {
      const stored = this.get();
      if (stored !== null && canonical(stored) === canonical(state)) return false;
      const updated_at = toTimestamp(options.now ?? this.#clock.now());
      this.#db.orm
        .insert(heartSelf)
        .values({ id: 1, state, updated_at })
        .onConflictDoUpdate({ target: heartSelf.id, set: { state, updated_at } })
        .run();
      return true;
    });
  }
}

/** What the plugin gives its owner. */
export interface HeartTables {
  people: HeartStore;
  self: HeartSelfStore;
}

/**
 * The heart's parts of the data categories: the rows about people go with `relationships` (with
 * every change and piece of evidence recorded about them, which the event log keeps otherwise),
 * her own state with `inner`.
 */
const heartData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("heart_person", "heart_person", "node", "updated_at", "person_id", {
        person_id: "text",
        bond: "num",
        trust: "num",
        familiarity: "num",
        warmth: "num",
        respect: "num",
        ease: "num",
        grudge: "num",
        longing: "num",
        rapport: "num",
        stance: "text",
        impression: "text",
        unfinished: "text",
        jokes: "text",
        dislikes: "text",
        public_feeling: "text",
        call_name: "text",
        tags: "json",
        tier_floor: "num",
        anchors: "json",
        interactions: "num",
        last_interaction: "ts",
        last_seen: "ts",
        last_together: "ts",
        decayed_on: "num",
        legacy: "json",
        created_at: "ts",
        updated_at: "ts",
      }),
    ],
    keptEvents: "type IN ('heart.changed', 'heart.evidence')",
  },
  {
    category: "inner",
    parts: [
      tablePart("heart_self", "heart_self", "node", "updated_at", "id", {
        state: "json",
        updated_at: "ts",
      }),
    ],
  },
];

/** The `heart` plugin's tables and code (`StorePlugin`). */
export const heartTables: StorePlugin<HeartTables> = {
  schema: heartSchema,
  open: ({ db, events }) => ({ people: new HeartStore(db, events), self: new HeartSelfStore(db) }),
  data: heartData,
  forgetPerson: (opened, request: PersonForget) => ({
    counts: { people: opened.people.forget(request.ids) },
  }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.people.merge(keep, absorb),
};
