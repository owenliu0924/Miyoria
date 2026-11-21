// Real instruments with the house as the counterparty (owner 2026-11-21). A closed vault cannot hold
// when prices come from outside, so: a buy burns its coins into a position; a sale mints the
// position's value back. What bounds inflation is in config:
//
// - Fees and the tax are burned, as on the local market.
// - A cap on the NET coins the house pays out per local day, per instrument and market-wide (net =
//   minted − burned). A sale over it still executes: what fits is paid now, the rest is queued and
//   paid first thing the next local day, and new buys of real instruments stop for the rest of the
//   day (so nobody can cycle coins through the cap). A queued payout is owed and always paid the next
//   day, whatever that day's cap says: the cap never traps a member's coins for longer than a night.
// - An automatic halt of real buys when the net minted over a rolling window passes a threshold; it
//   lifts by itself under three quarters of it. Sales never stop.
//
// Leverage is cross margin (owner's updated decision): up to the instrument class's maximum, and a
// member MAY lose more than the margin. A position is sold by the rule when the margin left falls to
// the line, at the quote that crossed it; with no daily limit a gap can take it past zero. Then the
// shortfall is taken, in this order, from: the wallet; the coins held by their open buy orders; their
// other real holdings (largest value first); their other leveraged positions; their local holdings
// (the module's callback). What still remains is written off by the house (a recorded line), every
// position is closed, and they are bankrupt (破產) for the cooling-off period. Never a negative
// balance, never a debt.
//
// Every coin is a ledger posting with its own keys and also a house line; the two always agree to
// the coin (`netOfPostings` against `netOfLines`). Pure: no clock, no store, no network.

import { feeOn, MILLI } from "../engine/money.js";
import type { RealInstrument, VolClass } from "./instruments.js";
import type { Quote } from "./provider.js";

/** Millionths of a unit in a unit: a coin buys a sliver of a coin. */
export const QTY_REAL = 1_000_000;

/** The ledger reasons of the house side (the health table reads them). */
export const HOUSE_REASON = {
  /** Coins burned into a real position (a buy's margin); `burn_back` when the buy did not fill. */
  burn: "exchange_burn",
  burnBack: "exchange_burn_back",
  /** Coins minted back by a sale, a payout, what a liquidation left. */
  mint: "exchange_mint",
  /** A loss past the margin, taken from the wallet. */
  loss: "exchange_loss",
  fee: "exchange_fee",
  feeBack: "exchange_fee_back",
} as const;

export interface HouseParams {
  fee_buy: number;
  fee_sell: number;
  tax_sell: number;
  fee_min: number;
  /** Net coins the house may pay out per local day, in all and per instrument. */
  cap_daily: number;
  cap_instrument: number;
  /** Real buys stop when the net minted over this many local days passes `halt_net`. */
  halt_window_days: number;
  halt_net: number;
  /** The most leverage by class (1: none). */
  leverage_max: Readonly<Record<VolClass, number>>;
  line: number;
  warn_half: number;
  warn_near: number;
  carry_daily: number;
  /** A real holding can be sold this long after it was bought. */
  min_hold_ms: number;
  /** An order that found no valid quote this long goes back. */
  order_ttl_ms: number;
  /** How long a bankrupt member waits before trading again. */
  cooling_ms: number;
}

export const DEFAULT_HOUSE: HouseParams = {
  fee_buy: 0.015,
  fee_sell: 0.015,
  tax_sell: 0.03,
  fee_min: 1,
  cap_daily: 1500,
  cap_instrument: 500,
  halt_window_days: 7,
  halt_net: 4000,
  leverage_max: { low: 2, mid: 2, high: 1.5, crypto: 1.5 },
  line: 0.2,
  warn_half: 0.5,
  warn_near: 0.35,
  carry_daily: 0.002,
  min_hold_ms: 60 * 60_000,
  order_ttl_ms: 30 * 60_000,
  cooling_ms: 7 * 86_400_000,
};

export interface RealPosition {
  id: string;
  person: string;
  code: string;
  leverage: number;
  /** Millionths of a unit. */
  qty: number;
  /** The exposure bought, in coins (what counts toward the holding limits). */
  cost: number;
  margin: number;
  loan: number;
  /** Thousandths of a coin. */
  carry: number;
  opened_at: number;
  warned_half: number | null;
  warned_near: number | null;
}

