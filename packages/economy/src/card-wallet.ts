// The wallet her cards are paid through (`CardWalletKey`, docs/design/v5-play.md §2): a daily card
// is one `card_daily` row of the ledger, keyed by the card's serial so a retry is the same charge,
// and a card that could not be written is given back once as one `card_refund` row (keyed on the
// charge, found by the card's serial). A stranger or someone she blocked cannot pay; a refund still
// reaches someone blocked since, as with every refund, what was taken is theirs.

import { CARD_REASONS, type CardCharge, type CardPayer, type CardWallet } from "@miyoria/types";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { EconomyError } from "./types.js";

export class EconomyCardWallet implements CardWallet {
  constructor(private readonly e: EconomyService) {}

  async #member(payer: CardPayer): Promise<Member | null> {
    try {
      return await this.e.member(payer.account);
    } catch {
      return null;
    }
  }

  async balance(payer: CardPayer): Promise<number | null> {
    const who = await this.#member(payer);
    return who === null ? null : this.e.ledger().balance(this.e.profile, who.wallet);
  }

  async spend(payer: CardPayer, amount: number, reason: string, key: string): Promise<CardCharge> {
    const who = await this.#member(payer);
    if (who === null) return { ok: false, reason: "refused", message: STRANGER };
    try {
      const spent = await this.e.serial(() =>
        this.e.spend(who, amount, reason, key, `${reason}:${key}`),
      );
      return { ok: true, receipt: spent.entry.id, balance: spent.balance };
    } catch (error) {
      if (error instanceof EconomyError && error.status === 402) {
        return {
          ok: false,
          reason: "insufficient",
          balance: await this.e.ledger().balance(this.e.profile, who.wallet),
        };
      }
      if (error instanceof EconomyError) {
        return { ok: false, reason: "refused", message: error.message };
      }
      throw error;
    }
  }

  async refund(payer: CardPayer, key: string, reason: string): Promise<number> {
    const who = await this.e.holder(payer.account);
    return this.e.serial(async () => {
      const ledger = this.e.ledger();
      const charge = await ledger.byKey(this.e.profile, who.wallet, chargeKey(key));
      if (charge === null || charge.delta >= 0) return 0;
      const back = `refund:${charge.id}`;
      if ((await ledger.byKey(this.e.profile, who.wallet, back)) !== null) return 0;
      const post = await ledger.post(this.e.entryFor(who, -charge.delta, reason, charge.id, back));
      if (post.status === "posted") return -charge.delta;
      if (post.status !== "duplicate") {
        this.e.log.warn(
          { person: payer.person, receipt: charge.id, status: post.status },
          "cards: the refund of a card was not posted",
        );
      }
      return 0;
    });
  }
}

/** The ledger key of a card's charge: the one `spend` posts under. */
function chargeKey(key: string): string {
  return `${CARD_REASONS.daily}:${key}`;
}
