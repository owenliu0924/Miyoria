// The local stocks tick every `local_tick_seconds` (owner 2026-11-22: as fast as the real quotes,
// a minute by default) inside the exchange: every tick kept before it is used, a restart or a
// downtime going on from the last one kept with the same series, the house seeing every tick in
// order (an order fills at the first tick after it, the hold time counts in ticks, a stale or
// halted tick never trades), older days rolled up into the bars the charts draw, an install from
// the hourly ticks continuing with no jump. Every name here is made up.

import { migrate } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import { describe, expect, it } from "vitest";
import { ExchangeConfigSchema, exchangeConfig } from "../src/config.js";
import { exchangeSchema } from "../src/migrations.js";
import { candlesFromPoints, type Timeframe } from "../src/real/candles.js";
import { DAILY_LIMIT, HOURLY, type LocalState, nextPrice, taipeiDay } from "../src/real/local.js";
import type { Rig } from "./rig.js";
import { ALICE, DAY, HOUR, local, MIN, rig } from "./rig.js";

const CODES = ["RICE", "WHLE", "NAPS", "CUBE", "DPSK"];
const ZONE = "Asia/Taipei";

/** Passes every minute from `from` to `to` (inclusive), the way the module's pass runs. */
async function minutes(r: Rig, from: number, to: number) {
  for (let t = from; t <= to; t += MIN) await r.at(t);
}

const ticksOf = (r: Rig, code: string) => r.store.real.ticks(code, 0);
const seriesOf = (r: Rig) => Object.fromEntries(CODES.map((c) => [c, ticksOf(r, c)]));

