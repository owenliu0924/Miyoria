// Her cards (`@miyoria/play/cards`) for the API tests: the cards service over a store's tables with
// a seeded draw, a wallet that holds coins by person, and a wallet that pays through a real
// economy's ledger the way the economy's own (`EconomyCardWallet`, not exported) does: a stranger
// or someone she blocked cannot pay, a charge is one `card_daily` row keyed by the card's serial,
// and a refund is one `card_refund` row.

import { EconomyError, type EconomyService, STRANGER } from "@miyoria/economy";
import type { HeartStore } from "@miyoria/heart/person";
import {
  CARD_REASONS,
  type CardCharge,
  type CardPayer,
  CardService,
  type CardStore,
  type CardsConfig,
  type CardWallet,
  cardRelationship,
  cardsConfig,
  seededRandom,
} from "@miyoria/play/cards";
import type { PersonId } from "@miyoria/types";

/** The cards service as the module builds it, with the wallet looked up at each use. */
export function cardService(
  store: CardStore,
  heart: HeartStore,
  wallet: () => CardWallet | null,
  config: Partial<CardsConfig> = {},
): CardService {
  return new CardService(store, {
    config: cardsConfig(config),
    clock: { now: () => Date.now() },
    wallet,
    relationship: (person) => cardRelationship(heart.get(person)),
    random: seededRandom(7),
  });
}

/** Coins by person, nothing else: whoever has a person pays like anyone. */
export class CoinPurse implements CardWallet {
  readonly coins = new Map<PersonId, number>();
  readonly charges: { person: PersonId; amount: number; reason: string; key: string }[] = [];
  readonly refunds: string[] = [];

  fund(person: PersonId, amount: number): void {
    this.coins.set(person, (this.coins.get(person) ?? 0) + amount);
  }

  async balance({ person }: CardPayer): Promise<number | null> {
    return this.coins.get(person) ?? 0;
  }

  async spend(
    { person }: CardPayer,
    amount: number,
    reason: string,
    key: string,
  ): Promise<CardCharge> {
    const balance = this.coins.get(person) ?? 0;
    if (balance < amount) return { ok: false, reason: "insufficient", balance };
    this.coins.set(person, balance - amount);
    this.charges.push({ person, amount, reason, key });
    return { ok: true, receipt: `r-${key}`, balance: balance - amount };
  }

  async refund({ person }: CardPayer, receipt: string): Promise<void> {
    if (this.refunds.includes(receipt)) return;
    const charge = this.charges.find((c) => `r-${c.key}` === receipt);
    if (!charge) return;
    this.refunds.push(receipt);
    this.coins.set(person, (this.coins.get(person) ?? 0) + charge.amount);
  }
}

/** A card paid through `economy`'s ledger. */
export class LedgerCardWallet implements CardWallet {
  constructor(private readonly e: EconomyService) {}

  async balance(payer: CardPayer): Promise<number | null> {
    const who = await this.e.member(payer.account);
    return who === null ? null : this.e.ledger().balance(this.e.profile, who.wallet);
  }

  async spend(payer: CardPayer, amount: number, reason: string, key: string): Promise<CardCharge> {
    const who = await this.e.member(payer.account);
    if (who === null) return { ok: false, reason: "refused", message: STRANGER };
    try {
      const spent = await this.e.serial(() =>
        this.e.spend(who, amount, reason, key, `${reason}:${key}`),
      );
      return { ok: true, receipt: spent.entry.id, balance: spent.balance };
    } catch (error) {
      if (error instanceof EconomyError && error.status === 402) {
        const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
        return { ok: false, reason: "insufficient", balance };
      }
      if (error instanceof EconomyError) {
        return { ok: false, reason: "refused", message: error.message };
      }
      throw error;
    }
  }

  async refund(payer: CardPayer, receipt: string, reason: string): Promise<void> {
    const who = await this.e.holder(payer.account);
    const ledger = this.e.ledger();
    const charges = await ledger.entries(this.e.profile, who.wallet, {
      reasons: [CARD_REASONS.daily],
      limit: 500,
    });
    const charge = charges.find((r) => r.id === receipt);
    if (charge === undefined || charge.delta >= 0) return;
    await ledger.post(this.e.entryFor(who, -charge.delta, reason, charge.id, `refund:${receipt}`));
  }
}
