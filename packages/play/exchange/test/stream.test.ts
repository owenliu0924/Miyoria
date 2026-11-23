// US quotes pushed by Yahoo's streamer, through the desk (owner 2026-11-23): a pushed price goes
// through the same checks as a polled one, with the frame's own time; only regular-session frames;
// never an older one over a newer one; one taken per ticker a second at most. While the stream
// pushes a ticker it leaves the quick poll; when the stream goes quiet the poll takes over again.
// Also two defects fixed on the way: a US ticker nobody holds or looks at gets a price of the
// session (slowly, without the stream too), and after a restart while the market is closed the
// last price is shown (kept, read back; one fetch for a ticker with none). Made-up numbers only.

import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeKey, ExchangeModule, QuotesNotice } from "../src/module.js";
import type { QuoteProvider, RawQuote } from "../src/real/provider.js";
import type { YahooQuote } from "../src/real/yahoo.js";
import { YahooStream } from "../src/real/yahoo-stream.js";
import { exchangeTables } from "../src/store.js";
import { ALICE, type Rig, rig } from "./rig.js";
import { FakeSocket, frame } from "./stream-fakes.js";

/** Monday 2026-11-23 10:00 in New York (EST): the US market is open. */
const OPEN_NY = Date.UTC(2026, 10, 23, 15, 0);
/** Saturday 2026-11-21 11:00 Taipei: closed since Friday's 16:00 in New York. */
const SATURDAY = Date.UTC(2026, 10, 21, 3, 0);
/** Friday 2026-11-20 16:00:02 in New York: the closing print. */
const FRIDAY_CLOSE = Date.UTC(2026, 10, 20, 21, 0, 2);
const SEC = 1000;
const MIN = 60 * SEC;

/** Yahoo's poll as the tests set it: what each call asked, and what it answers. */
class Poll implements QuoteProvider {
  readonly id = "yahoo";
  readonly now = new Map<string, YahooQuote>();
  readonly quoted: string[][] = [];
  readonly described: string[][] = [];
  down = false;

  set(symbol: string, price: number, at: number, regular = true, prev = price): void {
    this.now.set(symbol, {
      symbol,
      price,
      at,
      prev_close: prev,
      currency: "USD",
      regular,
      points: [],
      exchange: "NMS",
      type: "EQUITY",
      name: `${symbol} Corp`,
    });
  }

  async quotes(symbols: readonly string[]): Promise<Map<string, RawQuote>> {
    this.quoted.push([...symbols]);
    if (this.down) throw new Error("yahoo is down");
    return new Map(
      symbols.flatMap((s) => {
        const q = this.now.get(s);
        return q?.regular ? [[s, q as RawQuote]] : [];
      }),
    );
  }

  async describe(symbols: readonly string[]): Promise<Map<string, YahooQuote>> {
    this.described.push([...symbols]);
    if (this.down) throw new Error("yahoo is down");
    return new Map(
      symbols.flatMap((s) => {
        const q = this.now.get(s);
        return q ? [[s, q]] : [];
      }),
    );
  }

  /** Every symbol asked for quotes, flat. */
  asked(): string[] {
    return this.quoted.flat();
  }
}

const addUs = (r: Rig, code: string) =>
  r.store.real.addInstrument(
    {
      code,
      market: "us",
      name: `${code} Corp`,
      exchange: "NMS",
      type: "EQUITY",
      currency: "USD",
      provider: "yahoo",
      status: "active",
      added_at: r.clock.at,
      added_by: null,
    },
    r.clock.at,
  );

const lineOf = (r: Rig, code: string) => {
  const l = r.service.real.view().instruments.find((i) => i.code === code);
  if (!l) throw new Error(`no ${code}`);
  return l;
};

