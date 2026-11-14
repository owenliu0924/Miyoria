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
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  type Directive,
  type DirectiveRecord,
  type JsonObject,
  type JsonValue,
  type ModuleId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  systemClock,
  type Timestamp,
} from "@miyoria/types";
import {
  allowedDelta,
  authScopeKey,
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
  walletWith,
} from "./common.js";
import {
  addCount,
  type DataCategoryId,
  type DataExport,
  type DataInventory,
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
import type {
  AuthScope,
  Bounty,
  BountyPatch,
  BountyStatus,
  CoinCap,
  CoinEntry,
  CoinPost,
  CoinRule,
  Deal,
  DealPatch,
  DealStatus,
  DocFilter,
  DocUpdate,
  EconomyDoc,
  FortuneRecord,
  Goal,
  GoalFulfiller,
  GoalPatch,
  GoalPledge,
  GoalStatus,
  LedgerDayTotal,
  MemberCardRecord,
  MemoryFilter,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  NodeOverride,
  PersonaOverride,
  PrunePolicy,
  Relationship,
  RelationshipDelta,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "./records.js";
import type {
  AuthStore,
  BountyStore,
  CoinLedgerStore,
  DealStore,
  DirectiveStore,
  EconomyDocStore,
  FortuneStore,
  GoalStore,
  IdentityStore,
  MemberCardStore,
  MemoryRecordStore,
  MessageLog,
  ModuleStateStore,
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
  /** Plugin schemas to migrate besides the store's own (`core` and `legacy`). */
  schemas?: readonly PluginSchema[];
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

// ---- coins ---------------------------------------------------------------------------------

function coinFromRow(row: Row): CoinEntry {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    delta: num(row, "delta"),
    reason: str(row, "reason"),
    ref: optStr(row, "ref"),
    idem_key: optStr(row, "idem_key"),
    ts: ts(row, "ts"),
  };
}

/** `reason IN (…)` over `reasons`, its parameters added to `params`. */
function reasonsIn(reasons: readonly string[], params: Params): string {
  const names = reasons.map((r, i) => {
    params[`r${i}`] = r;
    return `$r${i}`;
  });
  return `reason IN (${names.join(", ")})`;
}

class SqliteCoins implements CoinLedgerStore {
  constructor(private readonly db: Db) {}

  #balance(profile: ProfileId, accounts: readonly AccountRef[]): number {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT COALESCE(SUM(delta), 0) AS n FROM coin_ledger WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  #sum(profile: ProfileId, cap: CoinCap): number {
    if (cap.reasons.length === 0 || cap.accounts?.length === 0) return 0;
    const params: Params = { profile, since: toMicros(cap.since) };
    const who = cap.accounts === null ? "" : ` AND (${authorsWhere(cap.accounts, params)})`;
    const row = this.db.get(
      "SELECT COALESCE(SUM(delta), 0) AS n FROM coin_ledger WHERE profile_id = $profile AND " +
        `ts >= $since AND ${reasonsIn(cap.reasons, params)}${who}`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  #byKey(profile: ProfileId, accounts: readonly AccountRef[], key: string): CoinEntry | null {
    if (accounts.length === 0) return null;
    const params: Params = { profile, key };
    const row = this.db.get(
      "SELECT * FROM coin_ledger WHERE profile_id = $profile AND idem_key = $key AND " +
        `(${authorsWhere(accounts, params)}) ORDER BY ts, rowid LIMIT 1`,
      params,
    );
    return row ? coinFromRow(row) : null;
  }

  async post(entry: CoinEntry, rule: CoinRule): Promise<CoinPost> {
    if (!Number.isSafeInteger(entry.delta)) throw new StoreError("a coin delta must be whole");
    const wallet = walletWith(entry.account, rule.wallet);
    const profile = entry.profile;
    try {
      return this.db.tx((): CoinPost => {
        if (entry.idem_key !== null) {
          const first = this.#byKey(profile, wallet, entry.idem_key);
          if (first) {
            return { status: "duplicate", entry: first, balance: this.#balance(profile, wallet) };
          }
        }
        const balance = this.#balance(profile, wallet);
        const delta = allowedDelta(entry.delta, rule, (cap) => this.#sum(profile, cap));
        if (delta === null) return { status: "capped", balance };
        if (rule.covered && balance + delta < 0) return { status: "short", balance };
        this.db.run(
          "INSERT INTO coin_ledger (id, profile_id, author_platform, author_id, delta, reason, " +
            "ref, idem_key, ts) VALUES ($id, $profile, $platform, $account, $delta, $reason, " +
            "$ref, $key, $ts)",
          {
            id: entry.id,
            profile,
            platform: entry.account.platform,
            account: entry.account.id,
            delta,
            reason: entry.reason,
            ref: entry.ref,
            key: entry.idem_key,
            ts: toMicros(entry.ts),
          },
        );
        return { status: "posted", entry: { ...entry, delta }, balance: balance + delta };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot write to the coin ledger", { cause });
    }
  }

  async balance(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    return this.#balance(profile, accounts);
  }

  async entries(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]> {
    if (accounts.length === 0 || filter.reasons?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = `profile_id = $profile AND (${authorsWhere(accounts, params)})`;
    if (filter.reasons) where += ` AND ${reasonsIn(filter.reasons, params)}`;
    if (filter.since !== undefined) {
      params.since = toMicros(filter.since);
      where += " AND ts >= $since";
    }
    const rows = this.db.all(
      `SELECT * FROM coin_ledger WHERE ${where} ORDER BY ts DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(coinFromRow);
  }

  async byKey(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    key: string,
  ): Promise<CoinEntry | null> {
    return this.#byKey(profile, accounts, key);
  }

  async selectedFrame(profile: ProfileId, accounts: readonly AccountRef[]): Promise<string | null> {
    if (accounts.length === 0) return null;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT frame FROM coin_wallets WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)}) ORDER BY updated_at DESC LIMIT 1`,
      params,
    );
    return row ? optStr(row, "frame") : null;
  }

  async selectFrame(
    profile: ProfileId,
    account: AccountRef,
    frame: string | null,
    at: Timestamp,
  ): Promise<void> {
    this.db.run(
      "INSERT INTO coin_wallets (profile_id, author_platform, author_id, frame, updated_at) " +
        "VALUES ($profile, $platform, $id, $frame, $at) ON CONFLICT (profile_id, " +
        "author_platform, author_id) DO UPDATE SET frame = excluded.frame, updated_at = " +
        "excluded.updated_at",
      { profile, platform: account.platform, id: account.id, frame, at: toMicros(at) },
    );
  }

  async onBoard(profile: ProfileId, accounts: readonly AccountRef[]): Promise<boolean> {
    if (accounts.length === 0) return true;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT 1 AS x FROM coin_wallets WHERE profile_id = $profile AND off_board = 1 AND " +
        `(${authorsWhere(accounts, params)}) LIMIT 1`,
      params,
    );
    return !row;
  }

  async setOnBoard(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    on: boolean,
  ): Promise<void> {
    // A row made only for the board is the oldest, so it never hides a chosen frame.
    this.db.tx(() => {
      for (const account of accounts) {
        this.db.run(
          "INSERT INTO coin_wallets (profile_id, author_platform, author_id, frame, updated_at, " +
            "off_board) VALUES ($profile, $platform, $id, NULL, 0, $off) ON CONFLICT (profile_id, " +
            "author_platform, author_id) DO UPDATE SET off_board = excluded.off_board",
          { profile, platform: account.platform, id: account.id, off: on ? 0 : 1 },
        );
      }
    });
  }

  async offBoardAccounts(profile: ProfileId, limit: number): Promise<AccountRef[]> {
    const rows = this.db.all(
      "SELECT author_platform, author_id FROM coin_wallets WHERE profile_id = $profile AND " +
        "off_board = 1 ORDER BY author_platform, author_id LIMIT $limit",
      { profile, limit: limitParam(limit) },
    );
    return rows.map((r) => ({ platform: str(r, "author_platform"), id: str(r, "author_id") }));
  }

  async spent(
    profile: ProfileId,
    reasons: readonly string[],
    since: Timestamp,
    limit: number,
  ): Promise<{ account: AccountRef; spent: number }[]> {
    if (reasons.length === 0) return [];
    const params: Params = { profile, since: toMicros(since), limit: limitParam(limit) };
    const names = reasons.map((r, i) => {
      params[`r${i}`] = r;
      return `$r${i}`;
    });
    const rows = this.db.all(
      "SELECT l.author_platform AS author_platform, l.author_id AS author_id, " +
        "-SUM(l.delta) AS n FROM coin_ledger l WHERE l.profile_id = $profile AND l.ts >= $since " +
        `AND l.delta < 0 AND l.reason IN (${names.join(", ")}) AND (l.reason <> 'deal_escrow' ` +
        "OR EXISTS (SELECT 1 FROM deals d WHERE d.escrow_entry = l.id AND d.status = 'settled')) " +
        "AND NOT EXISTS (SELECT 1 FROM coin_ledger r WHERE r.profile_id = l.profile_id AND " +
        "r.reason = 'refund' AND r.ref = l.id) GROUP BY l.author_platform, l.author_id " +
        "HAVING SUM(l.delta) < 0 ORDER BY n DESC, l.author_platform, l.author_id LIMIT $limit",
      params,
    );
    return rows.map((r) => ({
      account: { platform: str(r, "author_platform"), id: str(r, "author_id") },
      spent: num(r, "n"),
    }));
  }

  async dailyTotals(
    profile: ProfileId,
    since: Timestamp,
    offsetMinutes: number,
  ): Promise<LedgerDayTotal[]> {
    // Microseconds since the epoch, moved to local time, divided into whole days (ts is positive;
    // the casts keep the division integral however the driver binds a JS number).
    const rows = this.db.all(
      "SELECT CAST((ts + CAST($offset AS INTEGER)) / 86400000000 AS INTEGER) AS day, reason, " +
        "COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS positive, " +
        "COALESCE(-SUM(CASE WHEN delta < 0 THEN delta ELSE 0 END), 0) AS negative " +
        "FROM coin_ledger WHERE profile_id = $profile AND ts >= $since " +
        "GROUP BY day, reason ORDER BY day, reason",
      { profile, since: toMicros(since), offset: Math.round(offsetMinutes) * 60_000_000 },
    );
    return rows.map((r) => ({
      day: num(r, "day"),
      reason: str(r, "reason"),
      positive: num(r, "positive"),
      negative: num(r, "negative"),
    }));
  }
}

// ---- fortunes ------------------------------------------------------------------------------

function fortuneFromRow(row: Row): FortuneRecord {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    person: optStr(row, "person_id"),
    day: num(row, "day"),
    issued_at: ts(row, "issued_at"),
    entry: optStr(row, "entry_id"),
    slip: json<JsonObject>(row, "slip", "fortune"),
  };
}

class SqliteFortunes implements FortuneStore {
  constructor(private readonly db: Db) {}

  async put(record: FortuneRecord, accounts: readonly AccountRef[]): Promise<boolean> {
    const wallet = walletWith(record.account, accounts);
    try {
      return this.db.tx((): boolean => {
        const params: Params = { profile: record.profile, day: record.day };
        const taken = this.db.get(
          "SELECT id FROM fortunes WHERE profile_id = $profile AND day = $day AND " +
            `(${authorsWhere(wallet, params)}) LIMIT 1`,
          params,
        );
        if (taken) return false;
        this.db.run(
          "INSERT INTO fortunes (id, profile_id, author_platform, author_id, person_id, day, " +
            "issued_at, entry_id, slip) VALUES ($id, $profile, $platform, $account, $person, " +
            "$day, $at, $entry, $slip)",
          {
            id: record.id,
            profile: record.profile,
            platform: record.account.platform,
            account: record.account.id,
            person: record.person,
            day: record.day,
            at: toMicros(record.issued_at),
            entry: record.entry,
            slip: JSON.stringify(record.slip),
          },
        );
        return true;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store the fortune", { cause });
    }
  }

  async forDay(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    day: number,
  ): Promise<FortuneRecord | null> {
    if (accounts.length === 0) return null;
    const params: Params = { profile, day };
    const row = this.db.get(
      "SELECT * FROM fortunes WHERE profile_id = $profile AND day = $day AND " +
        `(${authorsWhere(accounts, params)}) ORDER BY issued_at DESC, rowid DESC LIMIT 1`,
      params,
    );
    return row ? fortuneFromRow(row) : null;
  }

  async listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<FortuneRecord[]> {
    if (accounts.length === 0) return [];
    const params: Params = { profile, limit: limitParam(limit) };
    const rows = this.db.all(
      `SELECT * FROM fortunes WHERE profile_id = $profile AND (${authorsWhere(accounts, params)}) ` +
        "ORDER BY issued_at DESC, rowid DESC LIMIT $limit",
      params,
    );
    return rows.map(fortuneFromRow);
  }

  async deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    return this.db.run(
      `DELETE FROM fortunes WHERE profile_id = $profile AND (${authorsWhere(accounts, params)})`,
      params,
    );
  }
}

// ---- deals ---------------------------------------------------------------------------------

function dealFromRow(row: Row): Deal {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    item: str(row, "reward_item"),
    count: num(row, "reward_count"),
    value: num(row, "reward_value"),
    task: str(row, "task"),
    prepaid: bool(row, "prepaid"),
    escrow: optStr(row, "escrow_entry"),
    status: str(row, "status") as DealStatus,
    created_at: ts(row, "created_at"),
    done_at: optTs(row, "done_at"),
    due_at: optTs(row, "due_at"),
    closed_at: optTs(row, "closed_at"),
  };
}

/** `status IN (...)` over `statuses`, its parameters added to `params`. */
function statusIn(statuses: readonly string[], params: Params): string {
  const names = statuses.map((s, i) => {
    params[`s${i}`] = s;
    return `$s${i}`;
  });
  return `status IN (${names.join(", ")})`;
}

class SqliteDeals implements DealStore {
  constructor(private readonly db: Db) {}

  async create(deal: Deal): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO deals (id, profile_id, author_platform, author_id, reward_item, " +
          "reward_count, reward_value, task, prepaid, escrow_entry, status, created_at, " +
          "done_at, due_at, closed_at) VALUES ($id, $profile, $platform, $account, $item, " +
          "$count, $value, $task, $prepaid, $escrow, $status, $created, $done, $due, $closed)",
        {
          id: deal.id,
          profile: deal.profile,
          platform: deal.account.platform,
          account: deal.account.id,
          item: deal.item,
          count: deal.count,
          value: deal.value,
          task: deal.task,
          prepaid: deal.prepaid ? 1 : 0,
          escrow: deal.escrow,
          status: deal.status,
          created: toMicros(deal.created_at),
          done: optionalMicros(deal.done_at),
          due: optionalMicros(deal.due_at),
          closed: optionalMicros(deal.closed_at),
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the deal", { cause });
    }
  }

  async get(id: string): Promise<Deal | null> {
    const row = this.db.get("SELECT * FROM deals WHERE id = $id", { id });
    return row ? dealFromRow(row) : null;
  }

  async transition(id: string, from: readonly DealStatus[], patch: DealPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const params: Params = { id, status: patch.status };
    const sets = ["status = $status"];
    for (const [column, value] of [
      ["done_at", patch.done_at],
      ["due_at", patch.due_at],
      ["closed_at", patch.closed_at],
    ] as const) {
      if (value === undefined) continue;
      params[column] = optionalMicros(value);
      sets.push(`${column} = $${column}`);
    }
    return (
      this.db.run(
        `UPDATE deals SET ${sets.join(", ")} WHERE id = $id AND ${statusIn(from, params)}`,
        params,
      ) > 0
    );
  }

  async forAccounts(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { statuses?: readonly DealStatus[]; since?: Timestamp; limit: number },
  ): Promise<Deal[]> {
    if (accounts.length === 0 || filter.statuses?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = `profile_id = $profile AND (${authorsWhere(accounts, params)})`;
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    if (filter.since !== undefined) {
      params.since = toMicros(filter.since);
      where += " AND created_at >= $since";
    }
    const rows = this.db.all(
      `SELECT * FROM deals WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(dealFromRow);
  }

  async byStatus(
    profile: ProfileId,
    statuses: readonly DealStatus[],
    filter: { since?: Timestamp; limit: number },
  ): Promise<Deal[]> {
    if (statuses.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = `profile_id = $profile AND ${statusIn(statuses, params)}`;
    if (filter.since !== undefined) {
      params.since = toMicros(filter.since);
      where += " AND created_at >= $since";
    }
    const rows = this.db.all(
      `SELECT * FROM deals WHERE ${where} ORDER BY created_at, rowid LIMIT $limit`,
      params,
    );
    return rows.map(dealFromRow);
  }
}

// ---- goals and bounties --------------------------------------------------------------------

function goalFromRow(row: Row): Goal {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    title: str(row, "title"),
    promise: str(row, "promise"),
    target: num(row, "target"),
    status: str(row, "status") as GoalStatus,
    created_at: ts(row, "created_at"),
    deadline: ts(row, "deadline"),
    closed_at: optTs(row, "closed_at"),
    ...fulfilledOf(row),
  };
}

/** The kept-promise columns of a goal row; nothing while it is owed. */
function fulfilledOf(row: Row): Pick<Goal, "fulfilled_at" | "fulfilled_by"> {
  const at = optTs(row, "fulfilled_at");
  if (at === null) return {};
  return {
    fulfilled_at: at,
    fulfilled_by: optStr(row, "fulfilled_by") === "self" ? "self" : "owner",
  };
}

function pledgeFromRow(row: Row): GoalPledge {
  return {
    id: str(row, "id"),
    goal: str(row, "goal_id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    amount: num(row, "amount"),
    created_at: ts(row, "created_at"),
  };
}

class SqliteGoals implements GoalStore {
  constructor(private readonly db: Db) {}

  async create(goal: Goal): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO goals (id, profile_id, title, promise, target, status, created_at, " +
          "deadline, closed_at) VALUES ($id, $profile, $title, $promise, $target, $status, " +
          "$created, $deadline, $closed)",
        {
          id: goal.id,
          profile: goal.profile,
          title: goal.title,
          promise: goal.promise,
          target: goal.target,
          status: goal.status,
          created: toMicros(goal.created_at),
          deadline: toMicros(goal.deadline),
          closed: optionalMicros(goal.closed_at),
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the goal", { cause });
    }
  }

  async get(id: string): Promise<Goal | null> {
    const row = this.db.get("SELECT * FROM goals WHERE id = $id", { id });
    return row ? goalFromRow(row) : null;
  }

  async transition(id: string, from: readonly GoalStatus[], patch: GoalPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const params: Params = { id, status: patch.status };
    const sets = ["status = $status"];
    if (patch.closed_at !== undefined) {
      params.closed_at = optionalMicros(patch.closed_at);
      sets.push("closed_at = $closed_at");
    }
    return (
      this.db.run(
        `UPDATE goals SET ${sets.join(", ")} WHERE id = $id AND ${statusIn(from, params)}`,
        params,
      ) > 0
    );
  }

  async list(
    profile: ProfileId,
    filter: { statuses?: readonly GoalStatus[]; limit: number },
  ): Promise<Goal[]> {
    if (filter.statuses?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = "profile_id = $profile";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    const rows = this.db.all(
      `SELECT * FROM goals WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(goalFromRow);
  }

  async fulfill(id: string, by: GoalFulfiller, at: Timestamp): Promise<boolean> {
    return (
      this.db.run(
        "UPDATE goals SET fulfilled_at = $at, fulfilled_by = $by WHERE id = $id AND " +
          "status = 'reached' AND fulfilled_at IS NULL",
        { id, by, at: toMicros(at) },
      ) > 0
    );
  }

  async addPledge(pledge: GoalPledge): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO goal_pledges (id, goal_id, profile_id, author_platform, author_id, " +
          "amount, created_at) VALUES ($id, $goal, $profile, $platform, $account, $amount, " +
          "$created)",
        {
          id: pledge.id,
          goal: pledge.goal,
          profile: pledge.profile,
          platform: pledge.account.platform,
          account: pledge.account.id,
          amount: pledge.amount,
          created: toMicros(pledge.created_at),
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the pledge", { cause });
    }
  }

  async pledges(goal: string): Promise<GoalPledge[]> {
    const rows = this.db.all(
      "SELECT * FROM goal_pledges WHERE goal_id = $goal ORDER BY created_at, rowid",
      { goal },
    );
    return rows.map(pledgeFromRow);
  }
}

function bountyFromRow(row: Row): Bounty {
  const platform = optStr(row, "winner_platform");
  const id = optStr(row, "winner_id");
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    task: str(row, "task"),
    reward: num(row, "reward"),
    hold: str(row, "hold_entry"),
    status: str(row, "status") as BountyStatus,
    created_at: ts(row, "created_at"),
    expires_at: ts(row, "expires_at"),
    closed_at: optTs(row, "closed_at"),
    winner: platform !== null && id !== null ? { platform, id } : null,
  };
}

class SqliteBounties implements BountyStore {
  constructor(private readonly db: Db) {}

  async create(bounty: Bounty): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO bounties (id, profile_id, task, reward, hold_entry, status, created_at, " +
          "expires_at, closed_at, winner_platform, winner_id) VALUES ($id, $profile, $task, " +
          "$reward, $hold, $status, $created, $expires, $closed, $platform, $winner)",
        {
          id: bounty.id,
          profile: bounty.profile,
          task: bounty.task,
          reward: bounty.reward,
          hold: bounty.hold,
          status: bounty.status,
          created: toMicros(bounty.created_at),
          expires: toMicros(bounty.expires_at),
          closed: optionalMicros(bounty.closed_at),
          platform: bounty.winner?.platform ?? null,
          winner: bounty.winner?.id ?? null,
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the bounty", { cause });
    }
  }

  async get(id: string): Promise<Bounty | null> {
    const row = this.db.get("SELECT * FROM bounties WHERE id = $id", { id });
    return row ? bountyFromRow(row) : null;
  }

  async transition(
    id: string,
    from: readonly BountyStatus[],
    patch: BountyPatch,
  ): Promise<boolean> {
    if (from.length === 0) return false;
    const params: Params = { id, status: patch.status };
    const sets = ["status = $status"];
    if (patch.closed_at !== undefined) {
      params.closed_at = optionalMicros(patch.closed_at);
      sets.push("closed_at = $closed_at");
    }
    if (patch.winner !== undefined) {
      params.winner_platform = patch.winner?.platform ?? null;
      params.winner_id = patch.winner?.id ?? null;
      sets.push("winner_platform = $winner_platform", "winner_id = $winner_id");
    }
    return (
      this.db.run(
        `UPDATE bounties SET ${sets.join(", ")} WHERE id = $id AND ${statusIn(from, params)}`,
        params,
      ) > 0
    );
  }

  async list(
    profile: ProfileId,
    filter: { statuses?: readonly BountyStatus[]; limit: number },
  ): Promise<Bounty[]> {
    if (filter.statuses?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = "profile_id = $profile";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    const rows = this.db.all(
      `SELECT * FROM bounties WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(bountyFromRow);
  }
}

// ---- economy documents ---------------------------------------------------------------------

function docFromRow(row: Row): EconomyDoc {
  const platform = optStr(row, "owner_platform");
  const id = optStr(row, "owner_id");
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    kind: str(row, "kind"),
    owner: platform !== null && id !== null ? { platform, id } : null,
    status: str(row, "status"),
    version: num(row, "version"),
    data: json<JsonObject>(row, "data", "economy document"),
    created_at: ts(row, "created_at"),
    updated_at: ts(row, "updated_at"),
  };
}

class SqliteEconomyDocs implements EconomyDocStore {
  constructor(private readonly db: Db) {}

  async create(doc: EconomyDoc): Promise<boolean> {
    try {
      return (
        this.db.run(
          "INSERT INTO economy_docs (profile_id, kind, id, owner_platform, owner_id, status, " +
            "version, data, created_at, updated_at) VALUES ($profile, $kind, $id, $platform, " +
            "$owner, $status, $version, $data, $created, $updated) ON CONFLICT DO NOTHING",
          {
            profile: doc.profile,
            kind: doc.kind,
            id: doc.id,
            platform: doc.owner?.platform ?? null,
            owner: doc.owner?.id ?? null,
            status: doc.status,
            version: doc.version,
            data: JSON.stringify(doc.data),
            created: toMicros(doc.created_at),
            updated: toMicros(doc.updated_at),
          },
        ) > 0
      );
    } catch (cause) {
      throw new StoreError("cannot write the economy document", { cause });
    }
  }

  async get(profile: ProfileId, kind: string, id: string): Promise<EconomyDoc | null> {
    const row = this.db.get(
      "SELECT * FROM economy_docs WHERE profile_id = $profile AND kind = $kind AND id = $id",
      { profile, kind, id },
    );
    return row ? docFromRow(row) : null;
  }

  async update(
    profile: ProfileId,
    kind: string,
    id: string,
    expected: number,
    next: DocUpdate,
  ): Promise<boolean> {
    const params: Params = {
      profile,
      kind,
      id,
      expected,
      status: next.status,
      data: JSON.stringify(next.data),
      at: toMicros(next.at),
    };
    let owner = "";
    if (next.owner !== undefined) {
      params.platform = next.owner?.platform ?? null;
      params.owner = next.owner?.id ?? null;
      owner = ", owner_platform = $platform, owner_id = $owner";
    }
    try {
      return (
        this.db.run(
          "UPDATE economy_docs SET status = $status, data = $data, version = version + 1, " +
            `updated_at = $at${owner} WHERE profile_id = $profile AND kind = $kind AND ` +
            "id = $id AND version = $expected",
          params,
        ) > 0
      );
    } catch (cause) {
      throw new StoreError("cannot update the economy document", { cause });
    }
  }

  async list(profile: ProfileId, kind: string, filter: DocFilter): Promise<EconomyDoc[]> {
    if (filter.statuses?.length === 0 || filter.owners?.length === 0) return [];
    const params: Params = { profile, kind, limit: limitParam(filter.limit) };
    let where = "profile_id = $profile AND kind = $kind";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    if (filter.owners) {
      const who = filter.owners.map((a, i) => {
        params[`op${i}`] = a.platform;
        params[`oi${i}`] = a.id;
        return `(owner_platform = $op${i} AND owner_id = $oi${i})`;
      });
      where += ` AND (${who.join(" OR ")})`;
    }
    const rows = this.db.all(
      `SELECT * FROM economy_docs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $limit`,
      params,
    );
    return rows.map(docFromRow);
  }
}

// ---- module state -------------------------------------------------------------------------

class SqliteModuleState implements ModuleStateStore {
  constructor(private readonly db: Db) {}

  async get(module: ModuleId): Promise<boolean | null> {
    const row = this.db.get("SELECT enabled FROM module_state WHERE module_id = $module", {
      module,
    });
    return row ? bool(row, "enabled") : null;
  }

  async set(module: ModuleId, enabled: boolean): Promise<void> {
    this.db.run(
      "INSERT INTO module_state (module_id, enabled, updated_at) VALUES ($module, $enabled, " +
        "$at) ON CONFLICT (module_id) DO UPDATE SET enabled = excluded.enabled, " +
        "updated_at = excluded.updated_at",
      { module, enabled: enabled ? 1 : 0, at: this.db.nowMicros() },
    );
  }

  async list(): Promise<Map<ModuleId, boolean>> {
    const rows = this.db.all("SELECT module_id, enabled FROM module_state ORDER BY module_id");
    return new Map(rows.map((r) => [str(r, "module_id"), bool(r, "enabled")]));
  }
}

// ---- persona overrides --------------------------------------------------------------------

class SqlitePersonaOverrides implements PersonaOverrideStore {
  constructor(private readonly db: Db) {}

  async set(profile: ProfileId, key: string, body: string, editedBy: string): Promise<number> {
    // One statement: the next version is computed under SQLite's write lock.
    const row = this.db.get(
      "INSERT INTO persona_overrides (profile_id, section_key, version, body, edited_by, " +
        "edited_at) SELECT $profile, $key, COALESCE(MAX(version), 0) + 1, $body, $by, $at " +
        "FROM persona_overrides WHERE profile_id = $profile AND section_key = $key " +
        "RETURNING version",
      { profile, key, body, by: editedBy, at: this.db.nowMicros() },
    );
    if (!row) throw new StoreError("cannot store persona override");
    return num(row, "version");
  }

  async current(profile: ProfileId): Promise<Map<string, string>> {
    const rows = this.db.all(
      "SELECT section_key, body FROM persona_overrides o WHERE profile_id = $profile AND " +
        "version = (SELECT MAX(version) FROM persona_overrides WHERE profile_id = " +
        "o.profile_id AND section_key = o.section_key) ORDER BY section_key",
      { profile },
    );
    return new Map(rows.map((r) => [str(r, "section_key"), str(r, "body")]));
  }

  async history(profile: ProfileId, key: string): Promise<PersonaOverride[]> {
    const rows = this.db.all(
      "SELECT version, body, edited_by, edited_at FROM persona_overrides " +
        "WHERE profile_id = $profile AND section_key = $key ORDER BY version ASC",
      { profile, key },
    );
    return rows.map((r) => ({
      profile,
      key,
      version: num(r, "version"),
      body: str(r, "body"),
      edited_by: str(r, "edited_by"),
      edited_at: ts(r, "edited_at"),
    }));
  }
}

// ---- settings -----------------------------------------------------------------------------

class SqliteSettings implements SettingsStore {
  constructor(private readonly db: Db) {}

  async get(profile: ProfileId, key: string): Promise<JsonValue | null> {
    const row = this.db.get(
      "SELECT value FROM profile_settings WHERE profile_id = $profile AND key = $key",
      { profile, key },
    );
    return row ? json<JsonValue>(row, "value", "setting") : null;
  }

  async set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void> {
    if (value === null) {
      this.db.run("DELETE FROM profile_settings WHERE profile_id = $profile AND key = $key", {
        profile,
        key,
      });
      return;
    }
    this.db.run(
      "INSERT INTO profile_settings (profile_id, key, value, updated_at) VALUES ($profile, " +
        "$key, $value, $at) ON CONFLICT (profile_id, key) DO UPDATE SET value = " +
        "excluded.value, updated_at = excluded.updated_at",
      { profile, key, value: JSON.stringify(value), at: this.db.nowMicros() },
    );
  }

  async list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>> {
    // `substr` instead of `LIKE`, so `%` and `_` in the prefix are literal (and case matters).
    const rows = this.db.all(
      "SELECT key, value FROM profile_settings WHERE profile_id = $profile AND " +
        "substr(key, 1, length($prefix)) = $prefix ORDER BY key",
      { profile, prefix },
    );
    return new Map(rows.map((r) => [str(r, "key"), json<JsonValue>(r, "value", "setting")]));
  }

  async deletePrefix(profile: ProfileId, prefix: string): Promise<number> {
    return this.db.run(
      "DELETE FROM profile_settings WHERE profile_id = $profile AND " +
        "substr(key, 1, length($prefix)) = $prefix",
      { profile, prefix },
    );
  }
}

// ---- whole-profile export / wipe ----------------------------------------------------------

class SqliteProfileData implements ProfileDataStore {
  constructor(private readonly db: Db) {}

  #query = async (stmt: Stmt) => this.db.allStmt(stmt);

  async inventory(profile: ProfileId): Promise<DataInventory> {
    return readInventory(SQLITE_DIALECT, this.#query, profile, fromMicros(this.db.nowMicros()));
  }

  async export(profile: ProfileId, categories: readonly DataCategoryId[]): Promise<DataExport> {
    const now = fromMicros(this.db.nowMicros());
    return readExport(SQLITE_DIALECT, this.#query, profile, categories, now);
  }

  async wipe(
    profile: ProfileId,
    categories: readonly DataCategoryId[],
    options: WipeOptions = {},
  ): Promise<WipeCounts> {
    const statements = wipeStatements(SQLITE_DIALECT, profile, categories, options);
    try {
      return this.db.tx(() => {
        const counts: WipeCounts = {};
        for (const { part, stmt } of statements) addCount(counts, part, this.db.runStmt(stmt));
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

// ---- auth and audit -----------------------------------------------------------------------

function assignmentFromRow(row: Row): RoleAssignment {
  return {
    account: { platform: str(row, "platform"), id: str(row, "account_id") },
    role: str(row, "role"),
    scope: json<AuthScope>(row, "scope", "auth scope"),
    granted_by: str(row, "granted_by"),
    at: ts(row, "at"),
  };
}

const ASSIGNMENT_ORDER = "at, platform, account_id, role, scope";

class SqliteAuth implements AuthStore {
  constructor(private readonly db: Db) {}

  async roles(): Promise<RoleDefinition[]> {
    return this.db.all("SELECT * FROM roles ORDER BY rank DESC, name").map((r) => ({
      name: str(r, "name"),
      rank: num(r, "rank"),
      grants: json<string[]>(r, "grants", "role grants"),
      denies: json<string[]>(r, "denies", "role denies"),
      builtin: bool(r, "builtin"),
    }));
  }

  async upsertRole(role: RoleDefinition): Promise<void> {
    this.db.run(
      "INSERT INTO roles (name, rank, grants, denies, builtin) VALUES ($name, $rank, $grants, " +
        "$denies, $builtin) ON CONFLICT (name) DO UPDATE SET rank = excluded.rank, grants = " +
        "excluded.grants, denies = excluded.denies, builtin = excluded.builtin",
      {
        name: role.name,
        rank: role.rank,
        grants: JSON.stringify(role.grants),
        denies: JSON.stringify(role.denies),
        builtin: role.builtin ? 1 : 0,
      },
    );
  }

  async deleteRole(name: string): Promise<boolean> {
    return this.db.tx(() => {
      const row = this.db.get("SELECT builtin FROM roles WHERE name = $name", { name });
      if (!row) return false;
      if (bool(row, "builtin")) throw new StoreError(`role \`${name}\` is built in`);
      for (const table of ["role_assignments", "role_mappings", "node_overrides"]) {
        this.db.run(`DELETE FROM ${table} WHERE role = $name`, { name });
      }
      this.db.run("DELETE FROM roles WHERE name = $name", { name });
      return true;
    });
  }

  async assignmentsFor(account: AccountRef): Promise<RoleAssignment[]> {
    return this.db
      .all(
        "SELECT * FROM role_assignments WHERE platform = $platform AND account_id = $id " +
          `ORDER BY ${ASSIGNMENT_ORDER}`,
        { platform: account.platform, id: account.id },
      )
      .map(assignmentFromRow);
  }

  async allAssignments(): Promise<RoleAssignment[]> {
    return this.db
      .all(`SELECT * FROM role_assignments ORDER BY ${ASSIGNMENT_ORDER}`)
      .map(assignmentFromRow);
  }

  async assign(a: RoleAssignment): Promise<void> {
    this.db.run(
      "INSERT INTO role_assignments (platform, account_id, role, scope, granted_by, at) " +
        "VALUES ($platform, $id, $role, $scope, $by, $at) ON CONFLICT (platform, account_id, " +
        "role, scope) DO UPDATE SET granted_by = excluded.granted_by, at = excluded.at",
      {
        platform: a.account.platform,
        id: a.account.id,
        role: a.role,
        scope: authScopeKey(a.scope),
        by: a.granted_by,
        at: toMicros(a.at),
      },
    );
  }

  async revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM role_assignments WHERE platform = $platform AND account_id = $id AND " +
        "role = $role AND scope = $scope",
      { platform: account.platform, id: account.id, role, scope: authScopeKey(scope) },
    );
    return removed > 0;
  }

  async mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]> {
    return this.db
      .all(
        "SELECT platform_role, role FROM role_mappings WHERE platform = $platform AND " +
          "guild = $guild ORDER BY platform_role",
        { platform, guild },
      )
      .map((r) => ({
        platform,
        guild,
        platform_role: str(r, "platform_role"),
        role: str(r, "role"),
      }));
  }

  async setMapping(m: RoleMapping): Promise<void> {
    this.db.run(
      "INSERT INTO role_mappings (platform, guild, platform_role, role) VALUES ($platform, " +
        "$guild, $platform_role, $role) ON CONFLICT (platform, guild, platform_role) " +
        "DO UPDATE SET role = excluded.role",
      { platform: m.platform, guild: m.guild, platform_role: m.platform_role, role: m.role },
    );
  }

  async removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM role_mappings WHERE platform = $platform AND guild = $guild AND " +
        "platform_role = $platform_role",
      { platform, guild, platform_role: platformRole },
    );
    return removed > 0;
  }

  async overrides(): Promise<NodeOverride[]> {
    return this.db.all("SELECT * FROM node_overrides ORDER BY scope, role, node").map((r) => ({
      scope: json<AuthScope>(r, "scope", "auth scope"),
      role: str(r, "role"),
      node: str(r, "node"),
      allow: bool(r, "allow"),
    }));
  }

  async setOverride(o: NodeOverride): Promise<void> {
    this.db.run(
      "INSERT INTO node_overrides (scope, role, node, allow) VALUES ($scope, $role, $node, " +
        "$allow) ON CONFLICT (scope, role, node) DO UPDATE SET allow = excluded.allow",
      { scope: authScopeKey(o.scope), role: o.role, node: o.node, allow: o.allow ? 1 : 0 },
    );
  }

  async removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM node_overrides WHERE scope = $scope AND role = $role AND node = $node",
      { scope: authScopeKey(scope), role, node },
    );
    return removed > 0;
  }
}

