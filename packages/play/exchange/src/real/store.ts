// The real side's tables (`schema.ts`, version 2). Everything one step of the house did (a quote
// coming in, an order, a cancel, a new day) is written in one `Db.tx` with the postings it owes the
// wallets (`exchange_postings`, posted after under their keys) and the house's own lines, so the
// two records can be added up against each other at any time.

import type { Db } from "@miyoria/store";
import {
  type AccountRef,
  type ExchangeEntry,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  exchangeFills,
  exchangeHouse,
  exchangeHouseLines,
  exchangeInstruments,
  exchangeLocalDays,
  exchangeMarks,
  exchangeNotices,
  exchangeOrders,
  exchangePositions,
  exchangePostings,
  exchangeQuotes,
  exchangeQuoteTicks,
  exchangeRealFills,
  exchangeRealOrders,
  exchangeRealPositions,
} from "../schema.js";
import type {
  HouseBook,
  HouseLine,
  HouseOutcome,
  HouseState,
  RealFill,
  RealOrder,
  RealPosition,
} from "./house.js";
import { newHouse } from "./house.js";
import { taipeiDay, taipeiDayWindow } from "./local.js";
import type { Quote } from "./provider.js";

export type RealOrderStatus = "charging" | "open" | "filled" | "cancelled" | "expired" | "void";

export interface RealOrderRecord extends RealOrder {
  account: AccountRef;
  name: string;
  request_key: string;
  status: RealOrderStatus;
  why: string | null;
}

export interface RealNoticeRecord {
  id: string;
  person: PersonId;
  kind: string;
  position: string | null;
  text: string;
  created_at: Timestamp;
  /** On their page only (no DM). */
  quiet: boolean;
}

const ms = (t: Timestamp | null) => (t === null ? null : Date.parse(t));
const ts = (n: number) => toTimestamp(n);

/** A local stock's day as one bar (`exchange_local_days`): its first, highest, lowest and last tick. */
export interface LocalDayBar {
  /** The Taipei day number. */
  day: number;
  first_at: number;
  last_at: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** What the day's ±10% band was measured from. */
  ref: number;
  ticks: number;
}

function dayOf(r: typeof exchangeLocalDays.$inferSelect): LocalDayBar {
  return {
    day: r.day,
    first_at: Date.parse(r.first_at),
    last_at: Date.parse(r.last_at),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    ref: r.ref,
    ticks: r.ticks,
  };
}

/** Two parts of one day as one bar: the earlier's open and reference, the later's close. */
function mergeBars(a: LocalDayBar, b: LocalDayBar): LocalDayBar {
  const early = a.first_at <= b.first_at ? a : b;
  return {
    day: a.day,
    first_at: early.first_at,
    last_at: Math.max(a.last_at, b.last_at),
    open: early.open,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    close: a.last_at >= b.last_at ? a.close : b.close,
    ref: early.ref,
    ticks: a.ticks + b.ticks,
  };
}

type OrderRow = typeof exchangeRealOrders.$inferSelect;
type PositionRow = typeof exchangeRealPositions.$inferSelect;

function orderOf(r: OrderRow): RealOrderRecord {
  return {
    id: r.id,
    person: r.person_id,
    account: { platform: r.platform, id: r.account_id },
    name: r.name,
    request_key: r.request_key,
    code: r.code,
    side: r.side as RealOrder["side"],
    limit: r.limit_price,
    coins: r.coins,
    margin: r.margin,
    exposure: r.exposure,
    fee: r.fee,
    leverage: r.leverage,
    qty: r.qty,
    position: r.position_id,
    placed_at: Date.parse(r.placed_at),
    expires_at: Date.parse(r.expires_at),
    status: r.status as RealOrderStatus,
    why: r.why,
  };
}

function positionOf(r: PositionRow): RealPosition {
  return {
    id: r.id,
    person: r.person_id,
    code: r.code,
    leverage: r.leverage,
    qty: r.qty,
    cost: r.cost,
    margin: r.margin,
    loan: r.loan,
    carry: r.carry,
    opened_at: Date.parse(r.opened_at),
    warned_half: ms(r.warned_half),
    warned_near: ms(r.warned_near),
  };
}

function positionValues(p: RealPosition) {
  return {
    id: p.id,
    person_id: p.person,
    code: p.code,
    leverage: p.leverage,
    qty: p.qty,
    cost: p.cost,
    margin: p.margin,
    loan: p.loan,
    carry: p.carry,
    opened_at: ts(p.opened_at),
    warned_half: p.warned_half === null ? null : ts(p.warned_half),
    warned_near: p.warned_near === null ? null : ts(p.warned_near),
  };
}