/** Lets the desk's queued turn run (the stream's batch timer is faked, the rest is not). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

async function streamed(more: Record<string, unknown> = {}) {
  const poll = new Poll();
  const quoted: string[][] = [];
  let clock: { at: number } = { at: OPEN_NY };
  const stream = new YahooStream({
    config: { host: "streamer.example", unhealthy_ms: 30 * SEC },
    now: () => clock.at,
    socket: FakeSocket,
    random: () => 1,
  });
  const r = await rig({ open: true, ...more } as never, new Map([["yahoo", poll]]), {
    stream,
    quoted: (codes) => quoted.push([...codes]),
  });
  clock = r.clock;
  r.clock.at = OPEN_NY;
  /** Frames arrive, the stream's second passes, the desk takes the batch. */
  const push = async (...frames: Parameters<typeof frame>[0][]) => {
    for (const f of frames) FakeSocket.last().text(frame(f));
    await vi.advanceTimersByTimeAsync(SEC);
    await settle();
  };
  return { r, poll, stream, quoted, push };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  FakeSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pushed US quotes", () => {
  it("subscribe every active US ticker, held or not, and take a regular frame like a polled quote", async () => {
    const { r, push, quoted, stream } = await streamed();
    addUs(r, "NVDA");
    addUs(r, "AMD");
    await r.service.tick();
    const ws = FakeSocket.last();
    ws.open();
    expect(ws.messages()[0]?.subscribe).toEqual(["AMD", "NVDA"]);
    // Nobody holds AMD or looked at it: the stream prices it anyway.
    await push({ id: "AMD", price: 120.25, time: OPEN_NY - 2 * SEC, change: 2.25 });
    expect(lineOf(r, "AMD")).toMatchObject({
      price: 120.25,
      basis: "quote",
      at: new Date(OPEN_NY - 2 * SEC).toISOString(),
      stale: false,
      open: true,
    });
    // The previous close is the price less the change; the change follows from it.
    expect(r.store.real.quotes().get("AMD")).toMatchObject({ price: 120.25, prev_close: 118 });
    expect(lineOf(r, "AMD").change).toBeCloseTo(120.25 / 118 - 1, 4);
    // Kept like a polled one: the chart's point, the instrument's last quote time.
    expect(r.store.real.ticks("AMD", 0)).toEqual([{ at: OPEN_NY - 2 * SEC, price: 120.25 }]);
    expect(r.store.real.instrument("AMD")?.last_quote_at).toBe(OPEN_NY - 2 * SEC);
    expect(quoted).toEqual([["AMD"]]);
    // The owner's report says how the stream is.
    expect(r.service.real.providerStatus()).toEqual([
      {
        id: "yahoo",
        last_error: null,
        stream: {
          active: true,
          connected: true,
          healthy: true,
          last_frame_at: new Date(OPEN_NY).toISOString(),
          symbols: 2,
        },
      },
    ]);
    stream.stop();
  });

  it("take one price per ticker a second at most, the newest, and never an older one over a newer one", async () => {
    const { r, push, quoted, stream } = await streamed();
    addUs(r, "NVDA");
    await r.service.tick();
    FakeSocket.last().open();
    await push(
      ...[1, 2, 3, 4, 5].map((i) => ({
        id: "NVDA",
        price: 160 + i / 10,
        time: OPEN_NY - 10 * SEC + i * 100,
      })),
    );
    expect(lineOf(r, "NVDA").price).toBe(160.5);
    expect(quoted).toEqual([["NVDA"]]);
    // Older than what was taken: nothing changes.
    await push({ id: "NVDA", price: 150, time: OPEN_NY - 20 * SEC });
    expect(lineOf(r, "NVDA").price).toBe(160.5);
    expect(lineOf(r, "NVDA").at).toBe(new Date(OPEN_NY - 10 * SEC + 500).toISOString());
    expect(quoted).toHaveLength(1);
    stream.stop();
  });

  it("ignore pre- and post-market frames, and refuse a stale or absurd one like a polled one", async () => {
    const { r, push, stream } = await streamed();
    addUs(r, "NVDA");
    await r.service.tick();
    FakeSocket.last().open();
    await push({ id: "NVDA", price: 161, time: OPEN_NY - SEC, marketHours: 0 });
    await push({ id: "NVDA", price: 162, time: OPEN_NY - SEC, marketHours: 2 });
    expect(lineOf(r, "NVDA").price).toBeNull();
    await push({ id: "NVDA", price: 160, time: OPEN_NY - SEC });
    expect(lineOf(r, "NVDA").price).toBe(160);
    // Newer than the last, but older than the maximum age (300 s by default): refused.
    r.clock.at += 6 * MIN;
    await push({ id: "NVDA", price: 161, time: OPEN_NY });
    expect(lineOf(r, "NVDA").price).toBe(160);
    expect(r.store.real.quotes().get("NVDA")).toMatchObject({ refused: 1, last_refusal: "stale" });
    // A jump past the US limit, once: a bad number until a later one confirms it.
    await push({ id: "NVDA", price: 400, time: r.clock.at - SEC });
    expect(lineOf(r, "NVDA").price).toBe(160);
    expect(r.store.real.quotes().get("NVDA")).toMatchObject({ refused: 2, last_refusal: "jump" });
    // In the future (more than a minute): refused.
    await push({ id: "NVDA", price: 160.5, time: r.clock.at + 5 * MIN });
    expect(lineOf(r, "NVDA").price).toBe(160);
    expect(r.store.real.quotes().get("NVDA")?.last_refusal).toBe("future");
    stream.stop();
  });

  it("fill a waiting order at the first pushed quote after it, at that price", async () => {
    const { r, poll, push, stream } = await streamed();
    r.wallet.fund(ALICE, 50_000);
    await r.service.openAccount(ALICE);
    poll.set("NVDA", 160, OPEN_NY - 20 * SEC);
    await r.service.real.lookup(ALICE, "NVDA");
    await r.service.tick();
    FakeSocket.last().open();
    r.clock.at += 5 * SEC;
    const placed = await r.service.real.place(
      ALICE,
      { side: "buy", code: "NVDA", coins: 9600 },
      "k",
    );
    if (!placed.ok) throw new Error(placed.message);
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    // A frame from before the order does not fill it; the first one after does.
    await push({ id: "NVDA", price: 160.1, time: r.clock.at - SEC });
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    r.clock.at += 2 * SEC;
    await push({ id: "NVDA", price: 161.5, time: r.clock.at - SEC });
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
    const fill = r.service.real.portfolio("p-alice").fills[0];
    // US$161.5 at 30 NT$ a dollar, 1 NT$ a coin.
    expect(fill?.price).toBeCloseTo(161.5 * 30, 6);
    stream.stop();
  });

  it("are not taken while the exchange is off or the market is closed", async () => {
    const { r, push, stream } = await streamed();
    addUs(r, "NVDA");
    await r.service.tick();
    FakeSocket.last().open();
    // Closed: 16:30 in New York.
    r.clock.at = OPEN_NY + 6.5 * 60 * MIN;
    await push({ id: "NVDA", price: 160, time: r.clock.at - SEC });
    expect(lineOf(r, "NVDA").price).toBeNull();
    // The next pass closes the stream until just before the next open.
    await r.service.tick();
    expect(FakeSocket.last().closed).toBe(true);
    expect(stream.status().active).toBe(false);
    stream.stop();
  });
});

