// What the economy keeps on the store's database (`schema.ts`), as the rest of the economy reads
// and writes it: the record shapes, the interfaces `tables.ts` implements over the economy
// plugin's tables, and the service keys Core provides them under. One database is one character:
// the `profile` the interfaces still take is not part of any key (step 14 of
// docs/design/v5-data.md §8 drops it).
//
// A wallet is a person (identity's `persons.id`), with every person they absorbed, or her purse
// (`PURSE`). Callers that start from an account resolve its person through identity first
// (`EconomyService.member`).

import type { AccountRef, PersonId, ProfileId, Timestamp } from "@miyoria/types";
import { serviceKey } from "@miyoria/types";

/** The wallet of her purse: no person, reserved. */
export const PURSE: PersonId = "self";

// ---- coins ------------------------------------------------------------------------------

/** One row of the coin ledger (docs/design/economy.md §6). Rows are never changed. */
export interface CoinEntry {
  /** ULID. */
  id: string;
  /** The wallet it was written for: a person, or `PURSE`. */
  person: PersonId;
  /** Positive: earned or refunded; negative: spent. A whole number. */
  delta: number;
  /** `checkin`, `talked`, `voice`, `song`, `her_gift`, `feed`, `letter`, `refund`, ... */
  reason: string;
  ref: string | null;
  /** Counts once per wallet; `null`: no key. */
  idem_key: string | null;
  ts: Timestamp;
}

/** At most `limit` of `reasons` since `since`, summed over a wallet (`null`: everyone). */
export interface CoinCap {
  wallet: PersonId | null;
  reasons: readonly string[];
  since: Timestamp;
  limit: number;
}

/** What `CoinLedgerStore.post` checks in the same transaction besides the key. */
export interface CoinRule {
  /** Refused when the balance would go below zero. */
  covered?: boolean;
  /** Earnings: refused when a cap is reached. */
  caps?: readonly CoinCap[];
  /** With `caps`: post what still fits instead of refusing. */
  partial?: boolean;
}

/**
 * `posted`: written (`entry.delta` may be less than asked, with `partial`); `duplicate`: the key
 * was there, `entry` is the first row; `short`: not enough coins; `capped`: a cap is reached.
 */
export type CoinPost =
  | { status: "posted"; entry: CoinEntry; balance: number }
  | { status: "duplicate"; entry: CoinEntry; balance: number }
  | { status: "short"; balance: number }
  | { status: "capped"; balance: number };

/** Coins of one reason on one local day, from the ledger, all wallets. */
export interface LedgerDayTotal {
  /** The local day number: `floor((epoch_ms + offset) / 86_400_000)`. */
  day: number;
  reason: string;
  /** The sum of the rows with `delta > 0`. */
  positive: number;
  /** The sum of the rows with `delta < 0`, as a positive number. */
  negative: number;
}

/** Totals over the whole coin ledger, for the economy's health table (docs/design/v4-plan.md §10). */
export interface LedgerStatsStore {
  /**
   * Coins issued (positive rows) and recovered (negative rows) per local day and reason, from
   * `since` on, all wallets, her purse included. One `GROUP BY`; `offsetMinutes` is the local
   * time zone as minutes east of UTC.
   */
  dailyTotals(
    profile: ProfileId,
    since: Timestamp,
    offsetMinutes: number,
  ): Promise<LedgerDayTotal[]>;
}

/**
 * The coin ledger (docs/design/economy.md §6): append-only, the balance is a sum. `wallet` is a
 * person (with the persons they absorbed) or `PURSE`.
 */