// ---- event log ----------------------------------------------------------------------------

function directiveFromRow(row: Row): DirectiveRecord {
  return {
    id: str(row, "id"),
    issuer: json<AccountRef>(row, "issuer", "directive issuer"),
    authority: str(row, "authority") as DirectiveRecord["authority"],
    scope: json<DirectiveRecord["scope"]>(row, "scope", "directive scope"),
    effect: str(row, "effect") as DirectiveRecord["effect"],
    text: str(row, "text"),
    expires: optTs(row, "expires") ?? "until_revoked",
    source_event: str(row, "source_event"),
    created_at: ts(row, "created_at"),
    revoked_at: optTs(row, "revoked_at"),
    revoked_by: optStr(row, "revoked_by"),
  };
}

class SqliteDirectives implements DirectiveStore {
  constructor(private readonly db: Db) {}

  async insert(profile: ProfileId, d: Directive): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO directives (id, profile_id, issuer, authority, scope, effect, text, " +
          "expires, source_event, created_at) VALUES ($id, $profile, $issuer, $authority, " +
          "$scope, $effect, $text, $expires, $source_event, $created_at)",
        {
          id: d.id,
          profile,
          issuer: JSON.stringify(d.issuer),
          authority: d.authority,
          scope: JSON.stringify(d.scope),
          effect: d.effect,
          text: d.text,
          expires: d.expires === "until_revoked" ? null : toMicros(d.expires),
          source_event: d.source_event,
          created_at: toMicros(d.created_at),
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store the directive", { cause });
    }
  }

