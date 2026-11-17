// The member's card queries (`cards` group of the route table) and the one catalogue the dex and the
// wishlist pick from.
//
// The Core has no catalogue route: the odds table lists every part a bought card can draw, and the
// dex lists the parts they have (a drop-only part shows there once caught). A blank part ("空手",
// "無配件") is in the odds but is never collected; the odds do not mark it, so a part without a
// series is taken as blank unless they have it.

import { useQuery } from "@tanstack/react-query";
import type { CardDex, CardOdds } from "@miyoria/contracts/api";
import { isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import type { Rarity, Slot } from "./labels";
import { RARITIES, SLOTS } from "./labels";

/** Everything under `["member", "cards"]` is refreshed after a new card. */
export const CARD_KEYS = {
  mine: ["member", "cards", "mine"] as const,
  one: (serial: string) => ["member", "cards", "one", serial] as const,
  dex: ["member", "cards", "dex"] as const,
  pity: ["member", "cards", "pity"] as const,
  wishlist: ["member", "cards", "wishlist"] as const,
  odds: ["public", "cards", "odds"] as const,
};

/** An older Core has no such route: asking again will not change that. */
const retry = (n: number, e: Error) => !isNotProvided(e) && n < 2;

export function useMyCards() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.mine, queryFn: ({ signal }) => api.rpc.cards.mine(undefined, { signal }), retry });
}

export function useMyCard(serial: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: CARD_KEYS.one(serial ?? ""),
    queryFn: ({ signal }) => api.rpc.cards.one({ params: { serial: serial ?? "" } }, { signal }),
    enabled: serial !== null,
    retry,
  });
}

export function useDex() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.dex, queryFn: ({ signal }) => api.rpc.cards.dex(undefined, { signal }), retry });
}

export function usePity() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.pity, queryFn: ({ signal }) => api.rpc.cards.pity(undefined, { signal }), retry });
}

export function useWishlist() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.wishlist, queryFn: ({ signal }) => api.rpc.cards.wishlist(undefined, { signal }), retry });
}

export function useOdds() {
  const api = useApi();
  return useQuery({
    queryKey: CARD_KEYS.odds,
    queryFn: ({ signal }) => api.rpc.cards.odds(undefined, { signal }),
    retry,
    staleTime: 10 * 60_000,
  });
}

/** One part of the catalogue, and what this person has of it. */
export interface CatalogPart {
  id: string;
  slot: Slot;
  name: string;
  rarity: Rarity;
  /** Series id, or null. */
  series: string | null;
  /** How many of their cards had it; 0: not yet. */
  count: number;
  first_at: string | null;
}

const slotOf = (id: string): Slot | null => {
  const s = id.slice(0, id.indexOf("."));
  return (SLOTS as readonly string[]).includes(s) ? (s as Slot) : null;
};

/**
 * Every collectable part the page knows of, owned or not, in slot order, rarest last within a
 * slot. `odds` may be missing (the public side off): then only the parts they have.
 */
export function catalogOf(dex: CardDex, odds: CardOdds | undefined): CatalogPart[] {
  const owned = new Map(dex.parts.map((p) => [p.id, p]));
  const out = new Map<string, CatalogPart>();
  for (const slot of odds?.slots ?? []) {
    for (const p of slot.parts) {
      const mine = owned.get(p.id);
      if (p.series === null && !mine) continue;
      out.set(p.id, {
        id: p.id,
        slot: slot.slot,
        name: p.name,
        rarity: p.rarity,
        series: p.series,
        count: mine?.count ?? 0,
        first_at: mine?.first_at ?? null,
      });
    }
  }
  for (const p of dex.parts) {
    if (out.has(p.id)) continue;
    out.set(p.id, { id: p.id, slot: p.slot, name: p.name, rarity: p.rarity, series: p.series, count: p.count, first_at: p.first_at });
  }
  const slotRank = (p: CatalogPart) => SLOTS.indexOf(slotOf(p.id) ?? p.slot);
  return [...out.values()].sort(
    (a, b) => slotRank(a) - slotRank(b) || RARITIES.indexOf(a.rarity) - RARITIES.indexOf(b.rarity) || a.id.localeCompare(b.id),
  );
}
