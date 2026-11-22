// The five local stocks: one tick an hour 12:00–23:00 Taipei, reproducible from the seed, a hard
// ±10% daily limit, her real things moving a price at most ±3% a day as a gap at the next day's first
// tick (lagged: never a count a member can still change and trade on at a known price), and the
// offline checks with the real signal (`readSignal`, the config's mapping): feeding her as much as
// the caps allow, buying RICE before the day ends and selling after the next open loses money once
// the feedings and the fee are counted; causing model errors and buying DPSK's dip never pays.

import { describe, expect, it } from "vitest";
import { exchangeConfig, localCompaniesOf } from "../src/config.js";
import { feeOn } from "../src/engine/money.js";
import { rngFor } from "../src/engine/rng.js";
import {
  type Cadence,
  cadenceOf,
  DAILY_LIMIT,
  HARD_BAND,
  HOURLY,
  HOURLY_STEPS,
  type LocalCompany,
  LocalProvider,
  type LocalRole,
  type LocalState,
  lastTick,
  nextPrice,
  nextTickAfter,
  SIGNAL_MAX,
  signalMove,
  TEMPER,
} from "../src/real/local.js";
import { mappingOf, readSignal } from "../src/real/signals.js";

const HOUR = 3_600_000;
/** Monday 2026-11-23 12:00 Taipei. */
const NOON = Date.UTC(2026, 10, 23, 4, 0);
/** The five as the default config names them (codes, names, anchors). */
const COMPANIES = localCompaniesOf(exchangeConfig());
const stock = (code: string): LocalCompany => {
  const c = COMPANIES.find((x) => x.code === code);
  if (!c) throw new Error(code);
  return c;
};
const RICE = stock("RICE");
const DPSK = stock("DPSK");