export interface RealOrder {
  id: string;
  person: string;
  code: string;
  side: "buy" | "sell";
  /** Coins per unit; `null`: at the next valid quote. */
  limit: number | null;
  coins: number;
  margin: number;
  exposure: number;
  fee: number;
  leverage: number;
  /** A sale: millionths of a unit. */
  qty: number;
  position: string | null;
  placed_at: number;
  expires_at: number;
}

export interface Payout {
  id: string;
  person: string;
  code: string;
  amount: number;
  /** The local day it was queued. */
  day: number;
}

export interface HouseDay {
  day: number;
  /** Coins burned: buys that filled (margin and fee), sale fees and tax, carry, losses taken. */
  burned: number;
  /** Coins minted to wallets. */
  minted: number;
  /** What the house wrote off for bankruptcies (no wallet moved). */
  written_off: number;
  by: Record<string, { burned: number; minted: number }>;
  /** The cap was reached: no new real buys today. */
  buys_halted: boolean;
}

export interface HouseState {
  today: HouseDay;
  history: HouseDay[];
  auto_halted: boolean;
  payouts: Payout[];
  /** Bankrupt members and until when (epoch ms). */
  bankrupt: Record<string, { since: number; until: number; written_off: number }>;
}

export interface HouseBook {
  positions: RealPosition[];
  orders: RealOrder[];
  state: HouseState;
}

export interface Posting {
  key: string;
  person: string;
  entries: { reason: string; delta: number }[];
  ref: string;
  /** Refused below zero (a buy, a loss taken from the wallet). */
  covered: boolean;
}

/**
 * `escrow`: a buy's coins held; `release`: held coins leaving the hold (into a position or a loss);
 * `writeoff`: what the house forgave (no wallet moved).
 */
export type LineKind =
  | "burn"
  | "mint"
  | "fee"
  | "loss"
  | "refund"
  | "escrow"
  | "release"
  | "writeoff";

/** The house's own record of a coin movement (`writeoff`: none moved). */
export interface HouseLine {
  kind: LineKind;
  person: string;
  code: string;
  amount: number;
  ref: string;
}

export interface RealFill {
  id: string;
  order: string | null;
  person: string;
  code: string;
  side: "buy" | "sell";
  kind: "order" | "liquidation" | "shortfall" | "bankruptcy" | "admin";
  position: string | null;
  leverage: number;
  qty: number;
  price: number;
  gross: number;
  fee: number;
  tax: number;
  carry: number;
  /** Coins credited now. */
  paid: number;
  /** Coins queued for the next day. */
  queued: number;
  /** A loss past the margin this fill left (taken from elsewhere). */
  shortfall: number;
  at: number;
}

export type RealNoticeKind =
  | "warn_half"
  | "warn_near"
  | "liquidated"
  | "shortfall"
  | "bankrupt"
  | "queued"
  | "refunded";

export interface RealNotice {
  kind: RealNoticeKind;
  person: string;
  code: string;
  position: string | null;
  price: number;
  line_price: number;
  ratio: number;
  amount: number;
  /** A liquidation: whether a warning came first (a gap may sell without one). */
  warned?: boolean;
}

export interface HouseOutcome {
  fills: RealFill[];
  ended: {
    order: RealOrder;
    status: "filled" | "cancelled" | "expired";
    why: string;
    refunded: boolean;
  }[];
  opened: RealPosition[];
  changed: RealPosition[];
  closed: { position: RealPosition; status: "closed" | "liquidated" }[];
  postings: Posting[];
  lines: HouseLine[];
  notices: RealNotice[];
  payouts_added: Payout[];
  payouts_paid: Payout[];
  bankrupt: string[];
}

export function emptyHouseOutcome(): HouseOutcome {
  return {
    fills: [],
    ended: [],
    opened: [],
    changed: [],
    closed: [],
    postings: [],
    lines: [],
    notices: [],
    payouts_added: [],
    payouts_paid: [],
    bankrupt: [],
  };
}

export function newDay(day: number): HouseDay {
  return { day, burned: 0, minted: 0, written_off: 0, by: {}, buys_halted: false };
}

export function newHouse(day: number): HouseBook {
  return {
    positions: [],
    orders: [],
    state: { today: newDay(day), history: [], auto_halted: false, payouts: [], bankrupt: {} },
  };
}

