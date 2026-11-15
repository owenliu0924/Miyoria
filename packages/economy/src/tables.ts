// The `economy` plugin's tables on the store's database (`schema.ts`): the coin ledger and the
// wallets (`CoinLedgerStore`), the deals (`DealStore`). Core opens the store with
// `economyTables` and provides `store.plugin(economyTables)` under the economy's service keys
// (`records.ts`). Every read and write runs on the store's connection; a posting and its checks are
// one `Db.tx` (a savepoint inside a caller's).
//
// A wallet is a person with the persons they absorbed (identity keeps an absorbed person's row,
// `merged_into` set, so its rows are found again), or `PURSE`. A person id that was absorbed
// stands for the person that absorbed it.

import {
  accounts,
  type Db,
  type Identity,
  persons,
  StoreError,
  type StorePlugin,
  toMicros,
} from "@miyoria/store";
import type { AccountRef, PersonId, ProfileId, Timestamp } from "@miyoria/types";
import { and, asc, desc, eq, getColumns, gte, inArray, type SQL, sql } from "drizzle-orm";
import { economySchema } from "./migrations.js";
import {
  type CoinCap,
  type CoinEntry,
  type CoinLedgerStore,
  type CoinPost,
  type CoinRule,
  type Deal,
  type DealPatch,
  type DealStatus,
  type DealStore,
  type LedgerDayTotal,
  PURSE,
} from "./records.js";
import { type DealRow, economyDeals, economyLedger, economyWallets } from "./schema.js";

/** `limit` as SQLite's `LIMIT`: a negative one is none (the store's `sqlLimit`). */
function limitOf(limit: number): number {
  if (Number.isNaN(limit)) return 0;
  if (!Number.isFinite(limit) || limit >= Number.MAX_SAFE_INTEGER) return limit > 0 ? -1 : 0;
  return Math.max(0, Math.floor(limit));
}

/**
 * The delta a rule lets through: earnings stop at every cap (`partial`: what still fits), `null`
 * when nothing does. `used` sums a cap so far.
 */
export function allowedDelta(
  delta: number,
  rule: CoinRule,
  used: (cap: CoinCap) => number,
): number | null {
  if (delta <= 0) return delta;
  let out = delta;
  for (const cap of rule.caps ?? []) {
    const room = cap.limit - used(cap);
    if (out <= room) continue;
    if (!rule.partial || room <= 0) return null;
    out = room;
  }
  return out;
}

const L = economyLedger;

/** The ledger's rows of the wallet named by placeholder `name`: the person and whom they absorbed. */
function ofWallet(name: string): SQL {
  const w = sql.placeholder(name);
  return sql`${L.person_id} IN (SELECT ${w} UNION ALL SELECT ${persons.id} FROM ${persons} WHERE ${persons.merged_into} = ${w})`;
}

/** `reason IN` the JSON array of placeholder `name`, or any reason when it is `null`. */
function reasonIn(name: string): SQL {
  const list = sql.placeholder(name);
  return sql`(${list} IS NULL OR ${L.reason} IN (SELECT value FROM json_each(${list})))`;
}

const ENTRY = {
  id: L.id,
  person: L.person_id,
  delta: L.delta,
  reason: L.reason,
  ref: L.ref,
  idem_key: L.idem_key,
  ts: L.ts,
};

/** The coin ledger and the wallets (`CoinLedgerStore`) on `economy_ledger` and `economy_wallets`. */
export class LedgerTables implements CoinLedgerStore {
  readonly #db: Db;
  readonly #identity: Identity;
  // The hottest reads, prepared once: every spend and earning runs them in its transaction.
  readonly #balance;
  readonly #byKey;
  readonly #entries;
  readonly #capOf;
  readonly #capAll;

