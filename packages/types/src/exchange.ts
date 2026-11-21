// How the deep-sea exchange is paid for (docs/design/exchange.md): a port the economy provides
// (`ExchangeWalletKey`) and the exchange (`@miyoria/play/exchange`) moves coins through, so
// neither package depends on the other. Coins are only earned, never bought; nothing here buys
// bond, and she never trades.
//
// One posting is one or more ledger rows of one wallet, written together or not at all, each with
// its own key; the first row's key decides a retry, so a posting that went through is never
// written twice. The exchange keeps what the rows are for (the order, the fill, the vault) in its
// own tables; the rows are what the wallet sees.

import type { PersonId } from "./ids.js";
import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** The ledger reasons of the exchange (statements and the health table read them). */
export const EXCHANGE_REASONS = {
  /** Coins a member puts in: a buy's margin (the whole cost of a plain buy), margin added. */
  in: "exchange_in",
  /** Coins back to a member: a sale, what a liquidation left, a buy that did not fill. */
  out: "exchange_out",
  /** Burned: the buy fee, the sale fee and tax, the carry fee of leverage. */
  fee: "exchange_fee",
  /** The fee of a buy that did not fill, given back. */
  feeBack: "exchange_fee_back",
  /** Real instruments (the house is the counterparty): coins burned into a position by a buy. */
  burn: "exchange_burn",
  /** The burn of a real buy that did not fill, given back. */
  burnBack: "exchange_burn_back",
  /** Coins minted back by a real sale, a payout, what a liquidation left. */
  mint: "exchange_mint",
  /** A leveraged loss past its margin, taken from the wallet (cross margin). */
  loss: "exchange_loss",
} as const;

export type ExchangeReason = (typeof EXCHANGE_REASONS)[keyof typeof EXCHANGE_REASONS];

/** Someone whose wallet the exchange may use. */
export interface ExchangePerson {
  person: PersonId;
  /** The display name of the account (untrusted). */
  name: string;
}

/** One row of a posting: its reason, its coins, its own key. */
export interface ExchangeEntry {
  reason: ExchangeReason;
  delta: number;
  key: string;
}

export type ExchangePost =
  | { ok: true; balance: number; duplicate: boolean }
  | { ok: false; reason: "short"; balance: number }
  | { ok: false; reason: "refused"; message: string };

export interface ExchangeWallet {
  /** What the coins are called (`魚幣`). */
  readonly currency: string;
  /** The person behind `account` when they may buy: she knows them and has not blocked them. */
  member(account: AccountRef): Promise<ExchangePerson | null>;
  /** The person behind `account` when she knows them, blocked or not: they may still sell. */
  holder(account: AccountRef): Promise<ExchangePerson | null>;
  balance(person: PersonId): Promise<number>;
  /** Coins received by transfer since `since`. */
  transferredIn(person: PersonId, since: Timestamp): Promise<number>;
  /**
   * Writes `entries` to `person`'s wallet together, once. With `covered`, refused (`short`) when
   * their sum would take the balance below zero. A posting whose first key is there already is a
   * `duplicate` and writes nothing.
   */
  post(
    person: PersonId,
    entries: readonly ExchangeEntry[],
    ref: string,
    covered: boolean,
  ): Promise<ExchangePost>;
  /** Whether a row under `key` is in `person`'s wallet. */
  posted(person: PersonId, key: string): Promise<boolean>;
}

export const ExchangeWalletKey = serviceKey<ExchangeWallet>("ExchangeWallet");

// ---- her words (docs/design/exchange.md §7) -----------------------------------------------------

/** What she may know of a trading day: public numbers and totals, never anyone's holdings. */
export interface ExchangeDayFacts {
  /** `YYYY-MM-DD`. */
  date: string;
  /** The index now and at the previous close. */
  fish: number;
  fish_ref: number;
  /** Vault over holdings; `null` while too small to say. */
  level: number | null;
  /** Coins traded and burned today. */
  volume: number;
  burned: number;
  /** The breaker stopped the day. */
  halted: boolean;
  companies: { code: string; name: string; change: number; limit: "up" | "down" | null }[];
  /** Today's news as the program drew it. */
  news: { company: string | null; kind: string; direction: string; size: string }[];
}

/** A piece of news the program drew, for her to word: who, which way, how big; never a number. */
export interface ExchangeNewsDraft {
  /** `null`: the whole market. */
  company: { code: string; name: string; blurb: string } | null;
  kind: "event" | "earnings";
  direction: "up" | "down";
  size: "small" | "medium" | "large";
}

export interface ExchangeRatingItem {
  code: string;
  rating: "買進" | "持有" | "賣出";
  reason: string;
}

/**
 * Her words for the exchange (the api provides it with her persona). Every call answers `null`
 * when she cannot now (no model, no answer in time, words that do not pass); the exchange then
 * uses its plain words. Her words are never an input to a price.
 */
export interface ExchangeWords {
  /** One line for the opening or the closing of a day. */
  line(
    kind: "open" | "close",
    facts: ExchangeDayFacts,
    signal?: AbortSignal,
  ): Promise<string | null>;
  /** A headline (at most 30 characters) and a body (two or three sentences) for one draft. */
  news(
    draft: ExchangeNewsDraft,
    signal?: AbortSignal,
  ): Promise<{ headline: string; body: string } | null>;
  /** The weekly rating of every company, from the week's public news and prices. */
  rating(
    facts: ExchangeDayFacts,
    week: ExchangeNewsDraft[],
    signal?: AbortSignal,
  ): Promise<ExchangeRatingItem[] | null>;
}

export const ExchangeWordsKey = serviceKey<ExchangeWords>("ExchangeWords");
