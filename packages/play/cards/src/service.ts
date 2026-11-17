// The cards as the rest of Core uses them (`CardsKey`): issuing a daily card, the odds table, a
// person's pity, dex and wishlist (docs/design/v5-play.md §2, §6.3).
//
// A daily card costs `price` fish coins, the first of the day too, and a person gets at most
// `daily_cap` a day (her local day). One person's cards are issued one at a time in this process:
// the cap is checked, the coins are taken through the wallet port (`wallet.ts`), then the store
// draws and writes the card in one transaction, checking the cap again. When the card cannot be
// written the coins go back.

import { getLogger } from "@miyoria/runtime/kernel";
import type { Clock, PersonId } from "@miyoria/types";
import type { Part, Rarity, Slot } from "./catalogue.js";
import { type CardsConfig, drawRules } from "./config.js";
import { type SeriesProgress, seriesProgress, type WishlistProblem } from "./dex.js";
import { type PityView, pityView, type Random } from "./draw.js";
import { type OddsTable, oddsTable } from "./odds.js";
import { newSerial } from "./serial.js";
import {
  CardCapError,
  type CardFace,
  type CardRecord,
  type CardRelationship,
  type CardStore,
  type CardTitle,
  type DexEntry,
  type IssuedCard,
} from "./store.js";
import { CARD_REASONS, type CardWallet } from "./wallet.js";

const log = getLogger("cards");

const DAY_MS = 86_400_000;

/** What a member reads when a card is refused, and when a wishlist is. */
export const CARD_TEXTS = {
  daily_cap: "今天的卡已經發完了,明天再來",
  insufficient: "魚幣不夠",
  no_wallet: "錢包現在不能用",
  too_many: "願望單最多三個",
  duplicate: "願望單裡有重複的部件",
  unknown_part: "沒有這個部件",
} as const;

export type DailyResult =
  | { ok: true; issued: IssuedCard }
  | { ok: false; reason: "daily_cap"; cap: number }
  | { ok: false; reason: "insufficient"; price: number; balance: number | null }
  | { ok: false; reason: "no_wallet" };

/** One part a person has, with what it is. */
export interface DexPart extends DexEntry {
  name: string;
  slot: Slot;
  rarity: Rarity;
  series: string | null;
}

/** A person's dex page: theirs alone unless they say otherwise; nobody is ranked. */
export interface DexView {
  parts: DexPart[];
  series: SeriesProgress[];
  titles: CardTitle[];
}

export interface CardServiceOptions {
  config: CardsConfig;
  clock: Clock;
  /** The wallet, looked up at each use (the economy may restart); `null`: none now. */
  wallet: () => CardWallet | null;
  /** The relationship a card for `person` shows, now. */
  relationship: (person: PersonId) => CardRelationship;
  /** Default `Math.random`. */
  random?: Random;
  /** Default `newSerial` (`MYR-XXXX-XXXX-XXXX` from the system's CSPRNG). */
  newSerial?: () => string;
}

/** The start (epoch ms) of the local day of `now` at `offsetMinutes` from UTC. */
export function dayStart(now: number, offsetMinutes: number): number {
  const offset = offsetMinutes * 60_000;
  return Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
}

export class CardService {
  readonly #store: CardStore;
  readonly #o: CardServiceOptions;
  readonly #random: Random;
  readonly #serial: () => string;
  readonly #turns = new Map<PersonId, Promise<unknown>>();

  constructor(store: CardStore, options: CardServiceOptions) {
    this.#store = store;
    this.#o = options;
    this.#random = options.random ?? Math.random;
    this.#serial = options.newSerial ?? newSerial;
  }

  get config(): CardsConfig {
    return this.#o.config;
  }

  /**
   * Issues `person` a daily card with `face` on it: refused when they have had `daily_cap` today
   * or cannot pay `price`. Their relationship decides her expression on it.
   */
  issueDaily(person: PersonId, face: CardFace): Promise<DailyResult> {
    return this.#inTurn(person, () => this.#issueDaily(person, face));
  }