describe("the poll beside the stream", () => {
  it("leaves out what the stream pushes, and takes over when the stream goes quiet", async () => {
    const { r, poll, push, stream } = await streamed();
    r.wallet.fund(ALICE, 50_000);
    await r.service.openAccount(ALICE);
    poll.set("NVDA", 160, OPEN_NY - 20 * SEC);
    await r.service.real.lookup(ALICE, "NVDA");
    // Viewed just now: in the quick poll until the stream covers it.
    await r.service.tick();
    expect(poll.asked()).toContain("NVDA");
    FakeSocket.last().open();
    await push({ id: "NVDA", price: 160.2, time: OPEN_NY - SEC });
    poll.quoted.length = 0;
    r.clock.at += 20 * SEC;
    await push({ id: "NVDA", price: 160.3, time: r.clock.at - SEC });
    // Pushed now: out of the quick poll, into the slow refresh (asked once now, then in 5 min).
    await r.service.tick();
    expect(poll.quoted).toEqual([["NVDA"]]);
    poll.quoted.length = 0;
    r.clock.at += 20 * SEC;
    await push({ id: "NVDA", price: 160.35, time: r.clock.at - SEC });
    await r.service.tick();
    expect(poll.asked()).not.toContain("NVDA");
    expect(lineOf(r, "NVDA").price).toBe(160.35);
    expect(r.service.real.effectiveInterval()).toBe(60);
    // Nothing for 30 s: unhealthy, polled again exactly as without a stream.
    r.clock.at += 31 * SEC;
    poll.set("NVDA", 160.4, r.clock.at - 5 * SEC);
    await r.service.tick();
    expect(poll.asked()).toContain("NVDA");
    expect(lineOf(r, "NVDA").price).toBe(160.4);
    stream.stop();
  });

  it("still refreshes a pushed ticker slowly, and an older polled quote never replaces a newer pushed one", async () => {
    const { r, poll, push, stream } = await streamed();
    addUs(r, "NVDA");
    await r.service.tick();
    FakeSocket.last().open();
    await push({ id: "NVDA", price: 160.2, time: OPEN_NY - SEC });
    poll.quoted.length = 0;
    // Five minutes on: the slow refresh asks it; its answer is older than the pushed one.
    r.clock.at = OPEN_NY + 5 * MIN;
    await push({ id: "NVDA", price: 160.6, time: r.clock.at - SEC });
    poll.set("NVDA", 150, r.clock.at - 30 * SEC);
    await r.service.tick();
    expect(poll.asked()).toEqual(["NVDA"]);
    expect(lineOf(r, "NVDA").price).toBe(160.6);
    stream.stop();
  });
});