  constructor(db: Db, identity: Identity) {
    this.#db = db;
    this.#identity = identity;
    const orm = db.orm;
    this.#balance = orm
      .select({ n: sql<number>`COALESCE(SUM(${L.delta}), 0)` })
      .from(L)
      .where(ofWallet("wallet"))
      .prepare();
    this.#byKey = orm
      .select(ENTRY)
      .from(L)
      .where(and(ofWallet("wallet"), eq(L.idem_key, sql.placeholder("key"))))
      .orderBy(asc(L.ts), asc(L.seq))
      .limit(1)
      .prepare();
    this.#entries = orm
      .select(ENTRY)
      .from(L)
      .where(
        and(
          ofWallet("wallet"),
          reasonIn("reasons"),
          sql`(${sql.placeholder("since")} IS NULL OR ${L.ts} >= ${sql.placeholder("since")})`,
        ),
      )
      .orderBy(desc(L.ts), desc(L.seq))
      .limit(sql.placeholder("limit"))
      .prepare();
    const capWhere = and(
      sql`${L.ts} >= ${sql.placeholder("since")}`,
      sql`${L.reason} IN (SELECT value FROM json_each(${sql.placeholder("reasons")}))`,
    );
    this.#capOf = orm
      .select({ n: sql<number>`COALESCE(SUM(${L.delta}), 0)` })
      .from(L)
      .where(and(capWhere, ofWallet("wallet")))
      .prepare();
    this.#capAll = orm
      .select({ n: sql<number>`COALESCE(SUM(${L.delta}), 0)` })
      .from(L)
      .where(capWhere)
      .prepare();
  }