  async #issueDaily(person: PersonId, face: CardFace): Promise<DailyResult> {
    const { config, clock } = this.#o;
    const now = clock.now();
    const since = dayStart(now, config.utc_offset_minutes);
    if (this.#store.countSince(person, "daily", since) >= config.daily_cap) {
      return { ok: false, reason: "daily_cap", cap: config.daily_cap };
    }
    const serial = this.#serial();
    let paid: { wallet: CardWallet; receipt: string } | null = null;
    if (config.price > 0) {
      const wallet = this.#o.wallet();
      if (wallet === null) return { ok: false, reason: "no_wallet" };
      const charge = await wallet.spend(person, config.price, CARD_REASONS.daily, serial);
      if (!charge.ok) {
        return { ok: false, reason: "insufficient", price: config.price, balance: charge.balance };
      }
      paid = { wallet, receipt: charge.receipt };
    }
    try {
      const issued = this.#store.issue({
        person,
        kind: "daily",
        serial,
        price: config.price,
        face,
        relationship: this.#o.relationship(person),
        rules: drawRules(config),
        random: this.#random,
        now,
        cap: { max: config.daily_cap, since },
      });
      return { ok: true, issued };
    } catch (error) {
      if (paid !== null) {
        try {
          await paid.wallet.refund(person, paid.receipt, CARD_REASONS.refund);
        } catch (refundError) {
          log.error(
            { person, serial, receipt: paid.receipt, err: String(refundError) },
            "cards: a card was not written and its coins could not be given back",
          );
        }
      }
      if (error instanceof CardCapError) {
        return { ok: false, reason: "daily_cap", cap: config.daily_cap };
      }
      throw error;
    }
  }

  /** Daily cards `person` may still get today. */
  dailyLeft(person: PersonId): number {
    const { config, clock } = this.#o;
    const since = dayStart(clock.now(), config.utc_offset_minutes);
    return Math.max(config.daily_cap - this.#store.countSince(person, "daily", since), 0);
  }

  /** The public odds of a daily card. */
  odds(): OddsTable {
    return oddsTable(this.#store.catalogue(), drawRules(this.#o.config));
  }

  catalogue(): Part[] {
    return this.#store.catalogue();
  }

  pity(person: PersonId): PityView {
    return pityView(this.#store.pitySince(person), this.#o.config.pity);
  }

  card(serial: string): CardRecord | null {
    return this.#store.card(serial);
  }

  cards(person: PersonId, options: { limit?: number; before?: string } = {}): CardRecord[] {
    return this.#store.cards(person, options);
  }

  dex(person: PersonId): DexView {
    const catalogue = this.#store.catalogue();
    const byId = new Map(catalogue.map((p) => [p.id, p]));
    const entries = this.#store.dex(person);
    const parts: DexPart[] = entries.flatMap((e) => {
      const p = byId.get(e.part);
      return p === undefined
        ? []
        : [{ ...e, name: p.name, slot: p.slot, rarity: p.rarity, series: p.series }];
    });
    return {
      parts,
      series: seriesProgress(catalogue, new Set(entries.map((e) => e.part))),
      titles: this.#store.titles(person),
    };
  }

  wishlist(person: PersonId): string[] {
    return this.#store.wishlist(person);
  }

  /** Replaces the wishlist (at most three parts); why not, or `null` once written. */
  setWishlist(person: PersonId, parts: readonly string[]): WishlistProblem | null {
    return this.#store.setWishlist(person, parts, this.#o.clock.now());
  }

  clearWishlist(person: PersonId): void {
    this.#store.clearWishlist(person);
  }

  /** Runs `fn` after every earlier call of `person`'s in this process. */
  async #inTurn<T>(person: PersonId, fn: () => Promise<T>): Promise<T> {
    const before = this.#turns.get(person) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#turns.set(person, tail);
    try {
      return await run;
    } finally {
      if (this.#turns.get(person) === tail) this.#turns.delete(person);
    }
  }
}
