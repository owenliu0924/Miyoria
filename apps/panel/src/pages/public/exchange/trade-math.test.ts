// The ticket's arithmetic against the Core's rules (one fee rounded up with a smallest, a buy's
// coins include it, 2x puts it on the whole position), the quick amounts, a sale's realised gain
// and where a refusal is said. Every name and number here is made up.

import { describe, expect, it } from "vitest";
import type { ExchangePortfolio } from "@miyoria/contracts/api";
import { chips, coinsForShares, estimate, feeOn, heldOf, parseField, placeRefusal, sharesForBudget, splitBuy } from "./trade-math";

const RULES = { fee: 0.01, fee_min: 1 };

const PORTFOLIO: ExchangePortfolio = {
  balance: 1000,
  holdings: [
    { id: "a", code: "KELP", name: "海帶食品", leverage: 1, qty: 2_000_000, cost: 180, margin: 180, loan: 0, price: 100, value: 200, equity: 200, ratio: null, line_price: null, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-20T00:00:00.000Z", can_sell: true },
    { id: "b", code: "KELP", name: "海帶食品", leverage: 2, qty: 1_000_000, cost: 100, margin: 50, loan: 50, price: 100, value: 100, equity: 50, ratio: 1, line_price: 60, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-20T00:00:00.000Z", can_sell: true },
  ],
  orders: [{ id: "o", code: "KELP", side: "sell", coins: 0, qty: 500_000, leverage: 1, position: null, status: "open", why: null, at: "2026-11-20T00:00:00.000Z", next_open: null }],
  fills: [],
  notices: [],
  bankrupt: null,
  totals: { cost: 280, value: 250 },
};

describe("the ticket's arithmetic", () => {
  it("rounds the fee up with a smallest, and splits a buy's coins so margin and fee fit", () => {
    expect(feeOn(150, 0.01, 1)).toBe(2);
    expect(feeOn(40, 0.01, 1)).toBe(1);
    expect(feeOn(0, 0.01, 1)).toBe(0);
    expect(splitBuy(101, 1, RULES)).toEqual({ margin: 100, exposure: 100, fee: 1 });
    // 2x: the fee is on the whole position.
    expect(splitBuy(1000, 2, RULES)).toEqual({ margin: 980, exposure: 1960, fee: 20 });
    expect(splitBuy(0, 1, RULES)).toBeNull();
  });

  it("prices shares as the Core does and finds the most shares a budget buys", () => {
    expect(coinsForShares(2, 100, RULES)).toBe(202);
    const s = sharesForBudget(500, 2000, RULES);
    expect(coinsForShares(s, 2000, RULES)).toBeLessThanOrEqual(500);
    expect(coinsForShares(s + 0.0001, 2000, RULES)).toBeGreaterThan(500);
  });

  it("reads the field: separators and full-width digits are fine, coins are whole", () => {
    expect(parseField("1,200", "coins", "貝殼")).toEqual({ ok: true, value: 1200 });
    expect(parseField("１２", "shares", "貝殼")).toEqual({ ok: true, value: 12 });
    expect(parseField("0.5", "coins", "貝殼")).toEqual({ ok: false, empty: false, message: "貝殼只能是整數" });
    expect(parseField("", "coins", "貝殼")).toEqual({ ok: false, empty: true, message: null });
    expect(parseField("三", "shares", "貝殼")).toEqual({ ok: false, empty: false, message: "只能寫數字" });
  });

  it("knows what they hold: plain lots apart from 2x, minus what already waits to be sold", () => {
    const held = heldOf(PORTFOLIO, "KELP");
    expect(held.qty).toBe(2_000_000);
    expect(held.free).toBe(1_500_000);
    expect(held.avg).toBe(90);
    expect(held.levered.map((h) => h.id)).toEqual(["b"]);
  });

  it("estimates a sale's money back and its realised gain on the average cost", () => {
    const held = heldOf(PORTFOLIO, "KELP");
    const e = estimate({ side: "sell", code: "KELP", shares: 1 }, 100, RULES, held, 1000, "sell");
    expect(e).toMatchObject({ qty: 1_000_000, gross: 100, fee: 1, net: 99, pnl: 9, pnlBase: 90, after: 1099 });
    // A 2x position pays its loan back first; its gain is on the margin.
    const p = estimate({ side: "sell", code: "KELP", position: "b" }, 120, RULES, held, 1000, "sell");
    expect(p).toMatchObject({ qty: 1_000_000, gross: 120, loan: 50, fee: 1, net: 69, pnl: 19, pnlBase: 50 });
  });

  it("gives quick amounts of what they may spend, or of what they hold", () => {
    expect(chips({ side: "buy", mode: "coins", budget: 500, free: 0, price: 100, rules: RULES }).map((c) => [c.label, c.text])).toEqual([
      ["25%", "125"],
      ["50%", "250"],
      ["75%", "375"],
      ["全部", "500"],
    ]);
    const sell = chips({ side: "sell", mode: "shares", budget: null, free: 1_500_000, price: 100, rules: RULES });
    expect(sell.map((c) => [c.label, c.text, c.all])).toEqual([
      ["25%", "0.375", false],
      ["50%", "0.75", false],
      ["全部", "1.5", true],
    ]);
    expect(chips({ side: "sell", mode: "shares", budget: null, free: 0, price: 100, rules: RULES }).every((c) => c.disabled)).toBe(true);
  });

  it("puts each refusal beside the control it is about", () => {
    expect(placeRefusal("貝殼不夠")).toBe("amount");
    expect(placeRefusal("一筆買進是 10 到 500 貝殼")).toBe("amount");
    expect(placeRefusal("買進後 10 分鐘才能賣")).toBe("amount");
    expect(placeRefusal("這檔只能 1 倍:2 倍只開放一股至少 50 貝殼、有前一天收盤價的標的")).toBe("leverage");
    expect(placeRefusal("槓桿的保證金合計最多 150 貝殼")).toBe("leverage");
    expect(placeRefusal("一天最多 20 筆委託")).toBe("general");
    expect(placeRefusal("這檔不開放買進(可以賣出)")).toBe("general");
    expect(placeRefusal("交易所現在沒有開")).toBe("general");
  });
});