  /**
   * The wallet `person` stands for: the purse, or the person that absorbed it, or itself. An id
   * identity does not know is a wallet of its own, as an account nobody saw was before.
   */
  #wallet(person: PersonId): PersonId {
    if (person === PURSE) return PURSE;
    return this.#identity.person(person)?.id ?? person;
  }

  /** The live person whose choices these are; the purse and an unknown id have none. */
  #person(person: PersonId): PersonId {
    const row = person === PURSE ? null : this.#identity.person(person);
    if (!row) throw new StoreError(`no person \`${person}\` to keep a wallet's choices for`);
    return row.id;
  }

  #sumOf(wallet: PersonId): number {
    this.#db.ensureOpen();
    return Number(this.#balance.get({ wallet })?.n ?? 0);
  }

  #first(wallet: PersonId, key: string): CoinEntry | null {
    this.#db.ensureOpen();
    return this.#byKey.get({ wallet, key }) ?? null;
  }

  #capUsed(cap: CoinCap): number {
    if (cap.reasons.length === 0) return 0;
    const params = { since: toMicros(cap.since), reasons: JSON.stringify(cap.reasons) };
    this.#db.ensureOpen();
    if (cap.wallet === null) return Number(this.#capAll.get(params)?.n ?? 0);
    const wallet = this.#wallet(cap.wallet);
    return Number(this.#capOf.get({ ...params, wallet })?.n ?? 0);
  }

  async post(entry: CoinEntry, rule: CoinRule = {}): Promise<CoinPost> {
    if (!Number.isSafeInteger(entry.delta)) throw new StoreError("a coin delta must be whole");
    try {
      return this.#db.tx((): CoinPost => {
        const wallet = this.#wallet(entry.person);
        if (entry.idem_key !== null) {
          const first = this.#first(wallet, entry.idem_key);
          if (first) return { status: "duplicate", entry: first, balance: this.#sumOf(wallet) };
        }
        const balance = this.#sumOf(wallet);
        const delta = allowedDelta(entry.delta, rule, (cap) => this.#capUsed(cap));
        if (delta === null) return { status: "capped", balance };
        if (rule.covered && balance + delta < 0) return { status: "short", balance };
        const posted: CoinEntry = { ...entry, person: wallet, delta };
        this.#db.orm
          .insert(L)
          .values({
            id: posted.id,
            person_id: wallet,
            delta,
            reason: posted.reason,
            ref: posted.ref,
            idem_key: posted.idem_key,
            ts: posted.ts,
          })
          .run();
        return { status: "posted", entry: posted, balance: balance + delta };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot write to the coin ledger", { cause });
    }
  }

  async balance(_profile: ProfileId, person: PersonId): Promise<number> {
    return this.#sumOf(this.#wallet(person));
  }

  async entries(
    _profile: ProfileId,
    person: PersonId,
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]> {
    if (filter.reasons?.length === 0) return [];
    this.#db.ensureOpen();
    return this.#entries.all({
      wallet: this.#wallet(person),
      reasons: filter.reasons === undefined ? null : JSON.stringify(filter.reasons),
      since: filter.since === undefined ? null : toMicros(filter.since),
      limit: limitOf(filter.limit),
    });
  }

  async byKey(_profile: ProfileId, person: PersonId, key: string): Promise<CoinEntry | null> {
    return this.#first(this.#wallet(person), key);
  }

  // ---- the wallets ----------------------------------------------------------------------

  /** The persons of a wallet: itself and whom it absorbed. */
  #members(wallet: PersonId): PersonId[] {
    return this.#db.orm
      .select({ id: persons.id })
      .from(persons)
      .where(sql`${persons.id} = ${wallet} OR ${persons.merged_into} = ${wallet}`)
      .all()
      .map((r) => r.id);
  }

  async selectedFrame(_profile: ProfileId, person: PersonId): Promise<string | null> {
    const wallet = this.#wallet(person);
    if (wallet === PURSE) return null;
    const row = this.#db.orm
      .select({ frame: economyWallets.frame })
      .from(economyWallets)
      .where(inArray(economyWallets.person_id, this.#members(wallet)))
      .orderBy(desc(economyWallets.updated_at))
      .limit(1)
      .get();
    return row?.frame ?? null;
  }

  async selectFrame(
    _profile: ProfileId,
    person: PersonId,
    frame: string | null,
    at: Timestamp,
  ): Promise<void> {
    const wallet = this.#person(person);
    this.#db.orm
      .insert(economyWallets)
      .values({ person_id: wallet, frame, updated_at: at })
      .onConflictDoUpdate({ target: economyWallets.person_id, set: { frame, updated_at: at } })
      .run();
  }

  async onBoard(_profile: ProfileId, person: PersonId): Promise<boolean> {
    const wallet = this.#wallet(person);
    if (wallet === PURSE) return true;
    const row = this.#db.orm
      .select({ x: economyWallets.person_id })
      .from(economyWallets)
      .where(
        and(
          eq(economyWallets.off_board, true),
          inArray(economyWallets.person_id, this.#members(wallet)),
        ),
      )
      .limit(1)
      .get();
    return row === undefined;
  }

  async setOnBoard(_profile: ProfileId, person: PersonId, on: boolean): Promise<void> {
    const wallet = this.#person(person);
    // A row made only for the board is the oldest, so it never hides a chosen frame.
    this.#db.tx(() => {
      for (const id of this.#members(wallet)) {
        this.#db.orm
          .insert(economyWallets)
          .values({
            person_id: id,
            frame: null,
            updated_at: "1970-01-01T00:00:00.000Z",
            off_board: !on,
          })
          .onConflictDoUpdate({ target: economyWallets.person_id, set: { off_board: !on } })
          .run();
      }
    });
  }

  async offBoard(_profile: ProfileId, limit: number): Promise<PersonId[]> {
    const live = sql<string>`COALESCE(${persons.merged_into}, ${economyWallets.person_id})`;
    return this.#db.orm
      .selectDistinct({ person: live })
      .from(economyWallets)
      .innerJoin(persons, eq(persons.id, economyWallets.person_id))
      .where(eq(economyWallets.off_board, true))
      .orderBy(live)
      .limit(limitOf(limit))
      .all()
      .map((r) => r.person);
  }

  // ---- totals ---------------------------------------------------------------------------

  async spent(
    _profile: ProfileId,
    reasons: readonly string[],
    since: Timestamp,
    limit: number,
  ): Promise<{ person: PersonId; account: AccountRef | null; spent: number }[]> {
    if (reasons.length === 0) return [];
    // Only a person's rows: what the purse wrote is hers, never a spender's. The account is the
    // person's first, for who they are to her (`EconomyService.member`).
    const r = sql.raw("r");
    const rows = this.#db.orm.all<{
      person: string;
      platform: string | null;
      ext: string | null;
      n: number;
    }>(sql`
      SELECT s.person AS person, a.platform AS platform, a.external_id AS ext, s.n AS n FROM (
        SELECT COALESCE(${persons.merged_into}, ${persons.id}) AS person, -SUM(${L.delta}) AS n
        FROM ${L} JOIN ${persons} ON ${persons.id} = ${L.person_id}
        WHERE ${L.ts} >= ${toMicros(since)} AND ${L.delta} < 0
          AND ${L.reason} IN (SELECT value FROM json_each(${JSON.stringify(reasons)}))
          AND (${L.reason} <> 'deal_escrow' OR EXISTS (SELECT 1 FROM ${economyDeals}
            WHERE ${economyDeals.escrow_entry} = ${L.id} AND ${economyDeals.status} = 'settled'))
          AND NOT EXISTS (SELECT 1 FROM ${L} AS ${r} WHERE ${r}.reason = 'refund'
            AND ${r}.ref = ${L.id})
        GROUP BY 1 HAVING SUM(${L.delta}) < 0
      ) s
      LEFT JOIN ${accounts} a ON a.id = (SELECT id FROM ${accounts} WHERE person_id = s.person
        ORDER BY first_seen, platform, external_id LIMIT 1)
      ORDER BY s.n DESC, s.person LIMIT ${limitOf(limit)}`);
    return rows.map((row) => ({
      person: row.person,
      account:
        row.platform === null || row.ext === null ? null : { platform: row.platform, id: row.ext },
      spent: Number(row.n),
    }));
  }

  async dailyTotals(
    _profile: ProfileId,
    since: Timestamp,
    offsetMinutes: number,
  ): Promise<LedgerDayTotal[]> {
    // Microseconds since the epoch, moved to local time, divided into whole days (ts is positive;
    // the casts keep the division integral however the driver binds a JS number).
    const offset = Math.round(offsetMinutes) * 60_000_000;
    const day = sql`CAST((${L.ts} + CAST(${offset} AS INTEGER)) / 86400000000 AS INTEGER)`;
    const rows = this.#db.orm.all<{
      day: number;
      reason: string;
      positive: number;
      negative: number;
    }>(sql`
      SELECT ${day} AS day, ${L.reason} AS reason,
        COALESCE(SUM(CASE WHEN ${L.delta} > 0 THEN ${L.delta} ELSE 0 END), 0) AS positive,
        COALESCE(-SUM(CASE WHEN ${L.delta} < 0 THEN ${L.delta} ELSE 0 END), 0) AS negative
      FROM ${L} WHERE ${L.ts} >= ${toMicros(since)} GROUP BY 1, 2 ORDER BY 1, 2`);
    return rows.map((r) => ({
      day: Number(r.day),
      reason: String(r.reason),
      positive: Number(r.positive),
      negative: Number(r.negative),
    }));
  }
}

