// The five local stocks: one tick an hour 12:00–23:00 Taipei, reproducible from the seed, a hard
// ±10% daily limit, her real things moving a price at most ±3% a day as a gap at the next day's first
// tick (lagged: never a count a member can still change and trade on at a known price), and the
// offline check that "feed her, buy RICE, sell" does not beat the fee.

import { describe, expect, it } from "vitest";
import { feeOn } from "../src/engine/money.js";
import { rngFor } from "../src/engine/rng.js";
import {
  DAILY_LIMIT,
  HARD_BAND,
  LOCAL_CODES,
  type LocalCode,
  LocalProvider,
  type LocalSignal,
  type LocalState,
  lastTick,
  nextPrice,
  nextTickAfter,
  SIGNAL_MAX,
  signalMove,
} from "../src/real/local.js";

const HOUR = 3_600_000;
/** Monday 2026-11-23 12:00 Taipei. */
const NOON = Date.UTC(2026, 10, 23, 4, 0);
/** The configured anchors (config defaults). */
const ANCHORS: Record<LocalCode, number> = { RICE: 100, WHLE: 108, NAPS: 88, CUBE: 116, DPSK: 94 };
const anchor = (c: LocalCode) => ANCHORS[c];

describe("the local stocks", () => {
  it("tick hourly from 12:00 to 23:00 Taipei and skip the night", () => {
    expect(lastTick(NOON + 30 * 60_000)).toBe(NOON);
    expect(lastTick(NOON - HOUR)).toBeNull();
    expect(lastTick(NOON + 11 * HOUR)).toBe(NOON + 11 * HOUR);
    expect(nextTickAfter(NOON + 11 * HOUR)).toBe(NOON + 24 * HOUR);
  });

  it("are the same from the same seed and stay within the daily limit", async () => {
    const run = async (seed: string) => {
      const p = new LocalProvider(
        seed,
        () => null,
        anchor,
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
    expect(signalMove({ count: 1000, average: 10 }, 1)).toBe(SIGNAL_MAX);
    expect(signalMove({ count: 0, average: 10 }, 1)).toBe(-SIGNAL_MAX);
    expect(signalMove({ count: 0, average: 10 }, -1)).toBe(SIGNAL_MAX);
    const seen: number[] = [];
    const signals = (_c: string, day: number) => {
      seen.push(day);
      return { count: 40, average: 20 };
    };
    const st = { price: 100, at: NOON - 13 * HOUR, close: 100 };
    const open = nextPrice("s", "RICE", NOON, st, signals, 100);
    // The signal read is the day before the tick's.
    expect(seen).toEqual([Math.floor((NOON + 8 * HOUR) / 86_400_000) - 1]);
    expect(nextPrice("s", "RICE", NOON + HOUR, open, signals, 100)).toBeDefined();
    expect(seen).toHaveLength(1);
  });

  it("stay within 0.5×–2× of their anchor over simulated years, even pushed one way every day", () => {
    // Ten seeds, a year each (365 × 12 ticks). The signal pushes the full +3% (or −3%) every day: the
    // worst a crowd could do. The range is printed for the report.
    const out: string[] = [];
    for (const code of LOCAL_CODES) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = 0;
      for (const push of [0, 1, -1]) {
        for (let seed = 0; seed < 10; seed++) {
          const a = ANCHORS[code];
          let st: LocalState = { price: a, at: NOON - 13 * HOUR, close: a };
          const signals = () => (push === 0 ? null : { count: push > 0 ? 1000 : 0, average: 10 });
          for (let d = 0; d < 365; d++)
            for (let h = 0; h < 12; h++) {
              st = nextPrice(`y${seed}`, code, NOON + d * 24 * HOUR + h * HOUR, st, signals, a);
              lo = Math.min(lo, st.price / a);
              hi = Math.max(hi, st.price / a);
            }
        }
      }
      expect(lo).toBeGreaterThanOrEqual(HARD_BAND.lo);
      expect(hi).toBeLessThanOrEqual(HARD_BAND.hi);
      out.push(`${code} ${ANCHORS[code]}: ${lo.toFixed(2)}×–${hi.toFixed(2)}×`);
    }
    process.stdout.write(`local year range: ${out.join("; ")}
`);
  });

  it("do not pay a member who feeds her, buys RICE and sells: the fee wins", () => {
    // 2000 simulated days. Everyone else feeds her about 19 times a day; the flipper adds five rice
    // feeds (10 coins each), buys 300 coins of RICE at 23:00 and sells at the next 12:00, after the gap.
    const result = (extraFeeds: number, onlyBigDays: boolean) => {
      const counts: number[] = [];
      let st = { price: 100, at: NOON - 13 * HOUR, close: 100 };
      let total = 0;
      let trades = 0;
      const signal = (day: number): LocalSignal | null => {
        const c = counts[day];
        if (c === undefined) return null;
        const recent = counts.slice(Math.max(0, day - 7), day);
        return {
          count: c,
          average: recent.length === 0 ? c : recent.reduce((t, x) => t + x, 0) / recent.length,
        };
      };
      const day0 = Math.floor((NOON + 8 * HOUR) / 86_400_000);
      for (let d = 0; d < 2000; d++) {
        const rng = rngFor("feeds", d);
        const others = Math.max(0, Math.round(19 + rng.normal() * 6));
        counts[day0 + d] = others + extraFeeds;
        let p23 = st.price;
        for (let h = 0; h < 12; h++) {
          st = nextPrice(
            "flip",
            "RICE",
            NOON + d * 24 * HOUR + h * HOUR,
            st,
            (_c, day) => signal(day),
            100,
          );
          if (h === 11) p23 = st.price;
        }
        // The next day's first tick carries today's count.
        const next = nextPrice(
          "flip",
          "RICE",
          NOON + (d + 1) * 24 * HOUR,
          st,
          (_c, day) => signal(day),
          100,
        );
        const s = signal(day0 + d);
        const dev = s ? (s.count - s.average) / Math.max(s.average, 1) : 0;
        if (onlyBigDays && dev < 0.4) continue;
        const coins = 300;
        const buyFee = feeOn(coins, 0.01, 1);
        const shares = (coins - buyFee) / p23;
        const gross = Math.floor(shares * next.price);
        const sellFee = feeOn(gross, 0.01, 1);
        total += gross - sellFee - coins - extraFeeds * 10;
        trades++;
      }
      return { mean: total / Math.max(trades, 1), trades };
    };
    const feeder = result(5, false);
    const freeRider = result(0, true);
    expect(feeder.mean).toBeLessThan(0);
    expect(freeRider.mean).toBeLessThan(0);
    process.stdout.write(
      `feed-and-flip: feeder ${feeder.mean.toFixed(2)} coins/trade over ${feeder.trades}; free rider on big days ${freeRider.mean.toFixed(2)} over ${freeRider.trades}\n`,
    );
  });
});
