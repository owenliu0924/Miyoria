// `[modules.market]` (docs/design/v5-play.md §4.5, §11.1, §11.4): the song priority ticket, the
// weekly auction and the weekly lottery. Every field has a default (the owner's numbers of
// 2026-11-17); the auction runs only in a channel (`auction_channel`), the lottery always (its
// notices need a channel too). Weekdays count from Sunday (0) to Saturday (6), in her local time.

import { z } from "zod";

/** The lot kinds the auction knows (first batch, owner 2026-11-17). */
export const LOT_KINDS = ["call_name", "frame"] as const;
export type LotKind = (typeof LOT_KINDS)[number];

const clock = () =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour")
    .default("20:00");
const weekday = (d: number) => z.number().int().min(0).max(6).default(d);
/** A Discord channel id (empty: none). */
const channel = () =>
  z
    .string()
    .regex(/^(\d{5,30})?$/, "a channel id")
    .default("");

/**
 * ```toml
 * [modules.market]
 * auction_channel = "123456789012345678"
 * ```
 */
export const MarketConfigSchema = z.object({
  /** Her local time zone as a UTC offset: what a day and a week are. */
  utc_offset_minutes: z
    .number()
    .int()
    .min(-720)
    .max(840)
    .default(8 * 60),

  // ---- the song priority ticket (點歌優先券) ----
  /** Coins per ticket. */
  song_priority: z.number().int().positive().default(40),
  /** Tickets one person may use per local day; 0: not on sale. */
  song_priority_per_day: z.number().int().nonnegative().default(2),

  // ---- the weekly auction (每週拍賣) ----
  /** Off: no new lot opens, and an open one is called off with every bid given back. */
  auction: z.boolean().default(true),
  /** Where the lot is posted and bid on; empty: the auction does not run. */
  auction_channel: channel(),
  /** The day and time a lot opens (default Saturday 20:00). */
  auction_weekday: weekday(6),
  auction_time: clock(),
  /** How long a lot is open. */
  auction_hours: z.number().int().min(1).max(144).default(24),
  /** The smallest first bid. */
  auction_opening_bid: z.number().int().positive().default(50),
  /** The smallest raise over the top bid. */
  auction_step: z.number().int().positive().default(5),
  /** A bid this close to the end moves the end this much later. */
  auction_extend_mins: z.number().int().min(0).max(60).default(5),
  /** The lot kinds she picks from (and the rotation goes through). */
  auction_lots: z
    .array(z.enum(LOT_KINDS))
    .min(1)
    .default([...LOT_KINDS]),
  /** How long the won name is what she calls the winner. */
  auction_call_days: z.number().int().min(1).max(30).default(7),
  /** How long the winner of a name has to give one she accepts; after that it is refunded. */
  auction_name_hours: z.number().int().min(1).max(168).default(72),
  /** The model chain she picks the week's lot with (`[llm.purposes]`; unset: the chat chain). */
  auction_purpose: z.string().default("market"),

  // ---- the weekly lottery (每週樂透) ----
  /** Off: no tickets are sold, and the open week is refunded. */
  lottery: z.boolean().default(true),
  /** Where the week's notice and the draw go; empty: the auction's channel. */
  lottery_channel: channel(),
  /** Coins per ticket. */
  lottery_price: z.number().int().positive().default(10),
  /** Tickets one person may buy per week. */
  lottery_per_week: z.number().int().positive().default(20),
  /** The prize's share of the week's sales; the rest is burned. */
  lottery_prize_share: z.number().min(0).max(1).default(0.7),
  /** The day and time of the draw (default Sunday 20:00). */
  lottery_weekday: weekday(0),
  lottery_time: clock(),
  /** Fewer different buyers than this: no draw, every ticket refunded. */
  lottery_min_buyers: z.number().int().min(1).default(3),
});

export type MarketConfig = z.output<typeof MarketConfigSchema>;

/** The defaults, optionally overridden. */
export function marketConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return { ...MarketConfigSchema.parse({}), ...overrides };
}

/** Where the lottery's notices go: its own channel, else the auction's; empty: nowhere. */
export function lotteryChannel(config: MarketConfig): string {
  return config.lottery_channel || config.auction_channel;
}
