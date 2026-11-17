// The part of `[modules.cards]` about the cards she drops in a channel (docs/design/v5-play.md
// §6.2), spread into `CardsConfigSchema` (`config.ts`). Off by default, and on only in the channels
// listed. The design's draft numbers are the defaults where it gives one (three people, twenty
// lines, ten minutes; one a day per person; two or three a day per channel, here two); the rest are
// cautious choices of this module's (the chance, the gap, the delay, how long a drop lasts).
//
// ```toml
// [modules.cards]
// drops = true
// drop_channels = ["123456789012345678"]
// ```

import { z } from "zod";

export const DROP_CONFIG = {
  /** Whether she drops cards at all. Off by default; on, only in `drop_channels`. */
  drops: z.boolean().default(false),
  /** The channel ids (Discord snowflakes) where she may drop a card: each channel's own opt-in. */
  drop_channels: z.array(z.string().min(1)).default([]),
  /** A channel is lively when, within this many minutes, ... */
  drop_window_mins: z.number().int().positive().default(10),
  /** ... at least this many people ... */
  drop_min_people: z.number().int().positive().default(3),
  /** ... said at least this many lines together. */
  drop_min_lines: z.number().int().positive().default(20),
  /** The chance she drops one when a channel is lively, rolled at most once a window. */
  drop_chance: z.number().min(0).max(1).default(0.25),
  /** Drops per channel per local day, at most. */
  drops_per_channel_day: z.number().int().nonnegative().default(2),
  /** At least this many minutes between two drops in one channel. */
  drop_gap_mins: z.number().int().nonnegative().default(120),
  /** A drop appears after a random delay between these (seconds), so nobody can time it. */
  drop_delay_min_secs: z.number().int().nonnegative().default(30),
  drop_delay_max_secs: z.number().int().nonnegative().default(180),
  /** An unclaimed drop is gone after this many minutes. */
  drop_expire_mins: z.number().int().positive().default(10),
  /** Dropped cards one person may pick up per local day. */
  drops_per_person_day: z.number().int().positive().default(1),
};