export class RealStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #write<T>(fn: () => T): T {
    return this.#db.tx(fn);
  }

  state(): HouseState | null {
    this.#db.ensureOpen();
    const r = this.#db.orm.select().from(exchangeHouse).where(eq(exchangeHouse.id, 1)).get();
    return r ? (JSON.parse(r.state) as HouseState) : null;
  }

  /** The house's book; made on first use. */
  book(day: number, now: number): HouseBook {
    let state = this.state();
    if (!state) {
      state = newHouse(day).state;
      this.#write(() => {
        this.#db.orm
          .insert(exchangeHouse)
          .values({ id: 1, state: JSON.stringify(state), updated_at: ts(now) })
          .onConflictDoNothing()
          .run();
      });
      state = this.state() as HouseState;
    }
    const orders = this.#db.orm
      .select()
      .from(exchangeRealOrders)
      .where(eq(exchangeRealOrders.status, "open"))
      .orderBy(asc(exchangeRealOrders.placed_at), asc(exchangeRealOrders.id))
      .all()
      .map((r) => strip(orderOf(r)));
    const positions = this.openPositions();
    return { positions, orders, state };
  }

  /** Writes what a step did, in one transaction. */
  commit(
    out: HouseOutcome,
    book: HouseBook,
    now: number,
    day: number,
    extra: { placed?: RealOrderRecord[]; notices?: RealNoticeRecord[]; by?: string | null } = {},
  ): void {
    const orm = this.#db.orm;
    this.#write(() => {
      for (const o of extra.placed ?? []) this.#insertOrder(o, "open");
      for (const p of out.opened)
        orm
          .insert(exchangeRealPositions)
          .values({ ...positionValues(p), status: "open" })
          .onConflictDoNothing()
          .run();
      for (const p of out.changed)
        orm
          .update(exchangeRealPositions)
          .set(positionValues(p))
          .where(eq(exchangeRealPositions.id, p.id))
          .run();
      for (const { position, status } of out.closed) {
        orm
          .update(exchangeRealPositions)
          .set({ ...positionValues(position), status, closed_at: ts(now) })
          .where(eq(exchangeRealPositions.id, position.id))
          .run();
      }
      for (const f of out.fills)
        this.#insertFill(f, f.kind === "admin" ? (extra.by ?? null) : null, now);
      for (const e of out.ended) {
        orm
          .update(exchangeRealOrders)
          .set({ status: e.status, why: e.why, ended_at: ts(now) })
          .where(
            and(
              eq(exchangeRealOrders.id, e.order.id),
              inArray(exchangeRealOrders.status, ["open", "charging"]),
            ),
          )
          .run();
      }
      for (const p of out.postings) {
        // A buy's charge is posted at once by the caller; everything else waits for the outbox.
        if (p.covered && p.key.startsWith("exchange:order:")) continue;
        const entries: ExchangeEntry[] = p.entries.map((e) => ({
          reason: e.reason as ExchangeEntry["reason"],
          delta: e.delta,
          key: `${p.key}:${e.reason}`,
        }));
        orm
          .insert(exchangePostings)
          .values({
            key: p.key,
            person_id: p.person,
            entries: JSON.stringify(entries),
            ref: p.ref,
            covered: p.covered,
            status: "pending",
            created_at: ts(now),
          })
          .onConflictDoNothing()
          .run();
      }
      for (const l of out.lines) {
        orm
          .insert(exchangeHouseLines)
          .values({
            day,
            kind: l.kind,
            person_id: l.person,
            code: l.code,
            amount: l.amount,
            ref: l.ref,
            at: ts(now),
          })
          .run();
      }
      for (const n of extra.notices ?? []) {
        orm
          .insert(exchangeNotices)
          .values({
            id: n.id,
            person_id: n.person,
            kind: n.kind,
            position_id: n.position,
            order_id: null,
            round: -1,
            text: n.text,
            created_at: n.created_at,
            sent_at: n.quiet ? n.created_at : null,
          })
          .run();
      }
      orm
        .update(exchangeHouse)
        .set({ state: JSON.stringify(book.state), updated_at: ts(now) })
        .where(eq(exchangeHouse.id, 1))
        .run();
    });
  }

  #insertOrder(o: RealOrderRecord, status: RealOrderStatus): void {
    this.#db.orm
      .insert(exchangeRealOrders)
      .values({
        id: o.id,
        person_id: o.person,
        platform: o.account.platform,
        account_id: o.account.id,
        name: o.name,
        request_key: o.request_key,
        code: o.code,
        side: o.side,
        limit_price: o.limit,
        coins: o.coins,
        margin: o.margin,
        exposure: o.exposure,
        fee: o.fee,
        leverage: o.leverage,
        qty: o.qty,
        position_id: o.position,
        placed_at: ts(o.placed_at),
        expires_at: ts(o.expires_at),
        status,
      })
      .run();
  }

  #insertFill(f: RealFill, by: string | null, now: number): void {
    this.#db.orm
      .insert(exchangeRealFills)
      .values({
        id: f.id,
        order_id: f.order,
        person_id: f.person,
        code: f.code,
        side: f.side,
        kind: f.kind,
        position_id: f.position,
        leverage: f.leverage,
        qty: f.qty,
        price: f.price,
        gross: Math.max(0, f.gross),
        fee: f.fee,
        tax: f.tax,
        carry: f.carry,
        paid: f.paid,
        shortfall: f.shortfall,
        by,
        created_at: ts(now),
      })
      .run();
  }

  // ---- a buy's charge ---------------------------------------------------------------------

  orderByKey(person: PersonId, key: string): RealOrderRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select()
      .from(exchangeRealOrders)
      .where(and(eq(exchangeRealOrders.person_id, person), eq(exchangeRealOrders.request_key, key)))
      .get();
    return r ? orderOf(r) : null;
  }

  startBuy(o: RealOrderRecord, key: string, entries: ExchangeEntry[], now: number): void {
    this.#write(() => {
      this.#insertOrder(o, "charging");
      this.#db.orm
        .insert(exchangePostings)
        .values({
          key,
          person_id: o.person,
          entries: JSON.stringify(entries),
          ref: o.id,
          covered: true,
          status: "pending",
          created_at: ts(now),
        })
        .run();
    });
  }

  settleBuy(order: string, key: string, charged: boolean, now: number): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangeRealOrders)
        .set(charged ? { status: "open" } : { status: "void", why: "cancelled", ended_at: ts(now) })
        .where(and(eq(exchangeRealOrders.id, order), eq(exchangeRealOrders.status, "charging")))
        .run();
      this.#db.orm
        .update(exchangePostings)
        .set({ status: charged ? "posted" : "short", posted_at: ts(now) })
        .where(and(eq(exchangePostings.key, key), eq(exchangePostings.status, "pending")))
        .run();
    });
  }

  charging(): RealOrderRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeRealOrders)
      .where(eq(exchangeRealOrders.status, "charging"))
      .all()
      .map(orderOf);
  }

  /** Losses to take from wallets (covered postings) not posted yet. */
  pendingLosses(): { key: string; person: PersonId; entries: ExchangeEntry[]; ref: string }[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangePostings)
      .where(
        and(
          eq(exchangePostings.status, "pending"),
          eq(exchangePostings.covered, true),
          sql`${exchangePostings.key} LIKE 'exchange:loss:%'`,
        ),
      )
      .orderBy(asc(exchangePostings.created_at))
      .all()
      .map((r) => ({
        key: r.key,
        person: r.person_id,
        entries: JSON.parse(r.entries) as ExchangeEntry[],
        ref: r.ref,
      }));
  }

  /** A loss posting the wallet could not cover in full: it is replaced by what it could. */
  replaceLoss(
    key: string,
    entries: ExchangeEntry[] | null,
    now: number,
    writeOff: { person: string; amount: number; day: number } | null,
  ): void {
    this.#write(() => {
      if (entries === null)
        this.#db.orm
          .update(exchangePostings)
          .set({ status: "short", posted_at: ts(now) })
          .where(eq(exchangePostings.key, key))
          .run();
      else
        this.#db.orm
          .update(exchangePostings)
          .set({ entries: JSON.stringify(entries) })
          .where(eq(exchangePostings.key, key))
          .run();
      if (writeOff && writeOff.amount > 0) {
        this.#db.orm
          .insert(exchangeHouseLines)
          .values({
            day: writeOff.day,
            kind: "writeoff",
            person_id: writeOff.person,
            code: "-",
            amount: writeOff.amount,
            ref: key,
            at: ts(now),
          })
          .run();
      }
    });
  }

  // ---- reading -------------------------------------------------------------------------------

  openPositions(person?: PersonId): RealPosition[] {
    this.#db.ensureOpen();
    const where = [eq(exchangeRealPositions.status, "open")];
    if (person !== undefined) where.push(eq(exchangeRealPositions.person_id, person));
    return this.#db.orm
      .select()
      .from(exchangeRealPositions)
      .where(and(...where))
      .orderBy(asc(exchangeRealPositions.opened_at), asc(exchangeRealPositions.id))
      .all()
      .map(positionOf);
  }

  orders(person: PersonId, options: { open?: boolean; limit?: number } = {}): RealOrderRecord[] {
    this.#db.ensureOpen();
    const where = [eq(exchangeRealOrders.person_id, person)];
    if (options.open) where.push(inArray(exchangeRealOrders.status, ["open", "charging"]));
    return this.#db.orm
      .select()
      .from(exchangeRealOrders)
      .where(and(...where))
      .orderBy(desc(exchangeRealOrders.placed_at), desc(exchangeRealOrders.id))
      .limit(options.limit ?? 200)
      .all()
      .map(orderOf);
  }

  fills(person: PersonId, limit = 30) {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeRealFills)
      .where(eq(exchangeRealFills.person_id, person))
      .orderBy(desc(exchangeRealFills.created_at), desc(exchangeRealFills.id))
      .limit(limit)
      .all();
  }

  /** Coins traded per person since `since` (orders only). */
  volumeSince(since: number): { person: PersonId; volume: number; trades: number }[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select({
        person: exchangeRealFills.person_id,
        volume: sql<number>`SUM(${exchangeRealFills.gross})`,
        trades: sql<number>`COUNT(*)`,
      })
      .from(exchangeRealFills)
      .where(and(gte(exchangeRealFills.created_at, ts(since)), eq(exchangeRealFills.kind, "order")))
      .groupBy(exchangeRealFills.person_id)
      .all()
      .map((r) => ({ person: r.person, volume: Number(r.volume), trades: Number(r.trades) }));
  }

  /** What each person won or lost on real sales since `since` (paid and queued, less their buys). */
  resultsSince(since: number): { person: PersonId; result: number }[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select({
        person: exchangeRealFills.person_id,
        result: sql<number>`SUM(CASE WHEN ${exchangeRealFills.side} = 'sell' THEN ${exchangeRealFills.paid} - ${exchangeRealFills.shortfall} ELSE -(${exchangeRealFills.gross} / ${exchangeRealFills.leverage}) - ${exchangeRealFills.fee} END)`,
      })
      .from(exchangeRealFills)
      .where(gte(exchangeRealFills.created_at, ts(since)))
      .groupBy(exchangeRealFills.person_id)
      .all()
      .map((r) => ({ person: r.person, result: Math.round(Number(r.result)) }));
  }

  countedToday(person: PersonId, since: number): { orders: number; bought: number } {
    this.#db.ensureOpen();
    const rows = this.#db.orm
      .select({
        side: exchangeRealOrders.side,
        coins: exchangeRealOrders.coins,
        status: exchangeRealOrders.status,
      })
      .from(exchangeRealOrders)
      .where(
        and(
          eq(exchangeRealOrders.person_id, person),
          gte(exchangeRealOrders.placed_at, ts(since)),
          ne(exchangeRealOrders.status, "void"),
        ),
      )
      .all();
    return {
      orders: rows.length,
      bought: rows
        .filter((r) => r.side === "buy" && ["open", "filled", "charging"].includes(r.status))
        .reduce((t, r) => t + r.coins, 0),
    };
  }

  quotes(): Map<string, Quote & { refused: number; last_refusal: string | null }> {
    this.#db.ensureOpen();
    return new Map(
      this.#db.orm
        .select()
        .from(exchangeQuotes)
        .all()
        .map((r) => [
          r.code,
          {
            code: r.code,
            price: r.price,
            at: Date.parse(r.at),
            prev_close: r.prev_close,
            refused: r.refused,
            last_refusal: r.last_refusal,
          },
        ]),
    );
  }

  saveQuote(q: Quote, now: number): void {
    this.#write(() => {
      this.#db.orm
        .insert(exchangeQuotes)
        .values({
          code: q.code,
          price: q.price,
          at: ts(q.at),
          prev_close: q.prev_close,
          refused: 0,
          updated_at: ts(now),
        })
        .onConflictDoUpdate({
          target: exchangeQuotes.code,
          set: {
            price: q.price,
            at: ts(q.at),
            prev_close: q.prev_close,
            refused: 0,
            last_refusal: null,
            updated_at: ts(now),
          },
        })
        .run();
    });
  }

  refuseQuote(code: string, why: string, now: number): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangeQuotes)
        .set({
          refused: sql`${exchangeQuotes.refused} + 1`,
          last_refusal: why,
          updated_at: ts(now),
        })
        .where(eq(exchangeQuotes.code, code))
        .run();
    });
  }

  // ---- what is kept under a code ------------------------------------------------------------

  /**
   * How many rows are kept under `code`: orders, holdings, fills, quotes and their history, the
   * house's lines, watch marks, and the old local market's orders, positions and fills. Its
   * instrument row is not counted.
   */
  rowsUnder(code: string): number {
    this.#db.ensureOpen();
    const n = (table: SQLiteTable, column: SQLiteColumn) => this.#count(table, column, code);
    return (
      n(exchangeRealOrders, exchangeRealOrders.code) +
      n(exchangeRealPositions, exchangeRealPositions.code) +
      n(exchangeRealFills, exchangeRealFills.code) +
      n(exchangeQuotes, exchangeQuotes.code) +
      n(exchangeQuoteTicks, exchangeQuoteTicks.code) +
      n(exchangeHouseLines, exchangeHouseLines.code) +
      n(exchangeMarks, exchangeMarks.code) +
      n(exchangeOrders, exchangeOrders.company) +
      n(exchangePositions, exchangePositions.company) +
      n(exchangeFills, exchangeFills.company)
    );
  }

  #count(table: SQLiteTable, column: SQLiteColumn, code: string): number {
    const r = this.#db.orm
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(eq(column, code))
      .get();
    return Number(r?.n ?? 0);
  }

  // ---- the instruments people looked up ----------------------------------------------------

  instrument(code: string): InstrumentRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select()
      .from(exchangeInstruments)
      .where(eq(exchangeInstruments.code, code))
      .get();
    return r ? instrumentOf(r) : null;
  }

  instrumentList(): InstrumentRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeInstruments)
      .orderBy(asc(exchangeInstruments.code))
      .all()
      .map(instrumentOf);
  }

  addInstrument(
    i: Omit<
      InstrumentRecord,
      "missing_days" | "last_quote_at" | "last_viewed_at" | "reason" | "name_override" | "close"
    >,
    now: number,
  ): InstrumentRecord {
    this.#write(() => {
      this.#db.orm
        .insert(exchangeInstruments)
        .values({
          code: i.code,
          market: i.market,
          name: i.name,
          exchange: i.exchange,
          type: i.type,
          currency: i.currency,
          provider: i.provider,
          status: i.status,
          added_at: ts(i.added_at),
          added_by: i.added_by,
          updated_at: ts(now),
        })
        .onConflictDoNothing()
        .run();
    });
    return this.instrument(i.code) as InstrumentRecord;
  }

  setInstrument(
    code: string,
    patch: {
      status?: InstrumentRecord["status"];
      reason?: string | null;
      missing_days?: number;
      last_quote_at?: number;
      last_viewed_at?: number;
      /** The provider's name (the full one; display trims nothing). */
      name?: string;
      name_override?: string | null;
      close?: { price: number; prev_close: number | null; at: number };
    },
    now: number,
  ): void {
    const set: Record<string, unknown> = { updated_at: ts(now) };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.name_override !== undefined) set.name_override = patch.name_override;
    if (patch.close !== undefined) {
      set.close_price = patch.close.price;
      set.close_prev = patch.close.prev_close;
      set.close_at = ts(patch.close.at);
    }
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.reason !== undefined) set.reason = patch.reason;
    if (patch.missing_days !== undefined) set.missing_days = patch.missing_days;
    if (patch.last_quote_at !== undefined) set.last_quote_at = ts(patch.last_quote_at);
    if (patch.last_viewed_at !== undefined) set.last_viewed_at = ts(patch.last_viewed_at);
    this.#write(() => {
      this.#db.orm
        .update(exchangeInstruments)
        .set(set)
        .where(eq(exchangeInstruments.code, code))
        .run();
    });
  }

  /** A confirmed split or reverse split: every open position and waiting sale of `code` gets `ratio` times the shares. */
  adjustShares(code: string, ratio: number): number {
    return this.#write(() => {
      const n = Number(
        this.#db.orm
          .update(exchangeRealPositions)
          .set({ qty: sql`CAST(${exchangeRealPositions.qty} * ${ratio} AS INTEGER)` })
          .where(
            and(eq(exchangeRealPositions.code, code), eq(exchangeRealPositions.status, "open")),
          )
          .run().changes,
      );
      this.#db.orm
        .update(exchangeRealOrders)
        .set({ qty: sql`CAST(${exchangeRealOrders.qty} * ${ratio} AS INTEGER)` })
        .where(
          and(
            eq(exchangeRealOrders.code, code),
            eq(exchangeRealOrders.status, "open"),
            eq(exchangeRealOrders.side, "sell"),
          ),
        )
        .run();
      this.#db.orm.delete(exchangeQuotes).where(eq(exchangeQuotes.code, code)).run();
      return n;
    });
  }

  /** A chart point, at most one per `every` ms per instrument. */
  tick(code: string, at: number, price: number, every: number): void {
    this.#db.ensureOpen();
    const last = this.#db.orm
      .select({ at: exchangeQuoteTicks.at })
      .from(exchangeQuoteTicks)
      .where(eq(exchangeQuoteTicks.code, code))
      .orderBy(desc(exchangeQuoteTicks.at))
      .limit(1)
      .get();
    if (last && at - Date.parse(last.at) < every) return;
    this.#write(() => {
      this.#db.orm
        .insert(exchangeQuoteTicks)
        .values({ code, at: ts(at), price })
        .onConflictDoNothing()
        .run();
    });
  }

  ticks(code: string, since: number): { at: number; price: number }[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeQuoteTicks)
      .where(and(eq(exchangeQuoteTicks.code, code), gte(exchangeQuoteTicks.at, ts(since))))
      .orderBy(asc(exchangeQuoteTicks.at))
      .all()
      .map((r) => ({ at: Date.parse(r.at), price: r.price }));
  }

  // ---- the local stocks' ticks and days ------------------------------------------------------

  /** A local stock's new ticks, kept together (one day's at most: what one step worked out). */
  recordTicks(code: string, ticks: readonly { at: number; price: number }[]): void {
    if (ticks.length === 0) return;
    this.#write(() => {
      for (const t of ticks)
        this.#db.orm
          .insert(exchangeQuoteTicks)
          .values({ code, at: ts(t.at), price: t.price })
          .onConflictDoNothing()
          .run();
    });
  }

  /**
   * A local stock's day as one bar, merged with what is kept of that day already (a day caught up
   * after a downtime may have its morning in ticks and its evening here).
   */
  recordDay(code: string, bar: LocalDayBar): void {
    this.#write(() => this.#mergeDay(code, bar));
  }

  #mergeDay(code: string, bar: LocalDayBar): void {
    const orm = this.#db.orm;
    const old = orm
      .select()
      .from(exchangeLocalDays)
      .where(and(eq(exchangeLocalDays.code, code), eq(exchangeLocalDays.day, bar.day)))
      .get();
    const kept = old ? dayOf(old) : null;
    const b = kept ? mergeBars(kept, bar) : bar;
    const values = {
      code,
      day: b.day,
      first_at: ts(b.first_at),
      last_at: ts(b.last_at),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ref: b.ref,
      ticks: b.ticks,
    };
    orm
      .insert(exchangeLocalDays)
      .values(values)
      .onConflictDoUpdate({ target: [exchangeLocalDays.code, exchangeLocalDays.day], set: values })
      .run();
  }

  /** A local stock's day bars from Taipei day `sinceDay` on, oldest first. */
  localDays(code: string, sinceDay: number): LocalDayBar[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeLocalDays)
      .where(and(eq(exchangeLocalDays.code, code), gte(exchangeLocalDays.day, sinceDay)))
      .orderBy(asc(exchangeLocalDays.day))
      .all()
      .map(dayOf);
  }

  /** The last price of `code` kept before `ms` (a tick, or a day's close), `null`: none. */
  #closeBefore(code: string, ms: number): number | null {
    const orm = this.#db.orm;
    const tick = orm
      .select()
      .from(exchangeQuoteTicks)
      .where(and(eq(exchangeQuoteTicks.code, code), lt(exchangeQuoteTicks.at, ts(ms))))
      .orderBy(desc(exchangeQuoteTicks.at))
      .limit(1)
      .get();
    const day = orm
      .select()
      .from(exchangeLocalDays)
      .where(and(eq(exchangeLocalDays.code, code), lt(exchangeLocalDays.last_at, ts(ms))))
      .orderBy(desc(exchangeLocalDays.day))
      .limit(1)
      .get();
    if (day && (!tick || Date.parse(day.last_at) > Date.parse(tick.at))) return day.close;
    return tick ? tick.price : null;
  }

  /**
   * Where a local stock's walk goes on from: its last kept tick (a tick row, or the last of a day
   * bar) and the price its day's band is measured from (the day before's last); `null`: never
   * priced. An install from before the per-minute ticks continues from its last hourly tick.
   */
  localResume(code: string): { price: number; at: number; prev_close: number | null } | null {
    this.#db.ensureOpen();
    const orm = this.#db.orm;
    const tick = orm
      .select()
      .from(exchangeQuoteTicks)
      .where(eq(exchangeQuoteTicks.code, code))
      .orderBy(desc(exchangeQuoteTicks.at))
      .limit(1)
      .get();
    const day = orm
      .select()
      .from(exchangeLocalDays)
      .where(eq(exchangeLocalDays.code, code))
      .orderBy(desc(exchangeLocalDays.day))
      .limit(1)
      .get();
    if (day && (!tick || Date.parse(day.last_at) > Date.parse(tick.at)))
      return { price: day.close, at: Date.parse(day.last_at), prev_close: day.ref };
    if (!tick) return null;
    const at = Date.parse(tick.at);
    const before = this.#closeBefore(code, taipeiDayWindow(taipeiDay(at)).start);
    if (before !== null) return { price: tick.price, at, prev_close: before };
    // Only today's ticks (a new instance's first day): the reference the quote was kept with.
    const quote = this.quotes().get(code);
    return { price: tick.price, at, prev_close: quote?.at === at ? quote.prev_close : null };
  }

  /**
   * Rolls a local stock's ticks before `before` into day bars, the oldest `maxDays` days at most,
   * each day in one transaction (its bar written, its ticks gone). Returns the days rolled.
   */
  rollupLocal(code: string, before: number, maxDays: number): number {
    this.#db.ensureOpen();
    const rows = this.#db.orm
      .select()
      .from(exchangeQuoteTicks)
      .where(and(eq(exchangeQuoteTicks.code, code), lt(exchangeQuoteTicks.at, ts(before))))
      .orderBy(asc(exchangeQuoteTicks.at))
      .all()
      .map((r) => ({ at: Date.parse(r.at), price: r.price }));
    const byDay = new Map<number, { at: number; price: number }[]>();
    for (const r of rows) {
      const d = taipeiDay(r.at);
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
    }
    let rolled = 0;
    for (const [day, points] of [...byDay].sort((a, b) => a[0] - b[0])) {
      if (rolled >= maxDays) break;
      const first = points[0];
      const last = points.at(-1);
      if (!first || !last) continue;
      const { start, end } = taipeiDayWindow(day);
      this.#write(() => {
        const ref = this.#closeBefore(code, start) ?? first.price;
        this.#mergeDay(code, {
          day,
          first_at: first.at,
          last_at: last.at,
          open: first.price,
          high: Math.max(...points.map((p) => p.price)),
          low: Math.min(...points.map((p) => p.price)),
          close: last.price,
          ref,
          ticks: points.length,
        });
        this.#db.orm
          .delete(exchangeQuoteTicks)
          .where(
            and(
              eq(exchangeQuoteTicks.code, code),
              gte(exchangeQuoteTicks.at, ts(start)),
              lt(exchangeQuoteTicks.at, ts(end)),
            ),
          )
          .run();
      });
      rolled++;
    }
    return rolled;
  }

  /** The house's lines of a step written on their own (a buy's charge, once it went through). */
  lines(lines: readonly HouseLine[], day: number, now: number): void {
    this.#write(() => {
      for (const l of lines) {
        this.#db.orm
          .insert(exchangeHouseLines)
          .values({
            day,
            kind: l.kind,
            person_id: l.person,
            code: l.code,
            amount: l.amount,
            ref: l.ref,
            at: ts(now),
          })
          .run();
      }
    });
  }

  /** The house's lines summed by kind, from local day `from` on: the books' other side. */
  lineTotals(from = 0): Record<string, number> {
    this.#db.ensureOpen();
    const rows = this.#db.orm
      .select({ kind: exchangeHouseLines.kind, n: sql<number>`SUM(${exchangeHouseLines.amount})` })
      .from(exchangeHouseLines)
      .where(gte(exchangeHouseLines.day, from))
      .groupBy(exchangeHouseLines.kind)
      .all();
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  }

  merge(keep: PersonId, absorb: PersonId): Record<string, number> {
    if (keep === absorb) return {};
    return this.#write(() => {
      const orm = this.#db.orm;
      const orders = Number(
        orm
          .update(exchangeRealOrders)
          .set({ person_id: keep, request_key: sql`'merged:' || ${exchangeRealOrders.id}` })
          .where(eq(exchangeRealOrders.person_id, absorb))
          .run().changes,
      );
      const positions = Number(
        orm
          .update(exchangeRealPositions)
          .set({ person_id: keep })
          .where(eq(exchangeRealPositions.person_id, absorb))
          .run().changes,
      );
      const fills = Number(
        orm
          .update(exchangeRealFills)
          .set({ person_id: keep })
          .where(eq(exchangeRealFills.person_id, absorb))
          .run().changes,
      );
      // Marks: the kept person's win where both have one.
      for (const m of orm
        .select()
        .from(exchangeMarks)
        .where(eq(exchangeMarks.person_id, absorb))
        .all())
        orm
          .insert(exchangeMarks)
          .values({ ...m, person_id: keep })
          .onConflictDoNothing()
          .run();
      const marks = Number(
        orm.delete(exchangeMarks).where(eq(exchangeMarks.person_id, absorb)).run().changes,
      );
      // Bankruptcy follows the person kept: the longer cooling-off wins.
      const state = this.state();
      if (state) {
        const a = state.bankrupt[absorb];
        const k = state.bankrupt[keep];
        if (a && (!k || a.until > k.until)) state.bankrupt[keep] = a;
        delete state.bankrupt[absorb];
        orm
          .update(exchangeHouse)
          .set({ state: JSON.stringify(state) })
          .where(eq(exchangeHouse.id, 1))
          .run();
      }
      return {
        exchange_real_orders: orders,
        exchange_real_positions: positions,
        exchange_real_fills: fills,
        exchange_marks: marks,
      };
    });
  }

  // ---- a member's marks: the watch list and what they viewed --------------------------------

  /** Sets (or refreshes) a mark. */
  mark(person: PersonId, kind: MarkKind, code: string, at: number): void {
    this.#write(() =>
      this.#db.orm
        .insert(exchangeMarks)
        .values({ person_id: person, kind, code, at: toTimestamp(at) })
        .onConflictDoUpdate({
          target: [exchangeMarks.person_id, exchangeMarks.kind, exchangeMarks.code],
          set: { at: toTimestamp(at) },
        })
        .run(),
    );
  }

  /** Removes a mark; whether there was one. */
  unmark(person: PersonId, kind: MarkKind, code: string): boolean {
    return this.#write(
      () =>
        Number(
          this.#db.orm
            .delete(exchangeMarks)
            .where(
              and(
                eq(exchangeMarks.person_id, person),
                eq(exchangeMarks.kind, kind),
                eq(exchangeMarks.code, code),
              ),
            )
            .run().changes,
        ) > 0,
    );
  }

  /** A person's marks of a kind, newest first. */
  marks(person: PersonId, kind: MarkKind, limit = 50): { code: string; at: number }[] {
    return this.#db.orm
      .select({ code: exchangeMarks.code, at: exchangeMarks.at })
      .from(exchangeMarks)
      .where(and(eq(exchangeMarks.person_id, person), eq(exchangeMarks.kind, kind)))
      .orderBy(desc(exchangeMarks.at))
      .limit(limit)
      .all()
      .map((m) => ({ code: m.code, at: Date.parse(m.at) }));
  }

  /** Keeps a person's newest `keep` marks of a kind and drops the rest. */
  trimMarks(person: PersonId, kind: MarkKind, keep: number): void {
    const old = this.marks(person, kind, 1000).slice(keep);
    if (old.length === 0) return;
    this.#write(() =>
      this.#db.orm
        .delete(exchangeMarks)
        .where(
          and(
            eq(exchangeMarks.person_id, person),
            eq(exchangeMarks.kind, kind),
            inArray(
              exchangeMarks.code,
              old.map((m) => m.code),
            ),
          ),
        )
        .run(),
    );
  }

  /**
   * The codes on the watch lists of people who viewed anything since `activeSince` (a forgotten
   * watch list is not polled).
   */
  watchedByActive(activeSince: number): Set<string> {
    const active = new Set(
      this.#db.orm
        .selectDistinct({ person: exchangeMarks.person_id })
        .from(exchangeMarks)
        .where(and(eq(exchangeMarks.kind, "view"), gte(exchangeMarks.at, toTimestamp(activeSince))))
        .all()
        .map((r) => r.person),
    );
    if (active.size === 0) return new Set();
    return new Set(
      this.#db.orm
        .select({ code: exchangeMarks.code })
        .from(exchangeMarks)
        .where(and(eq(exchangeMarks.kind, "watch"), inArray(exchangeMarks.person_id, [...active])))
        .all()
        .map((r) => r.code),
    );
  }

  /** Codes viewed by anyone since `since` (today's movers look only at these and what is held). */
  viewedSince(since: number): Set<string> {
    return new Set(
      this.#db.orm
        .selectDistinct({ code: exchangeMarks.code })
        .from(exchangeMarks)
        .where(and(eq(exchangeMarks.kind, "view"), gte(exchangeMarks.at, toTimestamp(since))))
        .all()
        .map((r) => r.code),
    );
  }
}