describe("a US ticker nobody holds or looks at (the stream off)", () => {
  it("gets a price of the session at a slow cadence, not only the close it had", async () => {
    const poll = new Poll();
    const r = await rig({ open: true } as never, new Map([["yahoo", poll]]));
    r.clock.at = OPEN_NY;
    addUs(r, "AMD");
    // Its last close was known from before: the old poll never asked it again all session.
    r.store.real.setInstrument(
      "AMD",
      { close: { price: 110, prev_close: 108, at: FRIDAY_CLOSE } },
      r.clock.at,
    );
    poll.set("AMD", 118, OPEN_NY - 10 * SEC, true, 110);
    await r.service.tick();
    expect(poll.asked()).toEqual(["AMD"]);
    expect(lineOf(r, "AMD")).toMatchObject({ price: 118, basis: "quote" });
    expect(r.service.real.report().quotes.find((q) => q.code === "AMD")?.price).toBe(118);
    // Not again at every pass: every five minutes.
    poll.quoted.length = 0;
    poll.set("AMD", 119, OPEN_NY + 2 * MIN);
    r.clock.at = OPEN_NY + 2.5 * MIN;
    await r.service.tick();
    expect(poll.asked()).toEqual([]);
    r.clock.at = OPEN_NY + 5 * MIN;
    poll.set("AMD", 119.5, r.clock.at - 10 * SEC);
    await r.service.tick();
    expect(poll.asked()).toEqual(["AMD"]);
    expect(lineOf(r, "AMD").price).toBe(119.5);
    // A held one stays in the quick poll (every pass), as before.
    expect(r.service.real.effectiveInterval()).toBe(60);
  });
});

