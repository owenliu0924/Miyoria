// The wallet her cards are paid through: a `card_daily` row keyed by the card, the same key is the
// same charge, too few coins and strangers are refused, a refund is one `card_refund` row (once),
// the labels, the board and the health table see them.

import { CARD_REASONS, type CardPayer } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { BOARD_REASONS } from "../src/board.js";
import { EconomyCardWallet } from "../src/card-wallet.js";
import { RECOVERED_REASONS } from "../src/health.js";
import { ALICE, ALICE_TWO, BOB, balance, CAROL, DAVE, fund, rig } from "./rig.js";

const payer = (account: CardPayer["account"]): CardPayer => ({ person: "unused", account });

describe("the card wallet", () => {
  it("charges a card once per key, and says the balance", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const wallet = new EconomyCardWallet(r.economy);
    expect(await wallet.balance(payer(ALICE))).toBe(100);
    const first = await wallet.spend(payer(ALICE), 30, CARD_REASONS.daily, "MYR-A");
    expect(first).toMatchObject({ ok: true, balance: 70 });
    // A retry with the same key, from another account of the same person, is the same charge.
    const again = await wallet.spend(payer(ALICE_TWO), 30, CARD_REASONS.daily, "MYR-A");
    expect(again).toMatchObject({ ok: true, balance: 70 });
    if (first.ok && again.ok) expect(again.receipt).toBe(first.receipt);
    expect(await balance(r, ALICE)).toBe(70);
    const statement = await r.economy.statement(ALICE);
    expect(statement.ledger[0]).toMatchObject({ delta: -30, label: "每日卡" });
  });

  it("refuses too few coins, strangers and people she blocked", async () => {
    const r = await rig();
    await fund(r, ALICE, 29);
    const wallet = new EconomyCardWallet(r.economy);
    expect(await wallet.spend(payer(ALICE), 30, CARD_REASONS.daily, "k")).toEqual({
      ok: false,
      reason: "insufficient",
      balance: 29,
    });
    expect(await wallet.spend(payer(DAVE), 30, CARD_REASONS.daily, "k")).toMatchObject({
      ok: false,
      reason: "refused",
    });
    expect(await wallet.spend(payer(CAROL), 30, CARD_REASONS.daily, "k")).toMatchObject({
      ok: false,
      reason: "refused",
    });
    expect(await wallet.balance(payer(DAVE))).toBeNull();
    expect(await balance(r, ALICE)).toBe(29);
  });

  it("gives a charge back once, by the card's serial, as a card_refund row", async () => {
    const r = await rig();
    await fund(r, ALICE, 50);
    const wallet = new EconomyCardWallet(r.economy);
    const charge = await wallet.spend(payer(ALICE), 30, CARD_REASONS.daily, "MYR-B");
    if (!charge.ok) throw new Error("refused");
    // Nothing was charged under another serial, and someone else has no charge under this one.
    expect(await wallet.refund(payer(ALICE), "MYR-C", CARD_REASONS.refund)).toBe(0);
    expect(await wallet.refund(payer(BOB), "MYR-B", CARD_REASONS.refund)).toBe(0);
    expect(await wallet.refund(payer(ALICE_TWO), "MYR-B", CARD_REASONS.refund)).toBe(30);
    expect(await wallet.refund(payer(ALICE), "MYR-B", CARD_REASONS.refund)).toBe(0);
    expect(await balance(r, ALICE)).toBe(50);
    const statement = await r.economy.statement(ALICE);
    expect(statement.ledger.filter((l) => l.delta === 30)).toHaveLength(1);
    expect(statement.ledger[0]).toMatchObject({ delta: 30, label: "每日卡退回" });
  });

  it("is spending on her for the board and recovered coins for the health table", () => {
    expect(BOARD_REASONS).toContain(CARD_REASONS.daily);
    expect(RECOVERED_REASONS).toContain(CARD_REASONS.daily);
  });
});
