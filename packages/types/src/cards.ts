// How her cards are paid for (docs/design/v5-play.md §2): a port the economy provides
// (`CardWalletKey`) and the cards plugin (`@miyoria/play/cards`) charges through, so neither
// package depends on the other. A charge is keyed by the card's serial, so a retry is the same
// charge, and a card that could not be written gives its coins back. Coins are only earned, never
// bought, and cards are never sold or given away: there is no way back from a card to coins.

import type { PersonId } from "./ids.js";
import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Who pays: the person the card is for, through the account that asked. */
export interface CardPayer {
  person: PersonId;
  account: AccountRef;
}

/**
 * A charge: `receipt` is what the wallet refunds by (its ledger row). A refusal is too few coins
 * (with the balance when the wallet knows it) or someone whose wallet cannot be used (a stranger,
 * someone she blocked), with a sentence for them.
 */
export type CardCharge =
  | { ok: true; receipt: string; balance: number | null }
  | { ok: false; reason: "insufficient"; balance: number | null }
  | { ok: false; reason: "refused"; message: string };

export interface CardWallet {
  /** Their balance now; `null` when their wallet cannot be used. */
  balance(payer: CardPayer): Promise<number | null>;
  /** Takes `amount` fish coins for `reason`; the same `key` is the same charge. */
  spend(payer: CardPayer, amount: number, reason: string, key: string): Promise<CardCharge>;
  /** Gives back a charge whose card was not written (once; a second call does nothing). */
  refund(payer: CardPayer, receipt: string, reason: string): Promise<void>;
}

export const CardWalletKey = serviceKey<CardWallet>("CardWallet");

/** The ledger reasons a card's charge and its refund are written with. */
export const CARD_REASONS = {
  daily: "card_daily",
  refund: "card_refund",
} as const;
