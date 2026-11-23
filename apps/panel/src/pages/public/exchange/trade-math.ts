// The order ticket's arithmetic, worked out here so the numbers show while the member types: what
// an amount buys or brings back, the fee, what is left in the wallet, the profit or loss a sale
// realises, the quick amounts, and where a refusal is said. The Core's quote has the final say: this
// is the estimate shown until it answers, the same rules as `packages/play/exchange` (one fee,
// rounded up with a smallest of `fee_min`; a buy's coins include its fee; 2x puts the fee on the
// whole position). Pure: no DOM, no fetch. Shares are in millionths, prices in coins a share.

import type { ExchangeAccount, ExchangeMarket, ExchangeOrderRequest, ExchangePortfolio } from "@miyoria/contracts/api";

export const QTY = 1_000_000;
export type Side = "buy" | "sell";
/** What the field holds: coins (金額) or shares (股數). */
export type Mode = "coins" | "shares";
type Rules = Pick<ExchangeMarket["rules"], "fee" | "fee_min">;
type Holding = ExchangePortfolio["holdings"][number];

/** A fee on `amount` coins: rounded up, at least `min`; nothing on nothing. */
export function feeOn(amount: number, rate: number, min: number): number {
  if (amount <= 0 || rate <= 0) return 0;
  return Math.max(min, Math.ceil(amount * rate - 1e-9));
}

/** How `coins` (fee included) split at `leverage`: the largest margin whose fee still fits. */
export function splitBuy(coins: number, leverage: number, r: Rules): { margin: number; exposure: number; fee: number } | null {
  if (!Number.isFinite(coins) || coins <= 0) return null;
  const x = Math.max(1, Math.floor(leverage));
  const cost = (m: number) => m + feeOn(m * x, r.fee, r.fee_min);
  let margin = Math.floor(coins / (1 + x * r.fee));
  while (margin > 0 && cost(margin) > coins) margin--;
  while (cost(margin + 1) <= coins) margin++;
  if (margin <= 0) return null;
  return { margin, exposure: margin * x, fee: feeOn(margin * x, r.fee, r.fee_min) };
}

/** What a 1x buy of `shares` costs in coins now, fee included (as the Core prices a buy by shares). */
export function coinsForShares(shares: number, price: number, r: Rules): number {
  const exposure = Math.ceil(shares * price - 1e-9);
  return exposure + feeOn(exposure, r.fee, r.fee_min);
}

/** The most shares (four places) `budget` coins buy at 1x, fee included. */
export function sharesForBudget(budget: number, price: number, r: Rules): number {
  if (!(price > 0) || budget <= 0) return 0;
  let s = Math.floor(((budget / (1 + r.fee)) / price) * 10_000) / 10_000;
  while (s > 0 && coinsForShares(s, price, r) > budget) s = Math.round((s - 0.0001) * 10_000) / 10_000;
  return Math.max(0, s);
}

/** A number as the field shows it: no separators, at most `places` decimals, no trailing zeros. */
export const fieldText = (n: number, places = 4) => String(Number(n.toFixed(places)));

export type Parsed = { ok: true; value: number } | { ok: false; empty: boolean; message: string | null };

/** What was typed into the field: digits, a decimal point, separators and spaces are allowed. */
export function parseField(raw: string, mode: Mode, currency: string): Parsed {
  const t = raw
    .replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s,]/g, "");
  if (t === "") return { ok: false, empty: true, message: null };
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return { ok: false, empty: false, message: "只能寫數字" };
  const value = Number(t);
  if (!(value > 0)) return { ok: false, empty: false, message: "要大於 0" };
  const decimals = t.includes(".") ? (t.split(".")[1] ?? "") : "";
  if (mode === "coins" && /[1-9]/.test(decimals)) return { ok: false, empty: false, message: `${currency}只能是整數` };
  if (mode === "shares" && decimals.length > 6 && /[1-9]/.test(decimals.slice(6))) return { ok: false, empty: false, message: "股數最多到小數點後 6 位" };
  return { ok: true, value: mode === "coins" ? Math.round(value) : value };
}

