// `[modules.economy.free_gifts]` (docs/design/economy.md §16): gifts a member names in their own
// words. The system prices them by picking one of `tiers` (never a number the model or the member
// writes), the member confirms the price, and she decides whether she takes it.

import { z } from "zod";

/** How many price tiers there are; the model picks one of them by letter. */
export const GIFT_TIERS = 4;

const tierList = (item: z.ZodNumber, fallback: number[]) =>
  z.array(item).length(GIFT_TIERS).default(fallback);

export const FreeGiftConfigSchema = z
  .object({
    /** Members may name a gift in their own words (the fixed foods are not affected). */
    on: z.boolean().default(true),
    /**
     * What each tier costs, cheapest first: a small thing, an ordinary one, a thoughtful one, a
     * splurge. A day of being around earns about 55, so the top tier is about three days of it.
     */
    tiers: tierList(z.number().int().positive(), [5, 20, 50, 150]).refine(
      (t) => t.every((p, i) => i === 0 || p > (t[i - 1] ?? 0)),
      { message: "tiers go from the cheapest up" },
    ),
    /**
     * How much hunger food of each tier takes off her (a drink half of it). Free-form food counts
     * against the same `feed_hunger_cap` as rice: what one person may take off her in a day.
     */
    tier_hunger: tierList(z.number().min(0).max(1), [0.05, 0.15, 0.3, 0.5]),
    /** The tier used when the price cannot be asked (no model, a failure); the notice says so. */
    fallback_tier: z.number().int().min(1).max(GIFT_TIERS).default(2),
    /** Longest gift name, in characters. */
    max_chars: z.number().int().min(4).max(40).default(24),
    /** How long the member has to press 確認 (seconds); after that it costs nothing and is gone. */
    confirm_s: z.number().int().min(30).max(1800).default(180),
    /**
     * How long she has to answer once it is confirmed (seconds); after that it is taken on her
     * behalf with a plain line, the way feeding never waits for her.
     */
    answer_s: z.number().int().min(30).max(3600).default(300),
    /** Gifts one person may give her in a local day (food and things together; `0`: none). */
    per_day: z.number().int().min(0).max(50).default(3),
    /** Coins one person may spend on these gifts in a local day. */
    coins_per_day: z.number().int().min(0).default(200),
    /** Gifts that are not food or drink, per person per local day. */
    objects_per_day: z.number().int().min(0).max(50).default(2),
    /** Price questions to the model one person may cause in a local day (cached names are free). */
    price_calls_per_person: z.number().int().min(0).max(100).default(5),
    /** Price questions to the model for everyone together in a local day. */
    price_calls_per_day: z.number().int().min(0).max(10_000).default(200),
    /** Longest wait for the price (seconds); then the fallback tier is used. */
    price_timeout_s: z.number().int().min(1).max(60).default(15),
  })
  .refine((c) => c.coins_per_day === 0 || c.coins_per_day >= (c.tiers[0] ?? 0), {
    message: "coins_per_day is below the cheapest tier",
  });
export type FreeGiftConfig = z.output<typeof FreeGiftConfigSchema>;

/** The defaults, for `EconomyConfigSchema`. */
export const DEFAULT_FREE_GIFTS: FreeGiftConfig = FreeGiftConfigSchema.parse({});
