// The table of the `quota` plugin: each person's AI quota as it was spent (docs/design/v6-agent.md
// 「上限收成三種」), so a restart does not reset it.
//
// - `quota_spend`: micro-USD charged to one person in one slot. A `minute` slot (`key`: the epoch
//   minute) makes up the rolling hour and is pruned after an hour; a `day` slot (`key`: her local
//   date, `YYYY-MM-DD`) is her day and is pruned after the next one.
//
// `person` is the person id when she knows them, else the account (`platform:id`); no foreign key,
// like the transcripts. `quota-migrations.ts` holds the SQL drizzle-kit generates from this table,
// `STRICT` added; the store's drift test keeps the two together.

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** What a row counts: a minute of the rolling hour, or her day. */
export const QUOTA_SLOTS = ["minute", "day"] as const;
export type QuotaSlot = (typeof QUOTA_SLOTS)[number];

export const quotaSpend = sqliteTable(
  "quota_spend",
  {
    person: text().notNull(),
    slot: text({ enum: QUOTA_SLOTS }).notNull(),
    /** The epoch minute (decimal) or her local date. */
    key: text().notNull(),
    /** Micro-USD charged in the slot. */
    micros: integer().notNull().default(0),
    updated_at: micros().notNull(),
  },
  (t) => [
    primaryKey({ name: "quota_spend_pk", columns: [t.person, t.slot, t.key] }),
    index("quota_spend_slot_idx").on(t.slot, t.key),
    check("quota_spend_slot_check", sql`${t.slot} IN ('minute','day')`),
    check("quota_spend_micros_check", sql`${t.micros} >= 0`),
  ],
);

export type QuotaSpendRow = typeof quotaSpend.$inferSelect;
