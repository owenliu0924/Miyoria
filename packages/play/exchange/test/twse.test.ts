// Taiwan quotes from the Taiwan Stock Exchange's own feed (owner 2026-11-23, after the first Taiwan
// session showed no price: Yahoo's Taiwan data is about 20 minutes late, older than the 5 minutes a
// quote may be traded at). A real answer captured during that session is the fixture (never the
// network); the other cases are that answer with fields changed. Then the desk: Taiwan from the
// feed, Yahoo behind it when it fails, the last known price shown but never traded at while the
// market is open without a fresh quote, and the previous close kept at once after a restart.

import { readFileSync } from "node:fs";
import {
  EXCHANGE_DISCLAIMER,
  EXCHANGE_DISCLAIMER_LEVERAGE,
  EXCHANGE_DISCLAIMER_REAL,
  exchangeDisclaimer,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { lineText } from "../src/commands.js";
import { exchangeConfig } from "../src/config.js";
import { providersOf } from "../src/module.js";
import { marketLine } from "../src/pictures.js";
import type { QuoteProvider, RawQuote } from "../src/real/provider.js";
import {
  parseTwse,
  parseTwseItem,
  roundToTick,
  TaiwanQuotes,
  TwseProvider,
  type TwseQuote,
  twseChannel,
} from "../src/real/twse.js";
import type { YahooQuote } from "../src/real/yahoo.js";
import { ALICE, MIN, rig } from "./rig.js";

/** The answer as it came, blank lines first. */
const RAW = readFileSync(new URL("./fixtures/twse-observed.json", import.meta.url), "utf8");
type Item = Record<string, unknown>;
const items = (): Item[] => (JSON.parse(RAW) as { msgArray: Item[] }).msgArray;
/** The answer with its entries changed by `edit` (by code), as the feed would send it. */
const answer = (edit: (item: Item) => void = () => undefined): string => {
  const json = JSON.parse(RAW) as { msgArray: Item[] };
  for (const item of json.msgArray) edit(item);
  return `\n\n\n${JSON.stringify(json)}`;
};
const itemOf = (code: string, edit: (item: Item) => void = () => undefined): Item => {
  const item = items().find((i) => i.c === code) as Item;
  edit(item);
  return item;
};

/** Taipei time on Monday 2026-11-23. */
const taipei = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 23, h - 8, m, s);
/** 09:13:30 Taipei, a few seconds after the answer was taken. */
const NOW = taipei(9, 13, 30);
/** Friday 2026-11-20 13:30 Taipei, the close before. */
const FRIDAY_CLOSE = Date.UTC(2026, 10, 20, 5, 30);

