// The cards' events on the event log, so she can hear about them: a card drawn (`cards.drawn`, with
// whether the pity decided it and which wished parts it has) and a series completed
// (`cards.titled`). Each is appended in the transaction that writes the card, as the heart appends
// `heart.changed` with its row (`store.ts`).
//
// They are scoped `dm`: about one person, seen in her DM with them and by her inner tools, never in
// a room (a card is for the person it was given to). The types are not in the core registry yet,
// so they are kept as long as the registry keeps an unknown type (`short`); the cards themselves
// are kept in `cards_card`.

import type { EventWrite } from "@miyoria/store";
import { newId, type PersonId, type Timestamp } from "@miyoria/types";
import type { Rarity } from "./catalogue.js";

/** What the cards write to the log as (the module's id). */
export const CARDS_SOURCE = "cards";

export const CARDS_DRAWN = "cards.drawn";
export const CARDS_TITLED = "cards.titled";

/** A card drawn. */
export interface CardDrawnData {
  serial: string;
  person: PersonId;
  kind: string;
  rarity: Rarity;
  /** The part ids, in slot order. */
  parts: string[];
  expression: string;
  /** Coins it cost. */
  price: number;
  /** The pity decided its rarity. */
  pity_hit: boolean;
  /** The pity counter after it. */
  pity_since: number;
  /** Wished parts it has (wishlist order); empty: none. */
  wished: string[];
  /** Parts the person had never drawn before. */
  new_parts: string[];
}

/** A series completed. */
export interface CardTitledData {
  person: PersonId;
  series: string;
  title: string;
  /** The card that completed it. */
  serial: string;
}

function write(
  type: string,
  person: PersonId,
  at: Timestamp,
  data: CardDrawnData | CardTitledData,
): EventWrite {
  return {
    draft: {
      id: newId(),
      at,
      type,
      v: 1,
      person_id: person,
      scope: "dm",
      data: { ...data },
    },
    source: CARDS_SOURCE,
  };
}

export function drawnWrite(data: CardDrawnData, at: Timestamp): EventWrite {
  return write(CARDS_DRAWN, data.person, at, data);
}

export function titledWrite(data: CardTitledData, at: Timestamp): EventWrite {
  return write(CARDS_TITLED, data.person, at, data);
}