  async active(profile: ProfileId, now: Timestamp): Promise<DirectiveRecord[]> {
    return this.db
      .all(
        "SELECT * FROM directives WHERE profile_id = $profile AND revoked_at IS NULL " +
          "AND (expires IS NULL OR expires > $now) ORDER BY created_at, id",
        { profile, now: toMicros(now) },
      )
      .map(directiveFromRow);
  }

  async all(profile: ProfileId, limit: number): Promise<DirectiveRecord[]> {
    return this.db
      .all(
        "SELECT * FROM directives WHERE profile_id = $profile " +
          "ORDER BY created_at DESC, id DESC LIMIT $limit",
        { profile, limit: limitParam(limit) },
      )
      .map(directiveFromRow);
  }

  async revoke(profile: ProfileId, id: string, by: string, at: Timestamp): Promise<boolean> {
    const changed = this.db.run(
      "UPDATE directives SET revoked_at = $at, revoked_by = $by " +
        "WHERE id = $id AND profile_id = $profile AND revoked_at IS NULL",
      { id, profile, by, at: toMicros(at) },
    );
    return changed > 0;
  }

  async prune(profile: ProfileId, before: Timestamp): Promise<number> {
    return this.db.run(
      "DELETE FROM directives WHERE profile_id = $profile " +
        "AND (revoked_at < $before OR expires < $before)",
      { profile, before: toMicros(before) },
    );
  }
}