/** What they hold of one ticker: plain lots, 2x positions, what is free to sell, the average cost. */
export interface Held {
  lots: Holding[];
  levered: Holding[];
  /** Plain shares (millionths) not already in a waiting sale. */
  free: number;
  /** Plain shares (millionths) in all. */
  qty: number;
  /** What the plain lots cost, in coins. */
  cost: number;
  /** Their worth at the last known price (`null`: no price). */
  value: number | null;
  /** Coins a share they paid on average (plain lots; `null`: none). */
  avg: number | null;
  /** Waiting orders of this ticker. */
  orders: ExchangePortfolio["orders"];
}

export function heldOf(p: ExchangePortfolio | undefined, code: string): Held {
  const mine = p?.holdings.filter((h) => h.code === code) ?? [];
  const lots = mine.filter((h) => h.leverage <= 1);
  const levered = mine.filter((h) => h.leverage > 1);
  const orders = p?.orders.filter((o) => o.code === code && o.status === "open") ?? [];
  const qty = lots.reduce((t, h) => t + h.qty, 0);
  const pending = orders.filter((o) => o.side === "sell" && o.position === null).reduce((t, o) => t + o.qty, 0);
  const cost = lots.reduce((t, h) => t + h.cost, 0);
  const value = lots.length === 0 || lots.some((h) => h.value === null) ? null : lots.reduce((t, h) => t + (h.value ?? 0), 0);
  return { lots, levered, free: Math.max(0, qty - pending), qty, cost, value, avg: qty > 0 ? cost / (qty / QTY) : null, orders };
}

/** A holding's gain or loss on what they put in: a plain lot on its cost, a 2x position on its margin. */
export function holdingGain(h: Holding): { amount: number | null; base: number } {
  if (h.leverage > 1) return { amount: h.equity === null ? null : h.equity - h.margin, base: h.margin };
  return { amount: h.value === null ? null : h.value - h.cost, base: h.cost };
}

/** The numbers an order would come to. `null` fields are not known yet (no price, nothing typed). */
export interface Estimate {
  side: Side;
  leverage: number;
  qty: number | null;
  price: number | null;
  fee: number | null;
  /** Buy: coins paid, fee included. */
  paid: number | null;
  margin: number | null;
  exposure: number | null;
  /** Sale: what it brings in before the fee, the loan a 2x position pays back first, what comes back. */
  gross: number | null;
  loan: number;
  net: number | null;
  /** 2x: where the position is sold by the rules (the Core's number only). */
  line: number | null;
  /** Sale: the profit or loss it realises, and what it stands on. */
  pnl: number | null;
  pnlBase: number | null;
  /** The wallet after the order (a buy: now; a sale: once it fills). */
  after: number | null;
}

const blank = (side: Side, leverage = 1): Estimate => ({
  side,
  leverage,
  qty: null,
  price: null,
  fee: null,
  paid: null,
  margin: null,
  exposure: null,
  gross: null,
  loan: 0,
  net: null,
  line: null,
  pnl: null,
  pnlBase: null,
  after: null,
});

/** A sale's fee: on what it brings in after the loan, at least `fee_min`, never more than that. */
function saleFee(gross: number, loan: number, r: Rules): number {
  return Math.max(0, Math.min(gross - loan, Math.max(r.fee_min, Math.ceil((gross - loan) * r.fee - 1e-9))));
}