/** What the module gives a step: time, ids, the rules, wallets, the latest quotes. */
export interface HouseContext {
  now: number;
  day: number;
  params: HouseParams;
  newId: () => string;
  instruments: readonly RealInstrument[];
  /** Wallet balances as read before the step (a loss is taken from these). */
  balance: (person: string) => number;
  /** The latest accepted, fresh quote of an instrument whose market is open; `null` otherwise. */
  latest: (code: string) => Quote | null;
  /** The last accepted quote however old (a closed market's last price): what a loss is covered at. */
  lastKnown?: (code: string) => Quote | null;
  /** Sells the person's local holdings for a loss; the coins it covered. */
  sellLocal?: (person: string, need: number) => number;
}

// ---- reading ------------------------------------------------------------------------------------

export const valueAt = (qty: number, price: number) => (qty * price) / QTY_REAL;

export function equityOf(p: RealPosition, price: number): number {
  return valueAt(p.qty, price) - p.loan - p.carry / MILLI;
}

export function ratioOf(p: RealPosition, price: number): number {
  return p.margin > 0 ? equityOf(p, price) / p.margin : 1;
}

/** Coins per unit at which a leveraged position is sold: the margin left at `at` of the margin. */
export function priceAtRatio(p: RealPosition, at: number): number {
  if (p.qty <= 0) return 0;
  return ((p.loan + p.carry / MILLI + at * p.margin) * QTY_REAL) / p.qty;
}

/** The most leverage an instrument allows. */
export function maxLeverage(inst: RealInstrument, params: HouseParams): number {
  return Math.max(1, params.leverage_max[inst.vol] ?? 1);
}

export function isBankrupt(state: HouseState, person: string, now: number): boolean {
  const b = state.bankrupt[person];
  return b !== undefined && now < b.until;
}

export function buysHalted(state: HouseState): boolean {
  return state.today.buys_halted || state.auto_halted;
}

/** The net coins minted over the rolling window (history and today). */
export function rollingNet(state: HouseState, days: number): number {
  const recent = [...state.history.slice(-(days - 1)), state.today];
  return recent.reduce((t, d) => t + d.minted - d.burned, 0);
}

/** What a buy of `coins` (fee included) at `leverage` puts up. */
export function splitRealBuy(
  coins: number,
  leverage: number,
  p: HouseParams,
): { margin: number; exposure: number; fee: number } | null {
  if (!Number.isSafeInteger(coins) || coins <= 0) return null;
  const x = Math.max(1, leverage);
  const cost = (m: number) => m + feeOn(Math.floor(m * x), p.fee_buy, p.fee_min);
  let m = Math.floor(coins / (1 + x * p.fee_buy));
  while (m > 0 && cost(m) > coins) m--;
  while (cost(m + 1) <= coins) m++;
  if (m <= 0) return null;
  const exposure = Math.floor(m * x);
  return { margin: m, exposure, fee: feeOn(exposure, p.fee_buy, p.fee_min) };
}

// ---- the ledger and the house's lines ---------------------------------------------------------

function line(
  out: HouseOutcome,
  kind: LineKind,
  person: string,
  code: string,
  amount: number,
  ref: string,
): void {
  if (amount !== 0) out.lines.push({ kind, person, code, amount, ref });
}

function count(state: HouseState, code: string, burned: number, minted: number): void {
  const t = state.today;
  t.burned += burned;
  t.minted += minted;
  const b = t.by[code] ?? { burned: 0, minted: 0 };
  t.by[code] = b;
  b.burned += burned;
  b.minted += minted;
}

function post(
  out: HouseOutcome,
  key: string,
  person: string,
  ref: string,
  entries: [string, number][],
  covered = false,
): void {
  const e = entries.filter(([, d]) => d !== 0).map(([reason, delta]) => ({ reason, delta }));
  if (e.length > 0) out.postings.push({ key, person, ref, entries: e, covered });
}

/** The net coins the postings move (wallets' view). */
export function netOfPostings(postings: readonly Posting[]): number {
  return postings.reduce((t, p) => t + p.entries.reduce((s, e) => s + e.delta, 0), 0);
}

