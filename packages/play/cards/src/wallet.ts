// How a card is paid for: a port the economy provides (`CardWalletKey`), so this package does not
// depend on it. A charge is keyed by the card's serial, so a retry is the same charge, and a card
// that could not be written gives its coins back. Coins are only earned, never bought, and cards
// are never sold or given away (cards.md §2.5): there is no way back from a card to coins.

import { type PersonId, serviceKey } from "@miyoria/types";

/**
 * A charge: `receipt` is what the wallet refunds by (its ledger row); a refusal says the balance
 * when the wallet knows it.
 */
export type CardCharge =
  | { ok: true; receipt: string }
  | { ok: false; reason: "insufficient"; balance: number | null };

export interface CardWallet {
  /** Takes `amount` fish coins from `person` for `reason`; the same `key` is the same charge. */
  spend(person: PersonId, amount: number, reason: string, key: string): Promise<CardCharge>;
  /** Gives back a charge whose card was not written. */
  refund(person: PersonId, receipt: string, reason: string): Promise<void>;
}

export const CardWalletKey = serviceKey<CardWallet>("CardWallet");

/** The ledger reasons a card's charge and its refund are written with. */
export const CARD_REASONS = {
  daily: "card_daily",
  refund: "card_refund",
} as const;