// ---- the store ----------------------------------------------------------------------------

/** Every storage area on one SQLite database. */
export class SqliteStore implements Store {
  readonly messages: MessageLog;
  readonly moduleState: ModuleStateStore;
  readonly personaOverrides: PersonaOverrideStore;
  readonly people: PeopleStore;
  /** Decisions and turn outcomes on the event log. */
  readonly decisions: TurnLog;
  readonly settings: SettingsStore;
  readonly memories: MemoryRecordStore;
  readonly relationships: RelationshipStore;
  readonly identity: IdentityStore;
  readonly auth: AuthStore;
  /** Audit entries on the event log. */
  readonly audit: AuditTrail;
  readonly profileData: ProfileDataStore;
  readonly events: EventStore;
  /** Chat lines on the event log; `messages` is the same object. */
  readonly chat: ChatLog;
  readonly directives: DirectiveStore;
  readonly cards: MemberCardStore;
  readonly coins: CoinLedgerStore;
  readonly deals: DealStore;
  readonly fortunes: FortuneStore;
  readonly goals: GoalStore;
  readonly bounties: BountyStore;
  readonly economyDocs: EconomyDocStore;
  /** Persons, accounts and places (the `identity` plugin's tables). */
  readonly persons: Identity;
  readonly handles: PersonHandleDirectory;
  readonly #db: Db;

