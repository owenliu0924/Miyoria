// Where a bond is, exactly: its tier, how far to the next and its place on the ring. The admin's
// view (the panel's list and person page, `/admin person show`); `publicBond` (`public.ts`) is the
// same in steps of a twentieth and without the exact fall below the ring, for members.

import {
  BOND_LADDER,
  clampAffinity,
  type RelationshipLabel,
  RING_LAPS,
  relationshipLabel,
  ringOf,
  tierProgress,
} from "@miyoria/types";

/** The ring with all its parts (`below` is how far under 0 the bond is, 0..1). */
export interface BondRingPlace {
  /** The lap being filled, 0..9. */
  lap: number;
  /** How full that lap is, 0..1. */
  fraction: number;
  /** All ten laps are full. */
  full: boolean;
  /** For a bond below 0, how far towards -100 (0..1); 0 otherwise. */
  below: number;
}

/** A bond's tier, the next one and the ring. */
export interface BondPlace {
  /** The tier's name (認識 ... 永恆羈絆; 討厭, 很討厭 below the ladder). */
  tier: RelationshipLabel;
  /** The tier after it; `null` at the top. */
  next_tier: RelationshipLabel | null;
  /** 0..1 of the way to the next tier (1 at the top, 0 below the ladder). */
  tier_progress: number;
  ring: BondRingPlace;
}

/** The bond from which the ladder starts; below it she dislikes them. */
const DISLIKE_AT = -15;

/** The place of `bond` (any number is clamped to the scale). */
export function bondPlace(bond: number): BondPlace {
  const b = clampAffinity(bond);
  const place = tierProgress(b);
  const ring = ringOf(b);
  const first = (BOND_LADDER[0]?.label ?? "認識") as RelationshipLabel;
  const disliked = b <= DISLIKE_AT;
  return {
    tier: disliked ? relationshipLabel({ affinity: b }) : place.tier.label,
    next_tier: disliked ? first : (place.next?.label ?? null),
    tier_progress: disliked ? 0 : place.progress,
    ring: {
      lap: ring.lap,
      fraction: ring.fraction,
      full: ring.lap === RING_LAPS - 1 && ring.fraction >= 1,
      below: ring.below,
    },
  };
}