describe("the local stocks every minute", () => {
  it("are configured by local_tick_seconds: a minute by default, 10 to 3600 seconds", () => {
    expect(exchangeConfig().local_tick_seconds).toBe(60);
    const ok = (s: number) => ExchangeConfigSchema.safeParse({ local_tick_seconds: s }).success;
    expect([ok(9), ok(10), ok(60), ok(3600), ok(3601), ok(30.5)]).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("keep every tick, and give the same series whether Core ran all along, restarted, or was off for hours", async () => {
    const all = await rig({ open: true });
    await minutes(all, local(0, 12, 0), local(0, 15, 0));
    const series = seriesOf(all);
    expect(series.RICE?.length).toBe(181);
    // A tick a minute, on the minute, from 12:00.
    expect(series.RICE?.slice(0, 3).map((t) => t.at)).toEqual([
      local(0, 12, 0),
      local(0, 12, 1),
      local(0, 12, 2),
    ]);
    // The same database, Core restarted twice and off for an hour and a half at a time.
    const gaps = await rig({ open: true });
    await gaps.at(local(0, 12, 5));
    gaps.restart();
    await gaps.at(local(0, 13, 30));
    gaps.restart();
    await gaps.at(local(0, 15, 0));
    expect(seriesOf(gaps)).toEqual(series);
    // What is shown is the newest tick.
    expect(gaps.store.real.quotes().get("RICE")?.price).toBe(series.RICE?.at(-1)?.price);
  });

  it("still tick once an hour with local_tick_seconds = 3600, the hourly model's own prices", async () => {
    const r = await rig({ open: true, local_tick_seconds: 3600 });
    for (const t of [local(0, 12, 1), local(0, 12, 30), local(0, 13, 1), local(0, 14, 2)])
      await r.at(t);
    const rice = ticksOf(r, "RICE");
    expect(rice.map((t) => t.at)).toEqual([local(0, 12, 0), local(0, 13, 0), local(0, 14, 0)]);
    // The hourly walk itself (the same numbers as before the change), from the anchor.
    const seed = r.store.state()?.seed ?? "";
    const company = r.service.real.localOf("RICE");
    if (!company) throw new Error("RICE");
    let st: LocalState = { price: company.anchor, at: local(0, 12, 0) - 1, close: company.anchor };
    const want: number[] = [];
    for (let h = 0; h < 3; h++) {
      st = nextPrice(seed, company, local(0, 12 + h, 0), st, () => null, company.anchor, HOURLY);
      want.push(st.price);
    }
    expect(rice.map((t) => t.price)).toEqual(want);
  });

  it("send every tick of a pass through the house in order: an order fills at the first tick after it", async () => {
    const r = await rig({ open: true });
    r.wallet.fund(ALICE, 1000);
    await r.service.openAccount(ALICE);
    await r.at(local(0, 12, 30));
    r.clock.at = local(0, 12, 30) + 30_000;
    const placed = await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 2 }, "a");
    expect(placed).toMatchObject({ ok: true });
    // One pass three minutes later brings 12:31, 12:32 and 12:33: the fill is at 12:31's price.
    await r.at(local(0, 12, 33));
    const at = (t: number) => ticksOf(r, "RICE").find((x) => x.at === t)?.price;
    const fill = r.service.real.portfolio("p-alice").fills[0];
    expect(fill?.price).toBe(at(local(0, 12, 31)));
    expect(fill?.price).not.toBe(at(local(0, 12, 33)));
    // The hold time (10 minutes from the 12:31 fill) holds with a tick every minute.
    await minutes(r, local(0, 12, 34), local(0, 12, 40));
    r.clock.at = local(0, 12, 40) + 50_000;
    const early = await r.service.real.place(ALICE, { side: "sell", code: "RICE", all: true }, "e");
    expect(early).toMatchObject({ ok: false });
    await r.at(local(0, 12, 41));
    r.clock.at = local(0, 12, 41) + 10_000;
    const sale = await r.service.real.place(ALICE, { side: "sell", code: "RICE", all: true }, "s");
    expect(sale).toMatchObject({ ok: true });
    await r.at(local(0, 12, 42));
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    const sold = r.service.real.portfolio("p-alice").fills.find((f) => f.side === "sell");
    expect(sold?.price).toBe(at(local(0, 12, 42)));
    // No 2× on these: the cross-margin checks a tick runs only ever see 1× local holdings.
    const lev = await r.service.real.place(
      ALICE,
      { side: "buy", code: "RICE", coins: 100, leverage: 2 },
      "l",
    );
    expect(lev).toMatchObject({ ok: false });
  });

  it("never trade at a tick caught up after a downtime, nor at a halted stock's", async () => {
    const r = await rig({ open: true });
    r.wallet.fund(ALICE, 1000);
    await r.service.openAccount(ALICE);
    await r.at(local(0, 12, 58));
    r.clock.at = local(0, 12, 59) - 30_000;
    await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "a");
    // Core is off from 12:58 to 16:00: the ticks in between are worked out, kept and shown, but
    // only the ones within the maximum age (a tick and five minutes: 6 minutes) are traded at.
    await r.at(local(0, 16, 0));
    const ticks = ticksOf(r, "RICE");
    expect(ticks.some((t) => t.at === local(0, 13, 0))).toBe(true);
    const fill = r.service.real.portfolio("p-alice").fills[0];
    expect(fill?.price).toBe(ticks.find((t) => t.at === local(0, 15, 54))?.price);
    // A paused stock: ticks go on, nothing trades.
    r.store.real.setInstrument("WHLE", { status: "paused" }, r.clock.at);
    r.clock.at = local(0, 16, 0) + 20_000;
    const waiting = await r.service.real.place(
      ALICE,
      { side: "buy", code: "NAPS", shares: 1 },
      "n",
    );
    expect(waiting).toMatchObject({ ok: true });
    r.store.real.setInstrument("NAPS", { status: "paused" }, r.clock.at);
    await minutes(r, local(0, 16, 1), local(0, 16, 5));
    expect(r.service.real.portfolio("p-alice").fills.filter((f) => f.code === "NAPS")).toEqual([]);
    expect(ticksOf(r, "NAPS").at(-1)?.at).toBe(local(0, 16, 5));
    r.store.real.setInstrument("NAPS", { status: "active" }, r.clock.at);
    await r.at(local(0, 16, 6));
    expect(r.service.real.portfolio("p-alice").fills.filter((f) => f.code === "NAPS")).toHaveLength(
      1,
    );
  });

  it("catch up a downtime of weeks a month at a time, in the band, and the same as a pass every day", async () => {
    const slow = await rig({ open: true });
    await slow.at(local(0, 13, 0));
    // Forty days off: a month of days the first pass, the rest the next; nothing that old trades.
    await slow.at(local(40, 13, 0));
    const firstPass = slow.store.real.quotes().get("RICE");
    expect(firstPass?.at).toBeLessThan(local(40, 12, 0));
    await slow.at(local(40, 13, 1));
    const daily = await rig({ open: true });
    await daily.at(local(0, 13, 0));
    for (let d = 1; d <= 40; d++) await daily.at(local(d, 13, 0));
    await daily.at(local(40, 13, 1));
    for (const code of CODES) {
      expect(slow.store.real.quotes().get(code)).toEqual(daily.store.real.quotes().get(code));
      // Older days are one bar each, kept the same way however they were reached.
      const days = slow.store.real.localDays(code, 0);
      expect(days).toEqual(daily.store.real.localDays(code, 0));
      expect(days.length).toBeGreaterThanOrEqual(38);
      // Each day inside ±10% of the day before's close: no jump out of the band.
      for (let i = 1; i < days.length; i++) {
        const d = days[i];
        const before = days[i - 1];
        if (!d || !before) continue;
        expect(d.ref).toBe(before.close);
        expect(d.high).toBeLessThanOrEqual(d.ref * (1 + DAILY_LIMIT) + 0.01);
        expect(d.low).toBeGreaterThanOrEqual(d.ref * (1 - DAILY_LIMIT) - 0.01);
        expect(d.ticks).toBe(661);
      }
    }
    // Ticks are kept for today and yesterday only.
    const kept = new Set(ticksOf(slow, "RICE").map((t) => taipeiDay(t.at)));
    expect([...kept].sort()).toEqual([taipeiDay(local(39, 12, 0)), taipeiDay(local(40, 12, 0))]);
  }, 60_000);

  it("roll older days into bars that draw the same daily, weekly and monthly candles, and keep the 當日 chart", async () => {
    const r = await rig({ open: true });
    // An install from the hourly ticks: twelve days of a tick an hour.
    const company = r.service.real.localOf("RICE");
    if (!company) throw new Error("RICE");
    let st: LocalState = { price: 100, at: local(-12, 11, 0), close: 100 };
    const points: { at: number; price: number }[] = [];
    for (let d = -11; d <= 0; d++)
      for (let h = 12; h <= 23; h++) {
        st = nextPrice("old", company, local(d, h, 0), st, () => null, 100, HOURLY);
        points.push({ at: st.at, price: st.price });
      }
    r.store.real.recordTicks("RICE", points);
    const last = points.at(-1);
    if (!last) throw new Error("no points");
    r.store.real.saveQuote(
      { code: "RICE", price: last.price, at: last.at, prev_close: st.close },
      last.at,
    );
    const before = (tf: Timeframe) =>
      candlesFromPoints(points, tf, ZONE, tf === "intraday" ? HOUR : 5 * MIN);
    r.clock.at = local(0, 23, 30);
    await r.service.tick();
    // Days before yesterday are bars now; today's and yesterday's ticks stay.
    expect(r.store.real.localDays("RICE", 0)).toHaveLength(10);
    expect(new Set(ticksOf(r, "RICE").map((t) => taipeiDay(t.at))).size).toBe(2);
    for (const tf of ["daily", "weekly", "monthly", "intraday"] as const) {
      const set = await r.service.real.candles("RICE", tf, false);
      expect(set?.candles, tf).toEqual(before(tf));
      expect(set?.candles.every((k) => k.v === null)).toBe(true);
    }
    // The line of the overview (14 days): each rolled day its close, then the ticks kept.
    const h = r.service.real.history("RICE", 14, false);
    expect(h?.points.length).toBe(10 + 24);
    // Rolling again changes nothing.
    await r.service.tick();
    expect(r.store.real.localDays("RICE", 0)).toHaveLength(10);
  });

  it("draw today's ticks as ten-minute bars opening at yesterday's close, the line a point in five minutes", async () => {
    const r = await rig({ open: true });
    await r.at(local(-1, 23, 0));
    await minutes(r, local(0, 12, 0), local(0, 13, 0));
    const set = await r.service.real.candles("RICE", "intraday", false);
    const bars = set?.candles ?? [];
    expect(bars.map((b) => b.at)).toEqual([0, 10, 20, 30, 40, 50, 60].map((m) => local(0, 12, m)));
    const ticks = ticksOf(r, "RICE");
    const yesterday = ticks.filter((t) => t.at <= local(-1, 23, 0)).at(-1);
    // The gap shows: the first bar opens at yesterday's last tick.
    expect(bars[0]?.o).toBe(yesterday?.price);
    const first = ticks.filter((t) => t.at >= local(0, 12, 0) && t.at < local(0, 12, 10));
    expect(bars[0]?.h).toBe(Math.max(yesterday?.price ?? 0, ...first.map((t) => t.price)));
    expect(bars[0]?.c).toBe(first.at(-1)?.price);
    // The 當日 chart is drawn whole in a picture (80 bars at most): 66 for a whole day.
    expect(Math.ceil((11 * 60 + 1) / 10)).toBeLessThanOrEqual(80);
    // The line a page or a sparkline gets is thinned like a real ticker's (a point in five minutes).
    const today = (r.service.real.history("RICE", 1, false)?.points ?? []).filter(
      (p) => Date.parse(p.at) >= local(0, 12, 0),
    );
    expect(today.length).toBe(13);
  });

  it("let the ticker's view change with each tick (what the push stream sends)", async () => {
    const r = await rig({ open: true });
    await r.at(local(0, 12, 30));
    const view = () => JSON.stringify(r.service.real.history("RICE", 1, false)?.line);
    const a = view();
    r.clock.at += 10_000;
    // Ten seconds on, no new tick: the price and its time are the same.
    expect(JSON.parse(view()).price).toBe(JSON.parse(a).price);
    await r.at(local(0, 12, 31));
    const b = JSON.parse(view());
    expect(b.at).not.toBe(JSON.parse(a).at);
    expect(b.basis).toBe("quote");
    expect(b.stale).toBe(false);
  });
});