/** The net coins the house's lines move (its own view): mint and refund in, the rest out. */
export function netOfLines(lines: readonly HouseLine[]): number {
  let n = 0;
  for (const l of lines) {
    if (l.kind === "mint" || l.kind === "refund" || l.kind === "release") n += l.amount;
    else if (l.kind === "burn" || l.kind === "fee" || l.kind === "loss" || l.kind === "escrow")
      n -= l.amount;
  }
  return n;
}

/** A buy into the book: the posting burns its margin and fee from the wallet (refused below zero). */
export function placeRealBuy(book: HouseBook, order: RealOrder): HouseOutcome {
  const out = emptyHouseOutcome();
  book.orders.push(order);
  post(
    out,
    `exchange:order:${order.id}`,
    order.person,
    order.id,
    [
      [HOUSE_REASON.burn, -order.margin],
      [HOUSE_REASON.fee, -order.fee],
    ],
    true,
  );
  line(out, "escrow", order.person, order.code, order.margin + order.fee, order.id);
  return out;
}

export function placeRealSell(book: HouseBook, order: RealOrder): void {
  book.orders.push(order);
}

function endOrder(
  book: HouseBook,
  out: HouseOutcome,
  order: RealOrder,
  status: "filled" | "cancelled" | "expired",
  why: string,
): void {
  const at = book.orders.indexOf(order);
  if (at >= 0) book.orders.splice(at, 1);
  const refund = order.side === "buy" && status !== "filled";
  out.ended.push({ order, status, why, refunded: refund });
  if (refund) {
    post(out, `exchange:refund:${order.id}`, order.person, order.id, [
      [HOUSE_REASON.burnBack, order.margin],
      [HOUSE_REASON.feeBack, order.fee],
    ]);
    line(out, "refund", order.person, order.code, order.margin + order.fee, order.id);
  }
}

/** Takes an open order back; a buy's coins and fee go back. */
export function cancelRealOrder(
  book: HouseBook,
  id: string,
  why = "cancelled",
): HouseOutcome | null {
  const order = book.orders.find((o) => o.id === id);
  if (!order) return null;
  const out = emptyHouseOutcome();
  endOrder(book, out, order, "cancelled", why);
  return out;
}

// ---- paying out under the cap -----------------------------------------------------------------

/** Pays `amount` (net of burns already counted) under the caps; the rest is queued. */
function payOut(
  book: HouseBook,
  out: HouseOutcome,
  ctx: HouseContext,
  person: string,
  code: string,
  amount: number,
  ref: string,
): { paid: number; queued: number } {
  if (amount <= 0) return { paid: 0, queued: 0 };
  const t = book.state.today;
  const p = ctx.params;
  const byCode = t.by[code] ?? { burned: 0, minted: 0 };
  const room = Math.max(
    0,
    Math.min(
      p.cap_daily - (t.minted - t.burned),
      p.cap_instrument - (byCode.minted - byCode.burned),
    ),
  );
  const paid = Math.min(amount, Math.floor(room));
  const queued = amount - paid;
  if (paid > 0) {
    post(out, `exchange:mint:${ref}`, person, ref, [[HOUSE_REASON.mint, paid]]);
    line(out, "mint", person, code, paid, ref);
    count(book.state, code, 0, paid);
  }
  if (queued > 0) {
    const payout: Payout = { id: ctx.newId(), person, code, amount: queued, day: ctx.day };
    book.state.payouts.push(payout);
    out.payouts_added.push(payout);
    out.notices.push({
      kind: "queued",
      person,
      code,
      position: null,
      price: 0,
      line_price: 0,
      ratio: 0,
      amount: queued,
    });
    haltBuys(book, out, "cap");
  }
  return { paid, queued };
}

/** The day's cap was reached: no new real buy today, and the waiting ones go back. */
function haltBuys(book: HouseBook, out: HouseOutcome, why: string): void {
  book.state.today.buys_halted = true;
  for (const o of book.orders.filter((x) => x.side === "buy"))
    endOrder(book, out, o, "cancelled", why);
}

// ---- selling ------------------------------------------------------------------------------------

/** The fee and tax of a sale that brought in `gross`; never more than it. */
function burnsOf(gross: number, p: HouseParams): { fee: number; tax: number } {
  const fee = Math.min(Math.max(0, gross), feeOn(gross, p.fee_sell, p.fee_min));
  const tax = Math.min(Math.max(0, gross - fee), feeOn(gross, p.tax_sell, p.fee_min));
  return { fee, tax };
}