describe("the exchange's answer (the saved fixture)", () => {
  it("reads the latest trade when z is '-': price, the snapshot's time, the previous close, both boards", () => {
    const got = parseTwse(RAW, NOW);
    expect([...got.keys()].sort()).toEqual(["0050.TW", "2330.TW", "6488.TWO"]);
    expect(got.get("2330.TW")).toMatchObject({
      price: 2010,
      at: taipei(9, 13, 20),
      prev_close: 2000,
      regular: true,
      prev_only: false,
      from: "trade",
      date: "2026-11-23",
    });
    expect(got.get("0050.TW")).toMatchObject({
      price: 84.5,
      at: taipei(9, 12, 44),
      prev_close: 84.45,
    });
    expect(got.get("6488.TWO")).toMatchObject({
      price: 429,
      at: taipei(9, 12, 37),
      prev_close: 441.5,
    });
  });

  it("leaves out the unknown symbol (an entry without a code)", () => {
    const unknown = items().find((i) => i.c === "");
    expect(unknown).toBeDefined();
    expect(parseTwseItem(unknown, NOW)).toBeNull();
    expect(parseTwse(RAW, NOW).has("9999.TW")).toBe(false);
  });

  it("takes z when it is a number, at the snapshot's time", () => {
    const q = parseTwseItem(
      itemOf("2330", (i) => {
        i.z = "2015.0000";
      }),
      NOW,
    );
    expect(q).toMatchObject({ price: 2015, at: Number(itemOf("2330").tlong), from: "last" });
  });

  it("with neither z nor a trade, takes the midpoint of the best bid and ask, rounded to the tick", () => {
    const noTrade = (i: Item) => {
      i.trade = undefined;
    };
    // 2005 / 2010: the tick is 5 above 1000, so 2007.5 rounds to 2010; at the snapshot's time.
    expect(parseTwseItem(itemOf("2330", noTrade), NOW)).toMatchObject({
      price: 2010,
      at: Number(itemOf("2330").tlong),
      from: "mid",
      regular: true,
    });
    // An ETF: 84.85 / 84.95 → 84.9 (its tick is 0.05).
    expect(parseTwseItem(itemOf("0050", noTrade), NOW)).toMatchObject({ price: 84.9, from: "mid" });
    // 432.5 / 433.5 → 433 (0.5 below 500).
    expect(parseTwseItem(itemOf("6488", noTrade), NOW)).toMatchObject({ price: 433, from: "mid" });
    expect(roundToTick("2330", 2007.4)).toBe(2005);
    expect(roundToTick("2317", 212.26)).toBe(212.5);
    expect(roundToTick("0056", 37.123)).toBe(37.12);
  });

  it("with nothing usable, gives no price: only the previous close, to show", () => {
    const nothing = (i: Item) => {
      i.trade = undefined;
      i.a = "-";
    };
    const q = parseTwseItem(itemOf("2330", nothing), NOW) as TwseQuote;
    expect(q).toMatchObject({ price: 2000, prev_only: true, regular: false, from: "prev" });
    // A crossed book, or one side only, is no midpoint either.
    const crossed = parseTwseItem(
      itemOf("2330", (i) => {
        i.trade = undefined;
        i.b = "2020.0000_";
      }),
      NOW,
    );
    expect(crossed).toMatchObject({ prev_only: true });
  });

  it("refuses absurd numbers: a price outside the day's limits falls back, no previous close is no quote", () => {
    // z above the limit up (2200): not a price; the trade still is.
    expect(
      parseTwseItem(
        itemOf("2330", (i) => {
          i.z = "9999.0000";
        }),
        NOW,
      ),
    ).toMatchObject({
      price: 2010,
      from: "trade",
    });
    expect(
      parseTwseItem(
        itemOf("2330", (i) => {
          i.y = "-";
        }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseTwseItem(
        itemOf("2330", (i) => {
          i.d = "2026-11-23";
        }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseTwseItem(
        itemOf("2330", (i) => {
          i.c = "../x";
        }),
        NOW,
      ),
    ).toBeNull();
    // A snapshot from the future is not believed.
    expect(parseTwseItem(itemOf("2330"), taipei(9, 0))).toBeNull();
    expect(() => parseTwse("<html>busy</html>", NOW)).toThrow();
    expect(() => parseTwse('{"rtcode":"0000"}', NOW)).toThrow();
  });

  it("calls an earlier day's snapshot a close, and a pre-open trial price no price", () => {
    const friday = parseTwseItem(
      itemOf("2330", (i) => {
        i.d = "20261120";
        i.tlong = String(FRIDAY_CLOSE);
        i.t = "13:30:00";
        i.z = "2000.0000";
        i.trade = { t: "13:30:00", v: 9, z: "2000.0000" };
      }),
      NOW,
    );
    expect(friday).toMatchObject({
      price: 2000,
      at: FRIDAY_CLOSE,
      regular: false,
      prev_only: false,
    });
    // 08:45: the trial matching before the open shows a price that never traded.
    const trial = parseTwseItem(
      itemOf("2330", (i) => {
        i.tlong = String(taipei(8, 45));
        i.t = "08:45:00";
        i.z = "2050.0000";
        i.trade = undefined;
      }),
      taipei(8, 46),
    );
    expect(trial).toMatchObject({ price: 2000, prev_only: true, regular: false });
    // The closing call auction (13:25–13:30) trades nothing until 13:30: the last real trade stands.
    const auction = parseTwseItem(
      itemOf("2330", (i) => {
        i.tlong = String(taipei(13, 27));
        i.t = "13:27:00";
        i.z = "2050.0000";
        i.trade = { t: "13:24:58", v: 3, z: "2015.0000" };
      }),
      taipei(13, 27, 10),
    );
    expect(auction).toMatchObject({ price: 2015, at: taipei(13, 24, 58), from: "trade" });
  });

  it("maps .TW to tse_ and .TWO to otc_, and nothing else", () => {
    expect(twseChannel("2330.TW")).toBe("tse_2330.tw");
    expect(twseChannel("00878.TW")).toBe("tse_00878.tw");
    expect(twseChannel("6488.TWO")).toBe("otc_6488.tw");
    for (const s of ["AAPL", "BRK-B", "2330", "2330.tw", "23|30.TW", "2330.TW&x=1"])
      expect(twseChannel(s)).toBeNull();
  });
});

/** A fetch that answers `body()` (or the status) and remembers each call. */
function fake(body: () => string = () => answer()) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = {
    status: 200,
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(f.status === 200 ? body() : "busy", { status: f.status });
    },
  };
  return f;
}

const CONFIG = {
  host: "mis.twse.com.tw",
  daily_budget: 100,
  timeout_ms: 1000,
  max_backoff_seconds: 600,
  max_symbols: 50,
};

describe("the provider", () => {
  it("asks several symbols per request, in chunks, with a generic browser agent and nothing else", async () => {
    const f = fake();
    const p = new TwseProvider(CONFIG, f.fetch);
    const many = Array.from({ length: 118 }, (_, i) => `${1100 + i}.TW`);
    await p.snapshot([...many, "2330.TW", "6488.TWO", "AAPL"], NOW);
    expect(f.calls).toHaveLength(3); // 120 Taiwan symbols, 50 a request; AAPL is never asked
    const lists = f.calls.map((c) => new URL(c.url).searchParams.get("ex_ch")?.split("|") ?? []);
    expect(lists.map((l) => l.length)).toEqual([50, 50, 20]);
    expect(lists.flat()).toContain("otc_6488.tw");
    expect(lists.flat()).not.toContain("aapl");
    const first = f.calls[0] as { url: string; init: RequestInit };
    expect(first.url).toMatch(
      /^https:\/\/mis\.twse\.com\.tw\/stock\/api\/getStockInfo\.jsp\?ex_ch=tse_1100\.tw\|tse_1101\.tw\|/,
    );
    expect(first.url).toMatch(/&json=1&delay=0$/);
    expect(Object.keys(first.init.headers as object).sort()).toEqual(["accept", "user-agent"]);
    expect((first.init.headers as Record<string, string>)["user-agent"]).toMatch(/^Mozilla\/5\.0 /);
    expect(first.init).toMatchObject({
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    // Quotes are today's prices only.
    const q = await new TwseProvider(CONFIG, fake().fetch).quotes(["2330.TW", "9999.TW"], NOW);
    expect([...q.keys()]).toEqual(["2330.TW"]);
  });

  it("backs off exponentially on 429 and 5xx, and on a refused redirect or no answer", async () => {
    const f = fake();
    const p = new TwseProvider(CONFIG, f.fetch);
    f.status = 503;
    await expect(p.snapshot(["2330.TW"], NOW)).rejects.toThrow("503");
    await expect(p.snapshot(["2330.TW"], NOW + 29_000)).rejects.toThrow("backing off");
    expect(f.calls).toHaveLength(1);
    f.status = 429;
    await expect(p.snapshot(["2330.TW"], NOW + 31_000)).rejects.toThrow("429");
    // The second failure waits twice as long: 60 s.
    await expect(p.snapshot(["2330.TW"], NOW + 31_000 + 59_000)).rejects.toThrow("backing off");
    expect(f.calls).toHaveLength(2);
    f.status = 200;
    expect((await p.snapshot(["2330.TW"], NOW + 31_000 + 61_000)).size).toBe(1);
    expect(p.lastError).toBeNull();
    // A redirect is never followed: fetch refuses it, and that backs off like no answer.
    const redirected = new TwseProvider(CONFIG, async () => {
      throw new TypeError("fetch failed: redirect mode is set to error");
    });
    await expect(redirected.snapshot(["2330.TW"], NOW)).rejects.toThrow("redirect");
    await expect(redirected.snapshot(["2330.TW"], NOW + 1000)).rejects.toThrow("backing off");
    // A 404 fails without backing off.
    const g = fake();
    g.status = 404;
    const q = new TwseProvider(CONFIG, g.fetch);
    await expect(q.snapshot(["2330.TW"], NOW)).rejects.toThrow("404");
    await expect(q.snapshot(["2330.TW"], NOW + 1000)).rejects.toThrow("404");
  });

  it("keeps a daily request budget, by the Taipei day", async () => {
    const f = fake();
    const p = new TwseProvider({ ...CONFIG, daily_budget: 2 }, f.fetch);
    await p.snapshot(["2330.TW"], NOW);
    await p.snapshot(["2330.TW"], NOW + MIN);
    await expect(p.snapshot(["2330.TW"], NOW + 2 * MIN)).rejects.toThrow("budget");
    expect(f.calls).toHaveLength(2);
    expect(p.used).toBe(2);
    // 00:00 Taipei is a new day (16:00 UTC).
    await p.snapshot(["2330.TW"], Date.UTC(2026, 10, 23, 16, 0, 1));
    expect(f.calls).toHaveLength(3);
  });
});

/** Yahoo as the tests script it: its quotes, its descriptions, its charts. */
class Yahoo implements QuoteProvider {
  readonly id = "yahoo";
  readonly now = new Map<string, YahooQuote>();
  readonly asked: string[][] = [];
  readonly described: string[][] = [];
  async quotes(symbols: readonly string[]): Promise<Map<string, RawQuote>> {
    this.asked.push([...symbols]);
    return new Map(
      symbols.flatMap((s) => {
        const q = this.now.get(s);
        return q?.regular ? [[s, q as RawQuote]] : [];
      }),
    );
  }
  async describe(symbols: readonly string[]): Promise<Map<string, YahooQuote>> {
    this.described.push([...symbols]);
    return new Map(
      symbols.flatMap((s) => (this.now.has(s) ? [[s, this.now.get(s) as YahooQuote]] : [])),
    );
  }
  set(symbol: string, price: number, prev: number, at: number, regular: boolean): void {
    this.now.set(symbol, {
      symbol,
      price,
      at,
      prev_close: prev,
      currency: "TWD",
      regular,
      points: [],
      exchange: "TAI",
      type: "EQUITY",
      name: "Taiwan Semiconductor Manufacturing Company Limited",
    });
  }
}

describe("Taiwan quotes: the exchange's feed, Yahoo behind it", () => {
  it("asks Yahoo only for what the feed could not answer", async () => {
    const f = fake();
    const y = new Yahoo();
    y.set("2330.TW", 2005, 2000, NOW - 20 * MIN, true);
    y.set("2317.TW", 210, 208, NOW - 20 * MIN, true);
    const tw = new TaiwanQuotes(new TwseProvider(CONFIG, f.fetch), y);
    const got = await tw.quotes(["2330.TW", "2317.TW"], NOW);
    // The feed's 2330; it does not know 2317 (not in its answer), so Yahoo's.
    expect(got.get("2330.TW")).toMatchObject({ price: 2010, at: taipei(9, 13, 20) });
    expect(got.get("2317.TW")).toMatchObject({ price: 210 });
    expect(y.asked).toEqual([["2317.TW"]]);
    // The feed down: all of it from Yahoo (its staleness is the desk's to judge).
    f.status = 500;
    const down = await tw.quotes(["2330.TW"], NOW + MIN);
    expect(down.get("2330.TW")).toMatchObject({ price: 2005, at: NOW - 20 * MIN });
    expect(y.asked.at(-1)).toEqual(["2330.TW"]);
    // A symbol the feed knows without a price yet is not asked of Yahoo.
    const quiet = fake(() =>
      answer((i) => {
        i.trade = undefined;
        i.a = "-";
      }),
    );
    const y2 = new Yahoo();
    const tw2 = new TaiwanQuotes(new TwseProvider(CONFIG, quiet.fetch), y2);
    expect((await tw2.quotes(["2330.TW"], NOW)).size).toBe(0);
    expect(y2.asked).toEqual([]);
  });
});

/** The desk with both providers, the feed answering `body()`; Alice has an account. */
async function desk(body: () => string, more: Record<string, unknown> = {}) {
  const f = fake(body);
  const y = new Yahoo();
  const tw = new TaiwanQuotes(new TwseProvider(CONFIG, f.fetch), y);
  const r = await rig(
    { open: true, ...more } as never,
    new Map<string, QuoteProvider>([
      ["yahoo", y],
      ["twse", tw],
    ]),
  );
  r.clock.at = taipei(9, 13);
  r.wallet.fund(ALICE, 5000);
  await r.service.openAccount(ALICE);
  return { r, f, y };
}

/** A Taiwan ticker known from before with nothing kept of its price (an install's first session). */
function known(r: Awaited<ReturnType<typeof desk>>["r"], code = "2330.TW") {
  r.store.real.addInstrument(
    {
      code,
      market: "tw",
      name: code,
      exchange: "TAI",
      type: "EQUITY",
      currency: "TWD",
      provider: "yahoo",
      status: "active",
      added_at: r.clock.at,
      added_by: null,
    },
    r.clock.at,
  );
}

const lineOf = (r: Awaited<ReturnType<typeof desk>>["r"], code = "2330.TW") => {
  const l = r.service.real.view().instruments.find((i) => i.code === code);
  if (!l) throw new Error(`no ${code}`);
  return l;
};

describe("the desk on Taiwan quotes", () => {
  it("trades on the feed's live price and says where it came from", async () => {
    const { r, f, y } = await desk(() => answer());
    y.set("2330.TW", 2000, 1990, FRIDAY_CLOSE, false);
    await r.service.real.lookup(ALICE, "2330");
    // Before the first poll: Friday's close, shown, said as not live and not traded at.
    expect(lineOf(r)).toMatchObject({
      price: 2000,
      basis: "close",
      open: true,
      stale: true,
      price_note: "收盤價(11/20)・報價沒有更新,暫停成交",
    });
    const placed = await r.service.real.place(
      ALICE,
      { side: "buy", code: "2330.TW", coins: 2021 },
      "k1",
    );
    expect(placed).toMatchObject({ ok: true });
    r.clock.at = NOW;
    await r.service.tick();
    expect(f.calls.length).toBeGreaterThan(0);
    const l = lineOf(r);
    expect(l).toMatchObject({
      price: 2010,
      basis: "quote",
      stale: false,
      price_note: null,
      age_minutes: 0,
      at: new Date(taipei(9, 13, 20)).toISOString(),
      source: "資料來源:臺灣證券交易所(備援 Yahoo Finance)",
    });
    expect(l.change).toBeCloseTo(0.005, 4);
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
    expect(r.service.real.view().sessions.find((s) => s.market === "tw")).toMatchObject({
      open: true,
      stale: false,
      notice: null,
    });
    // Yahoo was never asked for Taiwan quotes: the feed answered.
    expect(y.asked).toEqual([]);
  });

  it("falls back to Yahoo when the feed fails, and then shows the last known price without trading on it", async () => {
    let text = answer();
    const { r, f, y } = await desk(() => text);
    f.status = 503;
    known(r);
    expect(lineOf(r).price).toBeNull();
    // Yahoo's Taiwan quote is 20 minutes late: stale.
    r.clock.at = taipei(9, 40);
    y.set("2330.TW", 2005, 2000, taipei(9, 20), true);
    const placed = await r.service.real.place(
      ALICE,
      { side: "buy", code: "2330.TW", coins: 2021 },
      "k1",
    );
    expect(placed).toMatchObject({ ok: true });
    await r.service.tick();
    expect(y.asked.flat()).toContain("2330.TW");
    const l = lineOf(r);
    // The previous close, with its time, marked as not live; never empty.
    expect(l).toMatchObject({
      price: 2000,
      basis: "close",
      stale: true,
      open: true,
      price_date: "2026-11-20",
      at: new Date(FRIDAY_CLOSE).toISOString(),
      price_note: "收盤價(11/20)・報價沒有更新,暫停成交",
    });
    expect(lineText(l)).toContain("報價沒有更新,暫停成交");
    expect(marketLine(l)).toBe("台股開盤中・收盤價(11/20)・報價沒有更新,暫停成交");
    expect(r.service.real.view().sessions.find((s) => s.market === "tw")).toMatchObject({
      stale: true,
      notice: "報價沒有更新,這個市場暫停成交;持股不會因為沒有報價被賣出",
    });
    // Nothing fills on it, however many passes.
    for (let i = 0; i < 5; i++) {
      r.clock.at += MIN;
      y.set("2330.TW", 2005, 2000, r.clock.at - 20 * MIN, true);
      await r.service.tick();
    }
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    expect(r.service.real.report().quotes.find((q) => q.code === "2330.TW")).toMatchObject({
      price: null,
    });
    // The feed back (past its backoff): the next live price fills it.
    f.status = 200;
    text = answer((i) => {
      if (i.c !== "2330") return;
      i.tlong = String(taipei(9, 59, 50));
      i.trade = { t: "09:59:40", v: 2, z: "2015.0000" };
    });
    r.clock.at = taipei(10, 0);
    await r.service.tick();
    expect(lineOf(r)).toMatchObject({ price: 2015, basis: "quote", stale: false });
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
  });

  it("after a restart before the open shows the previous close at once, never a trial price", async () => {
    const preOpen = () =>
      answer((i) => {
        i.tlong = String(taipei(8, 45));
        i.t = "08:45:00";
        i.z = "2050.0000";
        i.trade = undefined;
      });
    const { r, f, y } = await desk(preOpen);
    known(r);
    r.clock.at = taipei(8, 46);
    r.restart();
    await r.service.tick();
    expect(f.calls).toHaveLength(1);
    // Not Yahoo's (it is asked only for the starters it has not validated yet).
    expect(y.described.flat()).not.toContain("2330.TW");
    expect(lineOf(r)).toMatchObject({
      price: 2000,
      basis: "close",
      open: false,
      stale: false,
      at: new Date(FRIDAY_CLOSE).toISOString(),
      price_note: "收盤價(11/20)・休市中",
    });
    // Asked once for that close, not again.
    r.clock.at += 10 * MIN;
    await r.service.tick();
    expect(f.calls).toHaveLength(1);
  });

  it("a ticker in session with nothing known is asked for its close on the first pass", async () => {
    const { r } = await desk(() =>
      answer((i) => {
        i.trade = undefined;
        i.a = "-";
      }),
    );
    known(r);
    r.service.real.noteView("p-alice" as never, "2330.TW");
    r.clock.at = NOW;
    r.restart();
    await r.service.tick();
    expect(lineOf(r)).toMatchObject({ price: 2000, basis: "close", stale: true, open: true });
  });

  it("uses Yahoo alone when the setting says so, and keeps a JSON provider's tickers on it", async () => {
    const { r, f, y } = await desk(() => answer(), { quotes_tw_provider: "yahoo" });
    y.set("2330.TW", 2010, 2000, NOW - 30_000, true);
    r.clock.at = NOW;
    await r.service.real.lookup(ALICE, "2330");
    await r.service.tick();
    expect(f.calls).toHaveLength(0);
    expect(lineOf(r)).toMatchObject({
      price: 2010,
      basis: "quote",
      source: "資料來源:Yahoo Finance",
    });
    // The configured providers: Yahoo, the Taiwan feed, and a JSON endpoint as before.
    const ps = providersOf(
      exchangeConfig({
        providers: [{ id: "mine", url: "https://quotes.example/q?s={symbols}", price_path: "p" }],
      } as never),
    );
    expect([...ps.keys()]).toEqual(["yahoo", "twse", "mine"]);
    expect(ps.get("twse")).toBeInstanceOf(TaiwanQuotes);
    expect(exchangeConfig({}).quotes_tw_provider).toBe("twse");
  });
});

describe("the small print", () => {
  it("is unchanged on every exchange surface", async () => {
    expect(EXCHANGE_DISCLAIMER_REAL).toBe("資料來源:Yahoo Finance,報價可能延遲。");
    expect(EXCHANGE_DISCLAIMER_LEVERAGE).toBe("槓桿可能讓你賠光錢包和其他持股。");
    const { r } = await desk(() => answer());
    const v = r.service.real.view();
    expect(v.disclaimer).toBe(exchangeDisclaimer(r.service.real.currency));
    expect(exchangeDisclaimer()).toBe(EXCHANGE_DISCLAIMER);
  });
});