describe("an install from the hourly ticks", () => {
  it("migrates without touching its history and goes on from its last tick with no jump, measured from the same reference", async () => {
    const clock = { at: local(0, 15, 0) + 30_000 };
    const v3 = { ...exchangeSchema, migrations: exchangeSchema.migrations.slice(0, 3) };
    const raw = openTestDb({ identity: true, plugins: [v3], clock: { now: () => clock.at } });
    // Its history: four days of hourly ticks to today's 15:00, and the quote kept with it.
    const old = await import("../src/store.js");
    const before = new old.ExchangeStore(raw.db);
    const points: { at: number; price: number }[] = [];
    let p = 100;
    for (let d = -3; d <= 0; d++)
      for (let h = 12; h <= (d === 0 ? 15 : 23); h++) {
        p = Math.round(p * (1 + ((d * 7 + h) % 5) / 1000 - 0.002) * 100) / 100;
        points.push({ at: local(d, h, 0), price: p });
        before.real.tick("RICE", local(d, h, 0), p, 0);
      }
    const yesterdayClose = points.filter((x) => x.at <= local(-1, 23, 0)).at(-1)?.price ?? 0;
    before.real.saveQuote(
      { code: "RICE", price: p, at: local(0, 15, 0), prev_close: yesterdayClose },
      local(0, 15, 0),
    );
    const daily = candlesFromPoints(points, "daily", ZONE);
    // Version 4: a new table, nothing else touched.
    migrate(raw.db, [exchangeSchema], { location: ":memory:" });
    const r = await rig({ open: true }, undefined, {}, { raw, clock });
    expect(ticksOf(r, "RICE")).toEqual(points);
    expect(r.store.real.localDays("RICE", 0)).toEqual([]);
    // The first start after the upgrade, twenty minutes on.
    await r.at(local(0, 15, 20));
    const now = ticksOf(r, "RICE").filter((t) => t.at > local(0, 15, 0));
    expect(now.map((t) => t.at)).toEqual(Array.from({ length: 20 }, (_, i) => local(0, 15, i + 1)));
    // No jump: one minute's step from 15:00's price; the band still from yesterday's close.
    expect(Math.abs(Math.log((now[0]?.price ?? 0) / p))).toBeLessThan(0.01);
    expect(r.store.real.quotes().get("RICE")?.prev_close).toBe(yesterdayClose);
    for (const t of now) {
      expect(t.price).toBeLessThanOrEqual(yesterdayClose * (1 + DAILY_LIMIT) + 0.01);
      expect(t.price).toBeGreaterThanOrEqual(yesterdayClose * (1 - DAILY_LIMIT) - 0.01);
    }
    // The days before yesterday are bars now, and the daily chart is what it was (plus today's minutes).
    expect(r.store.real.localDays("RICE", 0).map((d) => d.day)).toEqual([
      taipeiDay(local(-3, 12, 0)),
      taipeiDay(local(-2, 12, 0)),
    ]);
    const set = await r.service.real.candles("RICE", "daily", false);
    expect(set?.candles.slice(0, 3)).toEqual(daily.slice(0, 3));
    expect(set?.candles[3]?.o).toBe(daily[3]?.o);
    expect(set?.candles.length).toBe(4);
    expect(DAY).toBe(24 * HOUR);
  });
});