/**
 * Closes `pos` at `price`: what it brings is minted (under the caps) after its burns; a loss past
 * zero is the shortfall the caller covers. Answers the fill.
 */
function closeAt(
  book: HouseBook,
  out: HouseOutcome,
  ctx: HouseContext,
  pos: RealPosition,
  price: number,
  kind: RealFill["kind"],
  order: string | null,
  status: "closed" | "liquidated",
): RealFill {
  const gross = Math.floor(valueAt(pos.qty, price));
  const owedBack = gross - pos.loan;
  const burns = burnsOf(Math.max(0, owedBack), ctx.params);
  const carry = Math.min(
    Math.max(0, owedBack - burns.fee - burns.tax),
    Math.ceil(pos.carry / MILLI - 1e-9),
  );
  const burned = burns.fee + burns.tax + carry;
  // Negative: what the position lost past everything it put up.
  const net = owedBack - burned - (owedBack < 0 ? Math.ceil(pos.carry / MILLI - 1e-9) : 0);
  const id = ctx.newId();
  if (burned > 0) {
    // The burns come out of what the sale minted: one posting of both.
    post(out, `exchange:fill:${id}`, pos.person, id, [
      [HOUSE_REASON.mint, burned],
      [HOUSE_REASON.fee, -burned],
    ]);
    line(out, "mint", pos.person, pos.code, burned, id);
    line(out, "fee", pos.person, pos.code, burned, id);
    count(book.state, pos.code, burned, burned);
  }
  const { paid, queued } =
    net > 0 ? payOut(book, out, ctx, pos.person, pos.code, net, id) : { paid: 0, queued: 0 };
  const fill: RealFill = {
    id,
    order,
    person: pos.person,
    code: pos.code,
    side: "sell",
    kind,
    position: pos.id,
    leverage: pos.leverage,
    qty: pos.qty,
    price,
    gross,
    fee: burns.fee,
    tax: burns.tax,
    carry,
    paid,
    queued,
    shortfall: net < 0 ? -net : 0,
    at: ctx.now,
  };
  out.fills.push(fill);
  const at = book.positions.indexOf(pos);
  if (at >= 0) book.positions.splice(at, 1);
  const c = out.changed.indexOf(pos);
  if (c >= 0) out.changed.splice(c, 1);
  out.closed.push({ position: pos, status });
  return fill;
}

/**
 * A loss of `need` coins past a position's margin: from the wallet, the coins of open buys, other
 * real holdings, other leveraged positions, local holdings; the rest is written off and the person
 * is bankrupt. Answers what was written off.
 */