  private constructor(db: Db) {
    this.#db = db;
    this.persons = new Identity(db);
    this.moduleState = new SqliteModuleState(db);
    this.personaOverrides = new SqlitePersonaOverrides(db);
    this.people = new IdentityPeople(this.persons);
    this.settings = new PrefsSettings(new SqliteSettings(db), this.persons);
    this.memories = new SqliteMemories(db);
    this.relationships = new SqliteRelationships(db);
    this.identity = new IdentityLinks(this.persons);
    this.handles = new IdentityHandles(this.persons);
    this.auth = new SqliteAuth(db);
    this.profileData = new SqliteProfileData(db);
    this.events = new EventStore(db, { identity: this.persons });
    this.chat = new ChatLog(db, this.events, this.persons);
    this.messages = this.chat;
    this.decisions = new TurnLog(db, this.events, this.persons);
    this.audit = new AuditTrail(db, this.events, this.persons);
    this.directives = new SqliteDirectives(db);
    this.cards = new SqliteMemberCards(db);
    this.coins = new SqliteCoins(db);
    this.deals = new SqliteDeals(db);
    this.fortunes = new SqliteFortunes(db);
    this.goals = new SqliteGoals(db);
    this.bounties = new SqliteBounties(db);
    this.economyDocs = new SqliteEconomyDocs(db);
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
      migrate(db, [identitySchema, legacySchema, ...(options.schemas ?? [])], { location: path });
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteStore(db);
  }

  /** Versions of the `legacy` schema recorded in `_migrations`, ascending. */
  async schemaVersions(): Promise<number[]> {
    return schemaVersions(this.#db, legacySchema.plugin);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