export type MarkKind = "watch" | "view";

function strip(o: RealOrderRecord): RealOrder {
  return {
    id: o.id,
    person: o.person,
    code: o.code,
    side: o.side,
    limit: o.limit,
    coins: o.coins,
    margin: o.margin,
    exposure: o.exposure,
    fee: o.fee,
    leverage: o.leverage,
    qty: o.qty,
    position: o.position,
    placed_at: o.placed_at,
    expires_at: o.expires_at,
  };
}

export type InstrumentStatus = "active" | "blocked" | "paused" | "suspended" | "removed";

export interface InstrumentRecord {
  code: string;
  market: "tw" | "us" | "crypto" | "local";
  name: string;
  exchange: string;
  type: string;
  currency: string;
  provider: string;
  status: InstrumentStatus;
  reason: string | null;
  added_at: number;
  added_by: string | null;
  last_quote_at: number | null;
  missing_days: number;
  last_viewed_at: number | null;
  /** The owner's display name (`null`: none set). */
  name_override: string | null;
  /** The provider's last price outside a session (shown, never traded at). */
  close: { price: number; prev_close: number | null; at: number } | null;
}

function instrumentOf(r: typeof exchangeInstruments.$inferSelect): InstrumentRecord {
  return {
    code: r.code,
    market: r.market as InstrumentRecord["market"],
    name: r.name,
    exchange: r.exchange,
    type: r.type,
    currency: r.currency,
    provider: r.provider,
    status: r.status as InstrumentStatus,
    reason: r.reason,
    added_at: Date.parse(r.added_at),
    added_by: r.added_by,
    last_quote_at: ms(r.last_quote_at),
    missing_days: r.missing_days,
    last_viewed_at: ms(r.last_viewed_at),
    name_override: r.name_override,
    close:
      r.close_price !== null && r.close_at !== null
        ? { price: r.close_price, prev_close: r.close_prev, at: Date.parse(r.close_at) }
        : null,
  };
}