// ---- deals ----------------------------------------------------------------------------------

const D = economyDeals;

function dealOf(row: DealRow & { platform: string; external_id: string }): Deal {
  return {
    id: row.id,
    account: { platform: row.platform, id: row.external_id },
    item: row.reward_item,
    count: row.reward_count,
    value: row.reward_value,
    task: row.task,
    prepaid: row.prepaid,
    escrow: row.escrow_entry,
    status: row.status,
    created_at: row.created_at,
    done_at: row.done_at,
    due_at: row.due_at,
    closed_at: row.closed_at,
  };
}

/** The deals she accepted (`DealStore`) on `economy_deals`, by identity's `accounts.id`. */
export class DealTables implements DealStore {
  readonly #db: Db;
  readonly #identity: Identity;

  constructor(db: Db, identity: Identity) {
    this.#db = db;
    this.#identity = identity;
  }

  #select() {
    return this.#db.orm
      .select({ ...getColumns(D), platform: accounts.platform, external_id: accounts.external_id })
      .from(D)
      .innerJoin(accounts, eq(accounts.id, D.account_id));
  }

  /** The rows of `accounts` that exist; an account never seen has no deal. */
  #accountIds(refs: readonly AccountRef[]): string[] {
    return refs.flatMap((r) => {
      const id = this.#identity.account(r)?.id;
      return id === undefined ? [] : [id];
    });
  }

  async create(deal: Deal): Promise<void> {
    try {
      this.#db.tx(() => {
        const account = this.#identity.ensureAccount(deal.account);
        this.#db.orm
          .insert(D)
          .values({
            id: deal.id,
            account_id: account.id,
            reward_item: deal.item,
            reward_count: deal.count,
            reward_value: deal.value,
            task: deal.task,
            prepaid: deal.prepaid,
            escrow_entry: deal.escrow,
            status: deal.status,
            created_at: deal.created_at,
            done_at: deal.done_at,
            due_at: deal.due_at,
            closed_at: deal.closed_at,
          })
          .run();
      });
    } catch (cause) {
      throw new StoreError("cannot write the deal", { cause });
    }
  }

  async get(id: string): Promise<Deal | null> {
    const row = this.#select().where(eq(D.id, id)).get();
    return row ? dealOf(row) : null;
  }

  async transition(id: string, from: readonly DealStatus[], patch: DealPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const set: Partial<typeof D.$inferInsert> = { status: patch.status };
    if (patch.done_at !== undefined) set.done_at = patch.done_at;
    if (patch.due_at !== undefined) set.due_at = patch.due_at;
    if (patch.closed_at !== undefined) set.closed_at = patch.closed_at;
    const changed = this.#db.orm
      .update(D)
      .set(set)
      .where(and(eq(D.id, id), inArray(D.status, [...from])))
      .run();
    return changed.changes > 0;
  }

  async forAccounts(
    _profile: ProfileId,
    refs: readonly AccountRef[],
    filter: { statuses?: readonly DealStatus[]; since?: Timestamp; limit: number },
  ): Promise<Deal[]> {
    if (filter.statuses?.length === 0) return [];
    const ids = this.#accountIds(refs);
    if (ids.length === 0) return [];
    const rows = this.#select()
      .where(
        and(
          inArray(D.account_id, ids),
          filter.statuses ? inArray(D.status, [...filter.statuses]) : undefined,
          filter.since !== undefined ? gte(D.created_at, filter.since) : undefined,
        ),
      )
      .orderBy(desc(D.created_at), sql`${D}.rowid DESC`)
      .limit(limitOf(filter.limit))
      .all();
    return rows.map(dealOf);
  }

  async byStatus(
    _profile: ProfileId,
    statuses: readonly DealStatus[],
    filter: { since?: Timestamp; limit: number },
  ): Promise<Deal[]> {
    if (statuses.length === 0) return [];
    const rows = this.#select()
      .where(
        and(
          inArray(D.status, [...statuses]),
          filter.since !== undefined ? gte(D.created_at, filter.since) : undefined,
        ),
      )
      .orderBy(asc(D.created_at), sql`${D}.rowid`)
      .limit(limitOf(filter.limit))
      .all();
    return rows.map(dealOf);
  }
}

/** The economy plugin's code over its tables. */
export interface EconomyTables {
  readonly ledger: LedgerTables;
  readonly deals: DealTables;
}

/** The `economy` plugin's tables and code (`StorePlugin`). */
export const economyTables: StorePlugin<EconomyTables> = {
  schema: economySchema,
  open: ({ db, identity }) => ({
    ledger: new LedgerTables(db, identity),
    deals: new DealTables(db, identity),
  }),
};