/** The local estimate of `req` at `price` (coins a share). */
export function estimate(req: ExchangeOrderRequest | null, price: number | null, r: Rules, held: Held, balance: number | null, side: Side): Estimate {
  if (!req) return { ...blank(side), price };
  const leverage = req.leverage ?? 1;
  const e = blank(req.side, leverage);
  e.price = price;
  if (req.side === "buy") {
    const coinsIn = req.coins ?? (req.shares !== undefined && price ? coinsForShares(req.shares, price, r) : null);
    if (coinsIn === null) return e;
    const split = splitBuy(coinsIn, leverage, r);
    if (!split) return e;
    e.paid = split.margin + split.fee;
    e.fee = split.fee;
    e.margin = split.margin;
    e.exposure = split.exposure;
    e.qty = price ? Math.floor((split.exposure * QTY) / price) : null;
    e.after = balance === null ? null : balance - e.paid;
    return e;
  }
  const position = req.position ? [...held.levered, ...held.lots].find((h) => h.id === req.position) : undefined;
  let qty: number;
  if (position) {
    qty = position.qty;
    e.loan = position.loan;
  } else if (req.all) qty = held.free;
  else if (req.coins !== undefined) qty = price ? Math.min(held.free, Math.floor((req.coins / price) * QTY)) : 0;
  else qty = Math.min(held.free, Math.round((req.shares ?? 0) * QTY));
  e.qty = qty;
  if (!price || qty <= 0) return e;
  e.gross = Math.floor((qty * price) / QTY + 1e-9);
  e.fee = saleFee(e.gross, e.loan, r);
  e.net = Math.max(0, e.gross - e.loan - e.fee);
  const basis = position ? (position.leverage > 1 ? position.margin : position.cost) : held.avg === null ? null : (qty / QTY) * held.avg;
  e.pnl = basis === null ? null : e.net - basis;
  e.pnlBase = basis;
  e.after = balance === null ? null : balance + e.net;
  return e;
}

/** The most a buy may put in now: what they may invest, under one order's cap and today's buys left. */
export function buyBudget(account: ExchangeAccount, rules: ExchangeMarket["rules"]): number | null {
  if (account.investable === null) return null;
  const caps = [account.investable, rules.order_max > 0 ? rules.order_max : Number.POSITIVE_INFINITY, account.today.buy_left ?? Number.POSITIVE_INFINITY];
  return Math.max(0, Math.floor(Math.min(...caps)));
}

/** A quick amount: what it puts in the field, or `all` for a whole sale. */
export type Chip = { label: string; text: string; all: boolean; disabled: boolean };

export function chips(o: { side: Side; mode: Mode; budget: number | null; free: number; price: number | null; rules: Rules }): Chip[] {
  if (o.side === "buy") {
    const b = o.budget ?? 0;
    return ([0.25, 0.5, 0.75, 1] as const).map((p) => {
      const coinsIn = Math.floor(b * p);
      const text = o.mode === "coins" ? String(coinsIn) : fieldText(o.price ? sharesForBudget(coinsIn, o.price, o.rules) : 0);
      return { label: p === 1 ? "全部" : `${p * 100}%`, text, all: false, disabled: coinsIn <= 0 || text === "0" };
    });
  }
  return ([0.25, 0.5, 1] as const).map((p) => {
    const qty = Math.floor(o.free * p);
    const text = o.mode === "shares" ? fieldText(qty / QTY, 6) : o.price ? String(Math.floor((qty / QTY) * o.price)) : "0";
    return { label: p === 1 ? "全部" : `${p * 100}%`, text, all: p === 1, disabled: qty <= 0 };
  });
}

/** Which control a refusal belongs beside: the amount, the 1x/2x choice, or the order as a whole. */
export type Place = "amount" | "leverage" | "general";

export function placeRefusal(message: string): Place {
  // The Core's refusals carry only a sentence here (its code stays on the server), so they are
  // told apart by their words: first what is about the order as a whole.
  if (/不開放買進|暫停交易|現在沒有開$|筆委託|破產|停止買進|還沒開戶|不認識你/.test(message)) return "general";
  if (/倍|槓桿|保證金/.test(message)) return "leverage";
  if (/不夠|一筆|最多買|持有上限|太小|股數|要賣多少|才能賣|可以賣|轉給你|至少|還沒有(報價|價格)/.test(message)) return "amount";
  return "general";
}