function cover(
  book: HouseBook,
  out: HouseOutcome,
  ctx: HouseContext,
  person: string,
  code: string,
  need: number,
  ref: string,
): number {
  let left = need;
  // 1. The wallet, as read before this step less what this step already took from it.
  const taken = out.postings
    .filter(
      (p) =>
        p.person === person && p.covered && p.entries.some((e) => e.reason === HOUSE_REASON.loss),
    )
    .reduce((t, p) => t - p.entries.reduce((s, e) => s + e.delta, 0), 0);
  const wallet = Math.max(0, ctx.balance(person) - taken);
  const fromWallet = Math.min(left, wallet);
  if (fromWallet > 0) {
    post(out, `exchange:loss:${ref}:wallet`, person, ref, [[HOUSE_REASON.loss, -fromWallet]], true);
    line(out, "loss", person, code, fromWallet, ref);
    count(book.state, code, fromWallet, 0);
    left -= fromWallet;
  }
  // 2. Open buys: their coins are theirs, and go to the loss instead of back.
  for (const o of book.orders.filter((x) => x.person === person && x.side === "buy")) {
    if (left <= 0) break;
    const at = book.orders.indexOf(o);
    book.orders.splice(at, 1);
    out.ended.push({ order: o, status: "cancelled", why: "shortfall", refunded: false });
    const held = o.margin + o.fee;
    const use = Math.min(left, held);
    left -= use;
    // The rest of what it held goes back; the used part was already out of the wallet (escrow).
    post(out, `exchange:refund:${o.id}`, person, o.id, [[HOUSE_REASON.burnBack, held - use]]);
    line(out, "refund", person, o.code, held - use, o.id);
    line(out, "release", person, o.code, use, `${o.id}:escrow`);
    line(out, "loss", person, code, use, o.id);
    count(book.state, code, use, 0);
  }
  // 3 and 4. Other real holdings, plain first (largest value first), then leveraged ones.
  const others = book.positions
    .filter((p) => p.person === person)
    .map((p) => ({ p, q: ctx.latest(p.code) ?? ctx.lastKnown?.(p.code) ?? null }))
    .filter((x): x is { p: RealPosition; q: Quote } => x.q !== null)
    .sort(
      (a, b) =>
        Number(a.p.leverage > 1) - Number(b.p.leverage > 1) ||
        valueAt(b.p.qty, b.q.price) - valueAt(a.p.qty, a.q.price),
    );
  for (const { p, q } of others) {
    if (left <= 0) break;
    const gross = Math.floor(valueAt(p.qty, q.price));
    const owedBack = gross - p.loan;
    const burns = burnsOf(Math.max(0, owedBack), ctx.params);
    const value = owedBack - burns.fee - burns.tax - Math.ceil(p.carry / MILLI - 1e-9);
    const id = ctx.newId();
    const used = Math.max(0, Math.min(left, value));
    const extra = Math.max(0, value - used);
    // Its burns are burned; what covers the loss never reaches the wallet; the rest is paid out.
    const burned = Math.max(0, burns.fee + burns.tax);
    if (burned > 0) count(book.state, p.code, burned, burned);
    line(out, "writeoff", person, p.code, 0, id);
    left -= used;
    if (value < 0) left += -value;
    const fill: RealFill = {
      id,
      order: null,
      person,
      code: p.code,
      side: "sell",
      kind: "shortfall",
      position: p.id,
      leverage: p.leverage,
      qty: p.qty,
      price: q.price,
      gross,
      fee: burns.fee,
      tax: burns.tax,
      carry: 0,
      paid: 0,
      queued: 0,
      shortfall: 0,
      at: ctx.now,
    };
    if (extra > 0) {
      const r = payOut(book, out, ctx, person, p.code, extra, id);
      fill.paid = r.paid;
      fill.queued = r.queued;
    }
    out.fills.push(fill);
    book.positions.splice(book.positions.indexOf(p), 1);
    out.closed.push({ position: p, status: "liquidated" });
  }
  // 5. Local holdings, through the module.
  if (left > 0 && ctx.sellLocal) {
    const got = Math.max(0, Math.min(left, ctx.sellLocal(person, left)));
    if (got > 0) {
      line(out, "writeoff", person, code, 0, `${ref}:local`);
      left -= got;
    }
  }
  if (left <= 0) {
    out.notices.push({
      kind: "shortfall",
      person,
      code,
      position: null,
      price: 0,
      line_price: 0,
      ratio: 0,
      amount: need,
    });
    return 0;
  }
  // Bankrupt: everything else closed; the house writes off what remains.
  for (const p of book.positions.filter((x) => x.person === person)) {
    book.positions.splice(book.positions.indexOf(p), 1);
    out.closed.push({ position: p, status: "liquidated" });
  }
  book.state.today.written_off += left;
  line(out, "writeoff", person, code, left, ref);
  book.state.bankrupt[person] = {
    since: ctx.now,
    until: ctx.now + ctx.params.cooling_ms,
    written_off: left,
  };
  out.bankrupt.push(person);
  out.notices.push({
    kind: "bankrupt",
    person,
    code,
    position: null,
    price: 0,
    line_price: 0,
    ratio: 0,
    amount: left,
  });
  return left;
}

// ---- a quote comes in -------------------------------------------------------------------------

/** Re-arms a warning once the margin left is well above it again. */
function rearm(p: RealPosition, ratio: number, params: HouseParams): boolean {
  let moved = false;
  if (p.warned_half !== null && ratio > params.warn_half + 0.1) {
    p.warned_half = null;
    moved = true;
  }
  if (p.warned_near !== null && ratio > params.warn_near + 0.1) {
    p.warned_near = null;
    moved = true;
  }
  return moved;
}

function notice(
  kind: RealNoticeKind,
  p: RealPosition,
  price: number,
  params: HouseParams,
  amount = 0,
): RealNotice {
  return {
    kind,
    person: p.person,
    code: p.code,
    position: p.id,
    price,
    line_price: priceAtRatio(p, params.line),
    ratio: Math.round(ratioOf(p, price) * 1000) / 1000,
    amount,
  };
}

