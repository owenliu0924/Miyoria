// What a member may see of how she feels about them (docs/design/v5-heart.md §2.7, H2): the same
// ring as the panel's without the number, the tier's name and how far to the next, and words for
// trust and familiarity. Never a raw value: the only numbers are the ring's lap and how full it
// is, and the progress within the tier, both in steps of a twentieth, so a page shows roughly
// where someone is (the owner accepted that) but nobody can read their bond off it.
//
// Pure: whoever shows it still decides whether the person may see anything at all (blocked, a
// role without `/me memory`), and checks `public_feeling` and `call_name` (other names,
// moderation) as the member page does.

import {
  BOND_LADDER,
  bondBand,
  clampAffinity,
  familiarityBand,
  RING_LAPS,
  relationshipLabel,
  ringOf,
  tierProgress,
  trustBand,
} from "@miyoria/types";
import type { HeartPerson } from "./model.js";

/** The ring as a member sees it (H1, H2). */
export interface PublicRing {
  /** The lap being filled, 0..9 (each lap is one of the ten outer segments once full). */
  lap: number;
  /** How full that lap is, 0..1 in steps of 1/20. */
  fraction: number;
  /** All ten laps are full. */
  full: boolean;
  /** The bond is below the ring (they are on her bad side): the ring is drawn empty. */
  below: boolean;
}

/** How she feels about someone, for their own eyes. */
export interface PublicBond {
  /** The name of their tier (認識 ... 永恆羈絆; 討厭, 很討厭 below the ladder). */
  tier: string;
  /** The tier after it; `null` at the top. */
  next_tier: string | null;
  /** How far into the tier toward the next, 0..1 in steps of 1/20 (1 at the top). */
  tier_progress: number;
  ring: PublicRing;
  /** The member page's words for how close they are (`bondBand`). */
  closeness: string;
  trust: string;
  familiarity: string;
  /** The line she wrote for them; `null`: none yet. */
  public_feeling: string | null;
  /** What she calls them; `null`: their name. */
  call_name: string | null;
}

/** Steps a fraction shown to members is rounded down to. */
const STEPS = 20;

/** `x` (0..1) rounded down to a step; exactly 1 stays 1. */
function coarse(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.floor(x * STEPS) / STEPS;
}

/** The member-facing view of `person`: words, the ring and the tier, no raw value. */
export function publicBond(
  person: Pick<HeartPerson, "bond" | "trust" | "familiarity" | "public_feeling" | "call_name">,
): PublicBond {
  const bond = clampAffinity(person.bond);
  const place = tierProgress(bond);
  const ring = ringOf(bond);
  const first = BOND_LADDER[0]?.label ?? "認識";
  // Below the ladder: the names for someone she does not like (familiarity does not matter there).
  const disliked = bond <= -15;
  const tier = disliked
    ? relationshipLabel({ affinity: bond, familiarity: 100 })
    : place.tier.label;
  return {
    tier,
    next_tier: disliked ? first : (place.next?.label ?? null),
    tier_progress: disliked ? 0 : coarse(place.progress),
    ring: {
      lap: ring.lap,
      fraction: coarse(ring.fraction),
      full: ring.lap === RING_LAPS - 1 && ring.fraction >= 1,
      below: ring.below > 0,
    },
    closeness: bondBand(bond),
    trust: trustBand(person.trust),
    familiarity: familiarityBand(person.familiarity),
    public_feeling: person.public_feeling,
    call_name: person.call_name,
  };
}