export interface CoinLedgerStore extends LedgerStatsStore {
  /**
   * Appends `entry` in one transaction with its checks: the key (once per wallet), the caps of
   * `rule`, the balance.
   */
  post(entry: CoinEntry, rule?: CoinRule): Promise<CoinPost>;
  balance(profile: ProfileId, wallet: PersonId): Promise<number>;
  /** Rows of the wallet, newest first, at most `limit`; `reasons` and `since` narrow them. */
  entries(
    profile: ProfileId,
    wallet: PersonId,
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]>;
  /** The first row of the wallet with this key, or `null`. */
  byKey(profile: ProfileId, wallet: PersonId, key: string): Promise<CoinEntry | null>;
  /** The card frame the wallet chose last, or `null`. */
  selectedFrame(profile: ProfileId, wallet: PersonId): Promise<string | null>;
  selectFrame(
    profile: ProfileId,
    wallet: PersonId,
    frame: string | null,
    at: Timestamp,
  ): Promise<void>;
  /** Whether the wallet is on the sponsor board: yes unless it left. */
  onBoard(profile: ProfileId, wallet: PersonId): Promise<boolean>;
  /** Puts the wallet on the board or takes it off. It never touches the frame choice. */
  setOnBoard(profile: ProfileId, wallet: PersonId, on: boolean): Promise<void>;
  /** The persons that left the board, at most `limit`. */
  offBoard(profile: ProfileId, limit: number): Promise<PersonId[]>;
  /**
   * What each wallet spent since `since` on `reasons`, biggest first, at most `limit`: negative
   * rows that were not refunded. `deal_escrow` counts only for a settled deal (released to her).
   * A person another one absorbed is counted in the absorbing one's line; `account` is the
   * person's first account (`null` if it has none), her purse is never a line.
   */
  spent(
    profile: ProfileId,
    reasons: readonly string[],
    since: Timestamp,
    limit: number,
  ): Promise<{ person: PersonId; account: AccountRef | null; spent: number }[]>;
}

// ---- deals ------------------------------------------------------------------------------

/**
 * `open`: she took the deal, the task is not done; `owed`: she says it is done, payment awaited;
 * `settled`: paid (or escrow released); `broken`: not paid by its due time; `refunded`: escrow
 * returned; `cancelled`: ended with nothing to return.
 */
export type DealStatus = "open" | "owed" | "settled" | "broken" | "refunded" | "cancelled";

/** A bribe she accepted (docs/design/economy.md §12): someone's promise of a reward for a task. */
export interface Deal {
  /** ULID. */
  id: string;
  /** The account that made it (the speaker); its person's wallet pays. */
  account: AccountRef;
  /** `rice`, `big_bowl` or `dessert`. */
  item: string;
  count: number;
  /** What the reward costs in coins, fixed when the deal was made. */
  value: number;
  /** What she will do, short. */
  task: string;
  /** Paid into escrow at once (`escrow` is its ledger row). */
  prepaid: boolean;
  /** The escrow's coin ledger row id. */
  escrow: string | null;
  status: DealStatus;
  created_at: Timestamp;
  /** When she said she did it. */
  done_at: Timestamp | null;
  /** Unpaid deals: when payment is due once she is done; escrow deals: the refund time. */
  due_at: Timestamp | null;
  closed_at: Timestamp | null;
}

/** What `DealStore.transition` changes besides the status. */
export interface DealPatch {
  status: DealStatus;
  done_at?: Timestamp | null;
  due_at?: Timestamp | null;
  closed_at?: Timestamp | null;
}

/** Deals she accepted (docs/design/economy.md §12): they outlive restarts. */
export interface DealStore {
  create(deal: Deal): Promise<void>;
  get(id: string): Promise<Deal | null>;
  /**
   * Changes the deal only while its status is one of `from`; `false` when it was not (another
   * writer got there first, or it is gone). The one place a status moves.
   */
  transition(id: string, from: readonly DealStatus[], patch: DealPatch): Promise<boolean>;
  /** Deals of any of `accounts`, newest first; `statuses` and `since` (created) narrow them. */
  forAccounts(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { statuses?: readonly DealStatus[]; since?: Timestamp; limit: number },
  ): Promise<Deal[]>;
  /** Deals of everyone in these statuses, oldest first (the sweep, her context). */
  byStatus(
    profile: ProfileId,
    statuses: readonly DealStatus[],
    filter: { since?: Timestamp; limit: number },
  ): Promise<Deal[]>;
}

// Service keys: Core provides the economy plugin's tables under them (`store.plugin`).
export const CoinLedgerStoreKey = serviceKey<CoinLedgerStore>("CoinLedgerStore");
export const LedgerStatsKey = serviceKey<LedgerStatsStore>("LedgerStats");
export const DealStoreKey = serviceKey<DealStore>("DealStore");