/**
 * A new accepted quote of `inst` (the market open, the quote fresh): orders placed before the quote
 * fill at it, then every leveraged position on it is checked (a warning, or a sale at the line).
 */
export function onQuote(
  book: HouseBook,
  inst: RealInstrument,
  quote: Quote,
  ctx: HouseContext,
): HouseOutcome {
  const out = emptyHouseOutcome();
  const p = ctx.params;
  const price = quote.price;
  const waiting = book.orders
    .filter((o) => o.code === inst.code && o.placed_at < quote.at)
    .sort((a, b) => a.placed_at - b.placed_at || (a.id < b.id ? -1 : 1));
  for (const o of waiting) {
    if (!book.orders.includes(o)) continue;
    if (o.side === "buy") {
      if (buysHalted(book.state) || isBankrupt(book.state, o.person, ctx.now)) {
        endOrder(book, out, o, "cancelled", "halted");
        continue;
      }
      if (o.limit !== null && price > o.limit) continue;
      const qty = Math.floor((o.exposure * QTY_REAL) / price);
      if (qty <= 0) {
        endOrder(book, out, o, "cancelled", "too_small");
        continue;
      }
      const pos: RealPosition = {
        id: ctx.newId(),
        person: o.person,
        code: o.code,
        leverage: o.leverage,
        qty,
        cost: o.exposure,
        margin: o.margin,
        loan: o.exposure - o.margin,
        carry: 0,
        opened_at: quote.at,
        warned_half: null,
        warned_near: null,
      };
      book.positions.push(pos);
      out.opened.push(pos);
      // The escrow becomes burned: the margin into the position, the fee for good.
      line(out, "burn", o.person, o.code, o.margin, o.id);
      line(out, "fee", o.person, o.code, o.fee, o.id);
      line(out, "release", o.person, o.code, o.margin + o.fee, `${o.id}:escrow`);
      count(book.state, o.code, o.margin + o.fee, 0);
      out.fills.push({
        id: ctx.newId(),
        order: o.id,
        person: o.person,
        code: o.code,
        side: "buy",
        kind: "order",
        position: pos.id,
        leverage: o.leverage,
        qty,
        price,
        gross: o.exposure,
        fee: o.fee,
        tax: 0,
        carry: 0,
        paid: 0,
        queued: 0,
        shortfall: 0,
        at: ctx.now,
      });
      endOrder(book, out, o, "filled", "filled");
      continue;
    }
    if (o.limit !== null && price < o.limit) continue;
    if (o.position !== null) {
      const pos = book.positions.find((x) => x.id === o.position && x.person === o.person);
      if (!pos) {
        endOrder(book, out, o, "cancelled", "no_holding");
        continue;
      }
      const fill = closeAt(book, out, ctx, pos, price, "order", o.id, "closed");
      if (fill.shortfall > 0) cover(book, out, ctx, o.person, o.code, fill.shortfall, fill.id);
      endOrder(book, out, o, "filled", "filled");
      continue;
    }
    // A plain sale: lots held at least `min_hold_ms`, oldest first.
    const lots = book.positions
      .filter(
        (x) =>
          x.person === o.person &&
          x.code === o.code &&
          x.leverage <= 1 &&
          x.opened_at + p.min_hold_ms <= quote.at,
      )
      .sort((a, b) => a.opened_at - b.opened_at);
    let left = Math.min(
      o.qty,
      lots.reduce((t, l) => t + l.qty, 0),
    );
    if (left <= 0) {
      endOrder(book, out, o, "cancelled", "no_holding");
      continue;
    }
    for (const lot of lots) {
      if (left <= 0) break;
      if (lot.qty > left) {
        // Split the lot: the part sold becomes its own position.
        const part: RealPosition = {
          ...lot,
          id: ctx.newId(),
          qty: left,
          cost: Math.floor((lot.cost * left) / lot.qty),
          margin: Math.floor((lot.margin * left) / lot.qty),
        };
        lot.cost -= part.cost;
        lot.margin -= part.margin;
        lot.qty -= left;
        if (!out.changed.includes(lot)) out.changed.push(lot);
        book.positions.push(part);
        out.opened.push(part);
        closeAt(book, out, ctx, part, price, "order", o.id, "closed");
        left = 0;
      } else {
        left -= lot.qty;
        closeAt(book, out, ctx, lot, price, "order", o.id, "closed");
      }
    }
    endOrder(book, out, o, "filled", "filled");
  }
  // Every leveraged position on this instrument, at this quote.
  for (const pos of book.positions.filter((x) => x.code === inst.code && x.leverage > 1)) {
    if (!book.positions.includes(pos)) continue;
    const ratio = ratioOf(pos, price);
    if (rearm(pos, ratio, p) && !out.changed.includes(pos)) out.changed.push(pos);
    if (ratio <= p.line) {
      const warned = pos.warned_near !== null || pos.warned_half !== null;
      const fill = closeAt(book, out, ctx, pos, price, "liquidation", null, "liquidated");
      out.notices.push({
        ...notice("liquidated", pos, price, p, fill.paid + fill.queued),
        ratio: Math.round(ratio * 1000) / 1000,
        warned,
      });
      if (fill.shortfall > 0) cover(book, out, ctx, pos.person, pos.code, fill.shortfall, fill.id);
      continue;
    }
    if (ratio <= p.warn_near && pos.warned_near === null) {
      pos.warned_near = ctx.now;
      pos.warned_half ??= ctx.now;
      if (!out.changed.includes(pos)) out.changed.push(pos);
      out.notices.push(notice("warn_near", pos, price, p));
    } else if (ratio <= p.warn_half && pos.warned_half === null) {
      pos.warned_half = ctx.now;
      if (!out.changed.includes(pos)) out.changed.push(pos);
      out.notices.push(notice("warn_half", pos, price, p));
    }
  }
  updateHalt(book, ctx);
  return out;
}