describe("the local stocks", () => {
  it("tick every minute by default from 12:00 to 23:00 Taipei and skip the night", () => {
    const MIN = 60_000;
    expect(cadenceOf(60).perDay).toBe(661);
    expect(lastTick(NOON + 30 * MIN)).toBe(NOON + 30 * MIN);
    expect(lastTick(NOON + 30 * MIN + 30_000)).toBe(NOON + 30 * MIN);
    expect(lastTick(NOON - HOUR)).toBeNull();
    expect(lastTick(NOON + 11 * HOUR)).toBe(NOON + 11 * HOUR);
    expect(lastTick(NOON + 11 * HOUR + 30_000)).toBe(NOON + 11 * HOUR);
    expect(lastTick(NOON + 11 * HOUR + 2 * MIN)).toBeNull();
    expect(nextTickAfter(NOON)).toBe(NOON + MIN);
    expect(nextTickAfter(NOON + 11 * HOUR)).toBe(NOON + 24 * HOUR);
  });

  it("tick hourly from 12:00 to 23:00 Taipei with local_tick_seconds = 3600 (the cadence before)", () => {
    expect(HOURLY.perDay).toBe(12);
    expect(HOURLY.temper).toBe(TEMPER);
    expect(lastTick(NOON + 30 * 60_000, 3600)).toBe(NOON);
    expect(lastTick(NOON - HOUR, 3600)).toBeNull();
    expect(lastTick(NOON + 11 * HOUR, 3600)).toBe(NOON + 11 * HOUR);
    expect(nextTickAfter(NOON, 3600)).toBe(NOON + HOUR);
    expect(nextTickAfter(NOON + 11 * HOUR, 3600)).toBe(NOON + 24 * HOUR);
  });

  it("are the same from the same seed and stay within the daily limit", async () => {
    const run = async (seed: string) => {
      const p = new LocalProvider(
        seed,
        () => null,
        () => COMPANIES,
        () => null,
      );
      const out: number[] = [];
      for (let h = 0; h < 24 * 20; h++)
        out.push((await p.quotes(["DPSK"], NOON + h * HOUR)).get("DPSK")?.price ?? 0);
      return out;
    };
    const a = await run("s");
    expect(a).toEqual(await run("s"));
    expect(a).not.toEqual(await run("t"));
    let close = 0;
    let last = 0;
    let prevDay = -1;
    for (let h = 0; h < a.length; h++) {
      const tick = lastTick(NOON + h * HOUR);
      if (tick === null) continue;
      const day = Math.floor((tick + 8 * HOUR) / 86_400_000);
      const price = a[h] as number;
      if (day !== prevDay) close = last;
      if (close > 0) expect(Math.abs(price / close - 1)).toBeLessThanOrEqual(DAILY_LIMIT + 1e-6);
      last = price;
      prevDay = day;
    }
  });

  it("move by yesterday's count at most ±3%, at the day's first tick only", () => {
    expect(signalMove({ signal: 1 })).toBe(SIGNAL_MAX);
    expect(signalMove({ signal: -1 })).toBe(-SIGNAL_MAX);
    // Held at ±3% whatever the signal says.
    expect(signalMove({ signal: 7 })).toBe(SIGNAL_MAX);
    expect(signalMove({ signal: Number.NaN })).toBe(0);
    expect(signalMove(null)).toBe(0);
    const seen: number[] = [];
    const signals = (_c: string, day: number) => {
      seen.push(day);
      return { signal: 1 };
    };
    const st = { price: 100, at: NOON - 13 * HOUR, close: 100 };
    const open = nextPrice("s", RICE, NOON, st, signals, 100);
    // The signal read is the day before the tick's.
    expect(seen).toEqual([Math.floor((NOON + 8 * HOUR) / 86_400_000) - 1]);
    expect(nextPrice("s", RICE, NOON + HOUR, open, signals, 100)).toBeDefined();
    expect(seen).toHaveLength(1);
  });

  it("stay within 0.5×–2× of their anchor over simulated years, even pushed one way every day", () => {
    // Ten seeds, a year each (365 × 12 ticks). The signal pushes the full +3% (or −3%) every day: the
    // worst a crowd could do. The range is printed for the report.
    const out: string[] = [];
    for (const company of COMPANIES) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = 0;
      for (const push of [0, 1, -1]) {
        for (let seed = 0; seed < 10; seed++) {
          const a = company.anchor;
          let st: LocalState = { price: a, at: NOON - 13 * HOUR, close: a };
          const signals = () => (push === 0 ? null : { signal: push });
          for (let d = 0; d < 365; d++)
            for (let h = 0; h < 12; h++) {
              st = nextPrice(`y${seed}`, company, NOON + d * 24 * HOUR + h * HOUR, st, signals, a);
              lo = Math.min(lo, st.price / a);
              hi = Math.max(hi, st.price / a);
            }
        }
      }
      expect(lo).toBeGreaterThanOrEqual(HARD_BAND.lo);
      expect(hi).toBeLessThanOrEqual(HARD_BAND.hi);
      out.push(`${company.code} ${company.anchor}: ${lo.toFixed(2)}×–${hi.toFixed(2)}×`);
    }
    process.stdout.write(`local year range: ${out.join("; ")}\n`);
  }, 60_000);

  // ---- a tick every minute: the same day as the hourly model ------------------------------------

  /**
   * `seeds` × `days` of `company` from its anchor in cadence `c`, the signal pushing `push` every
   * day: each day's close-to-close log return, the closes over the anchor, and the worst breach of
   * the day's ±10% (from the reference) or the hard band seen at any tick (≤ 0: never).
   */
  const simulate = (
    company: LocalCompany,
    c: Cadence,
    seeds: number,
    days: number,
    push: number,
  ) => {
    const a = company.anchor;
    const returns: number[] = [];
    const levels: number[] = [];
    let breach = Number.NEGATIVE_INFINITY;
    const signals = () => (push === 0 ? null : { signal: push });
    for (let seed = 0; seed < seeds; seed++) {
      let st: LocalState = { price: a, at: NOON - 13 * HOUR, close: a };
      let close = a;
      for (let d = 0; d < days; d++) {
        for (let k = 0; k < c.perDay; k++) {
          st = nextPrice(`eq${seed}`, company, NOON + d * DAY_MS + k * c.tickMs, st, signals, a, c);
          // Over the band by more than the cent the price is rounded to.
          breach = Math.max(
            breach,
            st.price - st.close * (1 + DAILY_LIMIT) - 0.005,
            st.close * (1 - DAILY_LIMIT) - st.price - 0.005,
            st.price - a * HARD_BAND.hi - 0.005,
            a * HARD_BAND.lo - st.price - 0.005,
          );
        }
        returns.push(Math.log(st.price / close));
        close = st.price;
      }
      levels.push(Math.log(st.price / a));
    }
    return { returns, levels, breach };
  };
  const mean = (x: readonly number[]) => x.reduce((t, v) => t + v, 0) / x.length;
  const sd = (x: readonly number[]) => {
    const m = mean(x);
    return Math.sqrt(x.reduce((t, v) => t + (v - m) ** 2, 0) / (x.length - 1));
  };
  /** The two-sample Kolmogorov–Smirnov distance. */
  const ks = (x: readonly number[], y: readonly number[]) => {
    const a = [...x].sort((p, q) => p - q);
    const b = [...y].sort((p, q) => p - q);
    let i = 0;
    let j = 0;
    let d = 0;
    while (i < a.length && j < b.length) {
      const v = Math.min(a[i] as number, b[j] as number);
      while (i < a.length && (a[i] as number) <= v) i++;
      while (j < b.length && (b[j] as number) <= v) j++;
      d = Math.max(d, Math.abs(i / a.length - j / b.length));
    }
    return d;
  };

  it("give a day the same distribution with a tick every minute as with the hourly model, inside the band", () => {
    // 150 seeds × 20 days per company and push, with seeded generators (the minute series draws
    // its own numbers: the two are compared as distributions, not tick for tick).
    const minute = cadenceOf(60);
    const rows: string[] = [];
    for (const company of [RICE, DPSK, stock("CUBE")]) {
      for (const push of [0, 1]) {
        const h = simulate(company, HOURLY, 150, 20, push);
        const m = simulate(company, minute, 150, 20, push);
        // Never past the ±10% of the day nor the hard band, at any tick.
        expect(h.breach).toBeLessThanOrEqual(0);
        expect(m.breach).toBeLessThanOrEqual(0);
        // A day's move: the same spread (within 8%), the same centre, the same shape.
        const ratio = sd(m.returns) / sd(h.returns);
        expect(ratio).toBeGreaterThan(0.92);
        expect(ratio).toBeLessThan(1.08);
        const se = Math.sqrt(
          sd(h.returns) ** 2 / h.returns.length + sd(m.returns) ** 2 / m.returns.length,
        );
        expect(Math.abs(mean(m.returns) - mean(h.returns))).toBeLessThan(4 * se);
        const dist = ks(h.returns, m.returns);
        expect(dist).toBeLessThan(0.06);
        // Where twenty days take it from the anchor: the same spread too.
        const level = sd(m.levels) / sd(h.levels);
        expect(level).toBeGreaterThan(0.8);
        expect(level).toBeLessThan(1.25);
        rows.push(
          `${company.code} push ${push}: day sd hourly ${(sd(h.returns) * 100).toFixed(3)}% minute ${(sd(m.returns) * 100).toFixed(3)}% (×${ratio.toFixed(3)}), mean ${(mean(h.returns) * 100).toFixed(3)}% / ${(mean(m.returns) * 100).toFixed(3)}%, KS ${dist.toFixed(3)}, 20-day level sd ×${level.toFixed(3)}`,
        );
      }
    }
    process.stdout.write(`minute vs hourly:\n  ${rows.join("\n  ")}\n`);
  }, 120_000);

  it("scale each step so the day's variance and pull are the hourly model's, and are the hourly numbers at 3600 s", () => {
    for (const role of ["feeding", "model"] as const) {
      const h = TEMPER[role];
      for (const s of [60, 10, 600, 1800]) {
        const c = cadenceOf(s);
        const t = c.temper[role];
        // The pull of a day compounds to the hourly model's.
        expect((1 - t.reversion) ** c.perDay).toBeCloseTo((1 - h.reversion) ** HOURLY_STEPS, 12);
        // The walk's variance over a day is the hourly model's.
        const dayVar = (sig: number, r: number, n: number) =>
          (sig * sig * (1 - (1 - r) ** (2 * n))) / (1 - (1 - r) ** 2);
        expect(dayVar(t.sigma, t.reversion, c.perDay)).toBeCloseTo(
          dayVar(h.sigma, h.reversion, HOURLY_STEPS),
          12,
        );
      }
    }
    expect(cadenceOf(3600)).toBe(HOURLY);
    expect(HOURLY.temper).toBe(TEMPER);
  });

  // ---- anti-gaming, with the real signal ------------------------------------------------------

  // The economy's defaults ([modules.economy], packages/economy/src/config.ts and gift-config.ts):
  // what feeding costs and how much of her hunger one person may take a day. A feed goes through
  // while the person's share left is above zero (the economy's loop), so the last one may overshoot.
  const FEED_CAP = 0.85;
  const FOOD = {
    rice: { coins: 10, hunger: 0.15 },
    dessert: { coins: 25, hunger: 0.05 },
    // A free-form food gift at the cheapest price there is (`min_coins`), at most `per_day` (3).
    candy: { coins: 1, hunger: (0.5 * 1) / (1 + 100) },
  } as const;
  const GIFTS_PER_DAY = 3;

  /** One person's day of feeding: three candies, then `filler` until their share is gone. */
  const plan = (filler: "rice" | "dessert") => {
    let left = FEED_CAP;
    let feeds = 0;
    let coins = 0;
    for (let g = 0; g < GIFTS_PER_DAY && left > 1e-9; g++) {
      left -= FOOD.candy.hunger;
      feeds += 1;
      coins += FOOD.candy.coins;
    }
    while (left > 1e-9) {
      left -= FOOD[filler].hunger;
      feeds += 1;
      coins += FOOD[filler].coins;
    }
    return { feeds, coins };
  };
  /** The most feedings the caps allow one person, and the cheapest feedings per coin. */
  const MOST = plan("dessert");
  const CHEAPEST = plan("rice");

  // The caps are off by default now (owner 2026-11-21); these runs use the stake the table in
  // docs/design/exchange.md §9 was measured at, the old caps turned back on: 200 an order, 300 a
  // day. The run without caps below shows what a bigger stake does.
  const config = exchangeConfig({ order_max: 200, buy_per_day: 300 });
  const DAY_MS = 24 * HOUR;
  const day0 = Math.floor((NOON + 8 * HOUR) / DAY_MS);

  /** The signal of `day` from the counts so far, as the book reads it (`readSignal`). */
  const signalOf = (role: LocalRole, counts: readonly number[], day: number) => {
    const x = counts[day - day0];
    if (x === undefined) return null;
    const from = Math.max(0, day - day0 - config.local_signals.baseline_days);
    const r = readSignal(x, counts.slice(from, day - day0), mappingOf(config, role));
    return r ? { signal: r.signal } : null;
  };

  /** Buying `coins` in orders of at most `orderMax` (0: one order) and selling each lot: the net result. */
  const flip = (coins: number, buyAt: number, sellAt: number, orderMax = config.order_max) => {
    let net = -coins;
    const most = orderMax > 0 ? orderMax : coins;
    for (let left = coins; left > 0; left -= most) {
      const lot = Math.min(left, most);
      const shares = (lot - feeOn(lot, config.fee, config.fee_min)) / buyAt;
      const gross = Math.floor(shares * sellAt);
      net += gross - feeOn(gross, config.fee, config.fee_min);
    }
    return net;
  };

  /**
   * 2000 days of RICE: everyone else feeds her about 12 times a day; on the days `pump` picks the
   * feeder adds `extra`, buys `buy_per_day` of RICE at 23:00 and sells at the next day's 12:00
   * (after the gap). The mean result per trade, the feedings' coins counted, and the mean gap.
   */
  const feedAndFlip = (
    extra: { feeds: number; coins: number },
    pump: (d: number) => boolean,
    seed: string,
    stake = { coins: config.buy_per_day, orderMax: config.order_max },
    /** The cadence (the hourly model the table was measured at, unless given). */
    cad: Cadence = HOURLY,
    days = 2000,
  ) => {
    const counts: number[] = [];
    let st: LocalState = { price: 100, at: NOON - 13 * HOUR, close: 100 };
    let total = 0;
    let gaps = 0;
    let trades = 0;
    const signals = (c: LocalRole, day: number) => signalOf(c, counts, day);
    for (let d = 0; d < days; d++) {
      const rng = rngFor("feeds", seed, d);
      const pumped = pump(d);
      counts[d] = Math.max(0, Math.round(12 + rng.normal() * 4)) + (pumped ? extra.feeds : 0);
      let p23 = st.price;
      for (let h = 0; h < cad.perDay; h++) {
        st = nextPrice(seed, RICE, NOON + d * DAY_MS + h * cad.tickMs, st, signals, 100, cad);
        if (h === cad.perDay - 1) p23 = st.price;
      }
      if (!pumped) continue;
      // The next day's first tick carries today's count (priced again in the loop: it is pure).
      const open = nextPrice(seed, RICE, NOON + (d + 1) * DAY_MS, st, signals, 100, cad);
      total += flip(stake.coins, p23, open.price, stake.orderMax) - extra.coins;
      gaps += signalMove(signals("feeding", day0 + d));
      trades++;
    }
    return { mean: total / Math.max(trades, 1), gap: gaps / Math.max(trades, 1), trades };
  };

  it("do not pay a member who feeds her as much as the caps allow, buys RICE and sells", () => {
    expect(MOST).toEqual({ feeds: 20, coins: 428 });
    expect(CHEAPEST).toEqual({ feeds: 9, coins: 63 });
    const rows: string[] = [];
    // Every day (the median catches up), every other day and once a week (the median stays low:
    // the best case for the feeder), with the most feedings and with the cheapest ones.
    const pumps: [string, (d: number) => boolean][] = [
      ["every day", () => true],
      ["every other day", (d) => d % 2 === 0],
      ["once a week", (d) => d % 7 === 0],
    ];
    for (const [name, pump] of pumps)
      for (const [label, extra] of [
        ["most", MOST],
        ["cheapest", CHEAPEST],
      ] as const) {
        const r = feedAndFlip(extra, pump, "flip");
        expect(r.mean).toBeLessThan(0);
        rows.push(
          `${name}/${label} (${extra.feeds} feeds, ${extra.coins} coins): ${r.mean.toFixed(2)} per trade over ${r.trades}, before feeding ${(r.mean + extra.coins).toFixed(2)}, mean gap ${(r.gap * 100).toFixed(2)}%`,
        );
      }
    // Somebody who feeds nothing and buys after every day the crowd fed her a lot: at best the gap
    // less a round trip's fees. Reported, not a loss by design: the crowd's feedings are what is
    // meant to lift RICE.
    const counts: number[] = [];
    let st: LocalState = { price: 100, at: NOON - 13 * HOUR, close: 100 };
    let total = 0;
    let trades = 0;
    const signals = (c: LocalRole, day: number) => signalOf(c, counts, day);
    for (let d = 0; d < 2000; d++) {
      const rng = rngFor("feeds", "rider", d);
      counts[d] = Math.max(0, Math.round(12 + rng.normal() * 4));
      let p23 = st.price;
      for (let h = 0; h < 12; h++) {
        st = nextPrice("rider", RICE, NOON + d * DAY_MS + h * HOUR, st, signals, 100);
        if (h === 11) p23 = st.price;
      }
      const s = signals("feeding", day0 + d);
      if (s === null || s.signal < 0.5) continue;
      const open = nextPrice("rider", RICE, NOON + (d + 1) * DAY_MS, st, signals, 100);
      total += flip(config.buy_per_day, p23, open.price);
      trades++;
    }
    const rider = total / Math.max(trades, 1);
    expect(rider).toBeLessThan(config.buy_per_day * (SIGNAL_MAX - 2 * config.fee) + 1);
    rows.push(
      `free rider on big days (signal >= 0.5): ${rider.toFixed(2)} per trade over ${trades}`,
    );
    process.stdout.write(`feed-and-flip:\n  ${rows.join("\n  ")}\n`);
  }, 60_000);

  it("with the caps off, only a big stake could make the RICE pump pay: what it earns per coin is at most the gap less two fees", () => {
    // No order cap, no daily cap (the defaults): one order of the whole stake. Before feeding, the
    // trade earns at most the morning's gap less a round trip's fees on every coin; the feeding's
    // cost is fixed, so the break-even stake is that cost over the per-coin edge.
    const rows: string[] = [];
    for (const [label, extra] of [
      ["most", MOST],
      ["cheapest", CHEAPEST],
    ] as const) {
      const stake = 10_000;
      const r = feedAndFlip(extra, (d) => d % 7 === 0, "flip", { coins: stake, orderMax: 0 });
      const perCoin = (r.mean + extra.coins) / stake;
      expect(perCoin).toBeLessThan(SIGNAL_MAX - 2 * config.fee + 0.001);
      const breakEven = perCoin > 0 ? Math.ceil(extra.coins / perCoin) : null;
      rows.push(
        `once a week/${label}, 10,000 staked: ${r.mean.toFixed(2)} per trade, before feeding ${(perCoin * 100).toFixed(3)}% a coin, mean gap ${(r.gap * 100).toFixed(2)}%, break-even stake ${breakEven === null ? "none" : breakEven.toLocaleString("en-US")}`,
      );
    }
    process.stdout.write(`feed-and-flip without caps:\n  ${rows.join("\n  ")}\n`);
  }, 60_000);

  it("with a tick every minute, feed-then-flip earns what it did hourly and the day after the gap has nothing more of it", () => {
    // The signal is still yesterday's whole count, landing at 12:00 as one gap: the same gap for
    // the same feedings, whatever the cadence (the same counts give the same gaps here).
    const minute = cadenceOf(60);
    const stake = { coins: 10_000, orderMax: 0 };
    const weekly = (d: number) => d % 7 === 0;
    const h = feedAndFlip(MOST, weekly, "flip", stake, HOURLY, 700);
    const m = feedAndFlip(MOST, weekly, "flip", stake, minute, 700);
    expect(m.gap).toBe(h.gap);
    const per = (r: { mean: number }) => (r.mean + MOST.coins) / stake.coins;
    expect(per(m)).toBeLessThan(SIGNAL_MAX - 2 * config.fee + 0.001);
    expect(Math.abs(per(m) - per(h))).toBeLessThan(0.005);
    // Bought right after the gap (12:01) and sold at 23:00: no drift from the signal is left in
    // the day, so knowing it at 12:00 gives no edge the hourly model did not have.
    const after: { pushed: number[]; plain: number[] } = { pushed: [], plain: [] };
    let st: LocalState = { price: 100, at: NOON - 13 * HOUR, close: 100 };
    const signals = (_r: LocalRole, day: number) => ((day - day0) % 2 === 0 ? { signal: 1 } : null);
    for (let d = 1; d <= 1000; d++) {
      let first = 0;
      for (let k = 0; k < minute.perDay; k++) {
        st = nextPrice(
          "drift",
          RICE,
          NOON + d * DAY_MS + k * minute.tickMs,
          st,
          signals,
          100,
          minute,
        );
        if (k === 1) first = st.price;
      }
      ((d - 1) % 2 === 0 ? after.pushed : after.plain).push(Math.log(st.price / first));
    }
    const avg = (x: number[]) => x.reduce((t, v) => t + v, 0) / x.length;
    expect(avg(after.pushed)).toBeLessThan(avg(after.plain) + 0.003);
    process.stdout.write(
      `minute feed-and-flip (once a week, most, 10,000): hourly ${(per(h) * 100).toFixed(3)}% a coin, minute ${(per(m) * 100).toFixed(3)}% a coin, mean gap ${(m.gap * 100).toFixed(2)}%; 12:01→23:00 after a +3% gap ${(avg(after.pushed) * 100).toFixed(3)}%, after none ${(avg(after.plain) * 100).toFixed(3)}%\n`,
    );
  }, 120_000);

  it("never let causing model errors pay: DPSK only falls, by less than a round trip's fees", () => {
    const m = mappingOf(config, "model");
    expect(m.up).toBe(0);
    expect(m.down * SIGNAL_MAX).toBeLessThan(2 * config.fee);
    // A quiet day gives nothing; a day of errors only pushes it down.
    const usual = [6, 5, 7, 6, 8, 4, 6, 5, 7, 6, 6, 5, 7, 6];
    expect(readSignal(0, usual, m)?.signal).toBe(0);
    expect(readSignal(500, usual, m)?.signal).toBeCloseTo(-m.down, 9);
    // Someone floods her model every 15th day (the baseline stays clean) and buys DPSK at the next
    // 12:00, after the gap, holding H days for the walk to bring it back. Paired with the same days
    // without the flood (same seeds, same noise): the part of the result the errors caused.
    const rows: string[] = [];
    for (const hold of [0, 1, 3, 7, 14, 30]) {
      let caused = 0;
      let flooded = 0;
      let fees = 0;
      let trades = 0;
      for (let seed = 0; seed < 12; seed++) {
        const run = (flood: boolean) => {
          const counts: number[] = [];
          const signals = (c: LocalRole, day: number) => signalOf(c, counts, day);
          let st: LocalState = { price: 94, at: NOON - 13 * HOUR, close: 94 };
          const buys = new Map<number, number>();
          const out: { pnl: number; fee: number }[] = [];
          for (let d = 0; d < 900; d++) {
            const rng = rngFor("errors", seed, d);
            counts[d] =
              Math.max(0, Math.round(6 + rng.normal() * 2)) + (flood && d % 15 === 14 ? 500 : 0);
            for (let h = 0; h < 12; h++) {
              st = nextPrice(`e${seed}`, DPSK, NOON + d * DAY_MS + h * HOUR, st, signals, 94);
              if (h === 0 && d % 15 === 0 && d > 0) buys.set(d, st.price);
              const bought = h === 11 ? buys.get(d - hold) : undefined;
              if (bought === undefined) continue;
              const pnl = flip(config.buy_per_day, bought, st.price);
              // What the trade would have made without fees, less what it made: its fees.
              out.push({
                pnl,
                fee: (config.buy_per_day * st.price) / bought - config.buy_per_day - pnl,
              });
            }
          }
          return out;
        };
        const a = run(true);
        const b = run(false);
        a.forEach((t, i) => {
          flooded += t.pnl;
          caused += t.pnl - (b[i]?.pnl ?? t.pnl);
          fees += t.fee;
          trades++;
        });
      }
      const n = Math.max(trades, 1);
      // What the errors added never covers the fees the trade paid, and the trade loses.
      expect(caused / n).toBeLessThan(fees / n);
      rows.push(
        `hold ${hold}d: flood-and-buy ${(flooded / n).toFixed(2)} per trade, of which the errors caused ${(caused / n).toFixed(2)}, fees ${(fees / n).toFixed(2)}, over ${trades}`,
      );
    }
    process.stdout.write(`error-and-dip:\n  ${rows.join("\n  ")}\n`);
  }, 120_000);
});