describe("a restart while the US market is closed", () => {
  it("shows the last price kept (read back, no fetch), and one fetch for a ticker with none, as a close", async () => {
    const poll = new Poll();
    const r = await rig({ open: true } as never, new Map([["yahoo", poll]]));
    r.wallet.fund(ALICE, 50_000);
    await r.service.openAccount(ALICE);
    // Friday in session: NVDA quoted and kept.
    r.clock.at = FRIDAY_CLOSE - 10 * MIN;
    addUs(r, "NVDA");
    poll.set("NVDA", 158, r.clock.at - 20 * SEC, true, 150);
    await r.service.tick();
    expect(r.store.real.quotes().get("NVDA")?.price).toBe(158);
    // Saturday: a new process; Yahoo cannot be reached.
    r.clock.at = SATURDAY;
    addUs(r, "AMD");
    r.restart();
    poll.down = true;
    poll.quoted.length = 0;
    await r.service.tick();
    expect(lineOf(r, "NVDA")).toMatchObject({
      price: 158,
      basis: "close",
      price_note: "收盤價(11/20)・休市中",
      open: false,
    });
    expect(lineOf(r, "AMD").price).toBeNull();
    // Yahoo is back: AMD (nothing known) is asked once and shows Friday's close, not tradable.
    poll.down = false;
    poll.set("AMD", 117, FRIDAY_CLOSE, false, 115);
    r.clock.at += 31 * MIN;
    await r.service.tick();
    r.clock.at += 10 * MIN;
    await r.service.tick();
    expect(poll.described.flat().filter((s) => s === "AMD")).toHaveLength(2); // the failed try and the one
    expect(poll.quoted).toEqual([]);
    expect(lineOf(r, "AMD")).toMatchObject({
      price: 117,
      basis: "close",
      price_note: "收盤價(11/20)・休市中",
      open: false,
      stale: false,
    });
    const q = await r.service.real.quote(ALICE, { side: "buy", code: "AMD", coins: 5000 });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.open).toBe(false);
    expect(q.quote.price_note).toBe("收盤價(11/20)・休市中");
  });
});

describe("the module", () => {
  it("says which quotes were taken at most once a second, the last never lost, and leaves no timer", async () => {
    const sent: string[][] = [];
    let now = 0;
    const n = new QuotesNotice(
      (codes) => sent.push(codes),
      () => now,
    );
    n.add(["NVDA"]);
    expect(sent).toEqual([["NVDA"]]);
    now = 300;
    n.add(["AMD"]);
    n.add(["NVDA", "AMD"]);
    expect(sent).toHaveLength(1);
    now = 1000;
    await vi.advanceTimersByTimeAsync(700);
    expect(sent).toEqual([["NVDA"], ["AMD", "NVDA"]]);
    now = 1200;
    n.add(["TSLA"]);
    n.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the stream with the pass and stops it with the module", async () => {
    vi.useRealTimers();
    const clock = { now: () => OPEN_NY };
    const store = await SqliteStore.open(":memory:", { plugins: [exchangeTables], clock });
    const stream = new YahooStream({
      config: { host: "streamer.example", unhealthy_ms: 30 * SEC },
      now: clock.now,
      socket: FakeSocket,
    });
    const poll = new Poll();
    const sup = new Supervisor();
    sup.services.provide("app", StoreKey, store);
    try {
      await sup.register(
        new ExchangeModule({
          clock,
          tickMs: 3_600_000,
          seed: "m",
          providers: new Map([["yahoo", poll]]),
          stream,
          sources: {},
        }),
        { open: true },
        true,
      );
      store.plugin(exchangeTables).real.addInstrument(
        {
          code: "NVDA",
          market: "us",
          name: "NVDA Corp",
          exchange: "NMS",
          type: "EQUITY",
          currency: "USD",
          provider: "yahoo",
          status: "active",
          added_at: OPEN_NY,
          added_by: null,
        },
        OPEN_NY,
      );
      await sup.startAll();
      await sup.services.require(ExchangeKey).tick();
      expect(FakeSocket.made.length).toBeGreaterThan(0);
      expect(stream.status().active).toBe(true);
    } finally {
      await sup.stopAll();
      await store.close();
    }
    expect(stream.status()).toMatchObject({ active: false, connected: false });
    expect(FakeSocket.made.every((s) => s.closed || s.readyState === 0)).toBe(true);
  });
});