/** Orders that found no valid quote in time go back. */
export function expireOrders(book: HouseBook, now: number): HouseOutcome {
  const out = emptyHouseOutcome();
  for (const o of [...book.orders])
    if (o.expires_at <= now) endOrder(book, out, o, "expired", "expired");
  return out;
}

function updateHalt(book: HouseBook, ctx: HouseContext): void {
  const net = rollingNet(book.state, ctx.params.halt_window_days);
  if (!book.state.auto_halted && net > ctx.params.halt_net) book.state.auto_halted = true;
  else if (book.state.auto_halted && net < 0.75 * ctx.params.halt_net)
    book.state.auto_halted = false;
}

/**
 * A new local day: yesterday goes into the history, the carry fee is charged to leveraged
 * positions, and the payouts queued yesterday are paid first, whatever today's cap.
 */
export function rollDay(book: HouseBook, ctx: HouseContext): HouseOutcome {
  const out = emptyHouseOutcome();
  const s = book.state;
  if (s.today.day === ctx.day) return out;
  s.history.push(s.today);
  if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
  s.today = newDay(ctx.day);
  for (const pos of book.positions) {
    if (pos.leverage <= 1 || pos.loan <= 0) continue;
    pos.carry += Math.ceil(pos.loan * ctx.params.carry_daily * MILLI - 1e-9);
    out.changed.push(pos);
  }
  for (const payout of s.payouts.splice(0)) {
    post(out, `exchange:payout:${payout.id}`, payout.person, payout.id, [
      [HOUSE_REASON.mint, payout.amount],
    ]);
    line(out, "mint", payout.person, payout.code, payout.amount, payout.id);
    count(s, payout.code, 0, payout.amount);
    out.payouts_paid.push(payout);
  }
  updateHalt(book, ctx);
  return out;
}

/** Sells a real position now for the owner at its latest quote (no fee); `null` without a quote. */
export function adminSellReal(
  book: HouseBook,
  pos: RealPosition,
  ctx: HouseContext,
): HouseOutcome | null {
  const q = ctx.latest(pos.code);
  if (!q) return null;
  const out = emptyHouseOutcome();
  const free = { ...ctx, params: { ...ctx.params, fee_sell: 0, tax_sell: 0, fee_min: 0 } };
  const fill = closeAt(book, out, free, pos, q.price, "admin", null, "closed");
  if (fill.shortfall > 0) cover(book, out, free, pos.person, pos.code, fill.shortfall, fill.id);
  return out;
}

/** A position's value to its owner now at `price` (leveraged: equity, floored at zero). */
export function worthOf(p: RealPosition, price: number): number {
  return p.leverage > 1 ? Math.max(0, equityOf(p, price)) : valueAt(p.qty, price);
}
