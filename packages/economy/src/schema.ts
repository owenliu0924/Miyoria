// The tables of the `economy` plugin (docs/design/v5-data.md §3.2, §3.3), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and the store's
// drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together. One database
// is one character, so no table has a profile column.
//
// - `economy_ledger`: the coins (decision D8: money stays a table with its own constraints). A
//   row is never changed; a refund is a row; a balance is a sum. Its key is the wallet: a person
//   (identity's `persons.id`) or `PURSE`, her own. A person another one absorbed keeps its rows,
//   and they are the absorbing person's wallet too (`tables.ts`). No foreign key: her purse is no
//   person, and coins never go by a cascade; a wipe deletes them as a data category.
// - `economy_wallets`: what a person chose about their wallet (the card frame, leaving the
//   sponsor board). It goes with the person.
// - `economy_deals`: a bribe she accepted (docs/design/economy.md §12), by the account that made
//   it (identity's `accounts.id`); the speaker's wallet pays.

import { accounts, micros, persons } from "@miyoria/store";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const DEAL_STATUSES = [
  "open",
  "owed",
  "settled",
  "broken",
  "refunded",
  "cancelled",
] as const;

export const economyLedger = sqliteTable(
  "economy_ledger",
  {
    /** Commit order: a wallet's rows in the order they were written, never reused. */
    seq: integer().primaryKey({ autoIncrement: true }),
    /** ULID; a transfer's in row is its out row's id plus `~in` (`transfer.ts`). */
    id: text().notNull(),
    /** The wallet: a person, or `PURSE`. */
    person_id: text().notNull(),
    /** Positive: earned or refunded; negative: spent. A whole number (`STRICT`). */
    delta: integer().notNull(),
    /** `checkin`, `talked`, `voice`, `feed`, `letter`, `refund`, ... */
    reason: text().notNull(),
    /** What it is about: the food and count, the frame, her reason, the refunded row. */
    ref: text(),
    /** Counts once per wallet (a retried click, the day of a check-in); `null`: no key. */
    idem_key: text(),
    ts: micros().notNull(),
  },
  (t) => [
    uniqueIndex("economy_ledger_id_idx").on(t.id),
    // Once per person in the table; once per wallet (with the persons it absorbed) in `post`.
    uniqueIndex("economy_ledger_idem_idx").on(t.person_id, t.idem_key),
    index("economy_ledger_person_idx").on(t.person_id, t.ts),
    // Totals across everyone (what she gave today, the health table).
    index("economy_ledger_reason_idx").on(t.reason, t.ts),
  ],
);

export const economyWallets = sqliteTable("economy_wallets", {
  person_id: text()
    .primaryKey()
    .references(() => persons.id, { onDelete: "cascade" }),
  /** The card frame chosen; owning one is a `frame` row of the ledger. */
  frame: text(),
  /** When the frame was chosen; a row made only for the board is 0, the oldest. */
  updated_at: micros().notNull(),
  /** Left the sponsor board (it is opt-out). */
  off_board: integer({ mode: "boolean" }).notNull().default(false),
});

export const economyDeals = sqliteTable(
  "economy_deals",
  {
    /** ULID. */
    id: text().primaryKey(),
    /** The speaker; their wallet pays. */
    account_id: text()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    reward_item: text().notNull(),
    reward_count: integer().notNull(),
    /** What the reward costs in coins, fixed when the deal was made. */
    reward_value: integer().notNull(),
    task: text().notNull(),
    prepaid: integer({ mode: "boolean" }).notNull().default(false),
    /** The escrow's ledger row, for a prepaid deal. */
    escrow_entry: text(),
    status: text({ enum: DEAL_STATUSES }).notNull(),
    created_at: micros().notNull(),
    /** When she said she did the task. */
    done_at: micros(),
    /** Unpaid: when payment is due; prepaid: when the escrow is refunded if she has not done it. */
    due_at: micros(),
    closed_at: micros(),
  },
  (t) => [
    index("economy_deals_account_idx").on(t.account_id, t.created_at),
    index("economy_deals_status_idx").on(t.status, t.due_at),
    check("economy_deals_status_check", sql`${t.status} IN (${oneOf(DEAL_STATUSES)})`),
  ],
);

export type LedgerRow = typeof economyLedger.$inferSelect;
export type WalletRow = typeof economyWallets.$inferSelect;
export type DealRow = typeof economyDeals.$inferSelect;
