// The numbers of the heart's rules (docs/design/v5-heart.md §2.3, the owner's decisions H3, H4,
// H9): the size of one `feel` proposal per field, the daily caps, the repeat damping and the
// rates of the daily decay pass. One schema, every field with a default, like a module's config
// section; the module that will own `heart_person` reads it as its section.
//
// How the steps and caps fit together: the n-th proposal for one field, one person and one
// direction on a local day counts `repeat_damping^(n-1)`. With 0.5 the whole day's proposals add
// up to at most twice the step, so a cap that the 8th to 15th proposal should reach needs a step
// of about half the cap: after 8 proposals the day has 99.6% of the cap, after 15 99.997%. Each
// step below is half its cap for that reason, and the bond's step is half of the bond's cap at
// the current bond, so every tier's cap (H3) is reached the same way.

import { z } from "zod";

const positive = () => z.number().positive();
const nonnegative = () => z.number().nonnegative();
const unit = () => z.number().min(0).max(1);
const days = () => z.number().int().nonnegative();

/**
 * Per field, the size of one proposal in the field's good direction (up, for grudge down). A
 * proposal in the other direction is `negative_factor` times this.
 */
const StepsSchema = z.object({
  /** 0..100, slow. */
  trust: positive().default(1),
  /** -1..1, fast. */
  warmth: positive().default(0.1),
  /** -1..1 */
  respect: positive().default(0.05),
  /** 0..1 */
  ease: positive().default(0.03),
  /** 0..1, good direction down: an apology, a gift, a game together. */
  grudge: positive().default(0.1),
  /** 0..1 */
  rapport: positive().default(0.03),
});

/** Per field, the most a day may move it in the good direction; the other direction gets `negative_factor` times this. */
const CapsSchema = z.object({
  trust: positive().default(2),
  warmth: positive().default(0.2),
  respect: positive().default(0.1),
  ease: positive().default(0.06),
  grudge: positive().default(0.2),
  rapport: positive().default(0.06),
});

/** `[lowest bond, most bond gained per day from there]`, lowest first (H3). */
const BondCapSchema = z.tuple([z.number(), positive()]);

/** The daily pass (H9). Days are her local days. */
const DecaySchema = z.object({
  /** Days without any interaction before the bond starts to fall. */
  bond_grace_days: days().default(7),
  /** Bond lost per further day, never below the floor of the highest tier reached, nor below 0. */
  bond_per_day: nonnegative().default(1),
  /** Warmth moves halfway to its baseline (a function of bond) in this many days. */
  warmth_half_life_days: positive().default(3),
  /** Not seen for this many days: longing rises. */
  longing_away_days: days().default(2),
  /** Share of the gap to how much she cares that longing closes per day away. */
  longing_rise: unit().default(0.15),
  /** Share of longing that goes per day once they were seen (today or yesterday). */
  longing_fall: unit().default(0.5),
  /** Grudge lost per day by time alone... */
  grudge_fade_per_day: nonnegative().default(0.01),
  /** ...down to this, and no further: only a proposal (an apology, a gift, a game) clears the rest. */
  grudge_time_floor: unit().default(0.1),
  /** Days without any interaction before familiarity blurs. */
  familiarity_grace_days: days().default(14),
  /** Familiarity lost per further day... */
  familiarity_blur_per_day: nonnegative().default(0.2),
  /** ...never below this (familiarity never blurs to nothing). */
  familiarity_floor: nonnegative().default(5),
  /** A pass that has not run for a while catches up at most this many days. */
  max_catch_up_days: z.number().int().positive().default(60),
  /** A change smaller than this is not made (no event for drift nobody would notice). */
  min_change: nonnegative().default(0.005),
});

/**
 * The heart's rules. Section of the module that owns `heart_person` (not wired yet).
 *
 * ```toml
 * repeat_damping = 0.5
 * negative_factor = 3
 * bond_gain_caps = [[0, 12], [100, 8], [300, 6], [600, 4]]
 * ```
 */
export const HeartPersonConfigSchema = z.object({
  /** Her local time zone as a UTC offset: what a "day" is for the caps and the decay. */
  utc_offset_minutes: z
    .number()
    .int()
    .min(-720)
    .max(840)
    .default(8 * 60),
  /** The n-th proposal of a day for one field, person and direction counts `repeat_damping^(n-1)`. */
  repeat_damping: unit().default(0.5),
  /** A step and a cap in a field's bad direction are this many times the good one. */
  negative_factor: positive().default(3),
  /** Most bond gained per day by the bond it starts from (H3). Lost: `negative_factor` times. */
  bond_gain_caps: z
    .array(BondCapSchema)
    .min(1)
    .default([
      [0, 12],
      [100, 8],
      [300, 6],
      [600, 4],
    ]),
  /** One bond proposal is this share of the day's bond cap at the current bond. */
  bond_step_share: unit().default(0.5),
  steps: StepsSchema.prefault({}),
  caps: CapsSchema.prefault({}),
  /** Without the anchor of a tier, bond is held this far below the tier (H4). */
  anchor_hold: positive().default(0.5),
  /** Familiarity per line a person says (times its depth), slowing toward 100, as `social` has it. */
  familiarity_per_line: nonnegative().default(0.15),
  /** Trust of someone she just met. */
  default_trust: nonnegative().default(10),
  /** People tagged `owner` always have this trust... */
  owner_trust: nonnegative().default(100),
  /** ...and never less bond than this. */
  owner_bond_floor: z.number().default(30),
  decay: DecaySchema.prefault({}),
});

export type HeartPersonConfig = z.output<typeof HeartPersonConfigSchema>;

/** The defaults, optionally overridden. */
export function heartPersonConfig(overrides: Partial<HeartPersonConfig> = {}): HeartPersonConfig {
  return { ...HeartPersonConfigSchema.parse({}), ...overrides };
}
