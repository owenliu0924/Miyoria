// Yahoo's US quote stream on its own: the hand-written protobuf reader against a frame as the
// streamer sent it and against broken bytes, and the connection (subscribe, resubscribe, the
// newest frame per symbol once a second, backoff with a cap, unhealthy when quiet, a clean stop)
// over a WebSocket the test drives. No network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeFrame,
  decodePricing,
  type StreamQuote,
  YahooStream,
} from "../src/real/yahoo-stream.js";
import { FakeSocket, frame, pricing } from "./stream-fakes.js";

/** NVDA at 160.22, as the streamer sent it during a regular session. */
const OBSERVED =
  "CgROVkRBFVI4IEMYoKXCjcFoKgNOTVMwCDgBRSIU3UFI6MaCoQFlkMIKQrABkAPYAQT1ApDCCkL9AiIU3UE=";
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

describe("the PricingData reader", () => {
  it("reads the observed frame: symbol, price, time in ms, exchange, the session, the change", () => {
    const p = decodePricing(bytes(OBSERVED));
    expect(p).toMatchObject({
      id: "NVDA",
      time: 1795444722000,
      exchange: "NMS",
      marketHours: 1,
    });
    expect(p?.price).toBeCloseTo(160.22, 4);
    expect(p?.change).toBeCloseTo(34.69, 4);
    expect(p?.changePercent).toBeCloseTo(27.6348, 3);
    const wrapped = JSON.stringify({ type: "pricing", message: OBSERVED });
    expect(decodeFrame(wrapped)).toEqual(p);
  });

  it("skips fields it does not know, of every wire type", () => {
    const p = decodePricing(
      pricing({ id: "BRK-B", price: 480.5, time: 1_795_400_000_000, change: -1.25 }),
    );
    expect(p).toMatchObject({ id: "BRK-B", time: 1_795_400_000_000, marketHours: 1 });
    expect(p?.price).toBeCloseTo(480.5, 4);
    expect(p?.change).toBeCloseTo(-1.25, 4);
  });

  it("never throws on a truncated frame: a cut field is no frame", () => {
    const all = bytes(OBSERVED);
    for (let n = 0; n < all.length; n++) {
      const cut = all.subarray(0, n);
      expect(() => decodePricing(cut)).not.toThrow();
      const p = decodePricing(cut);
      // Before the symbol, price and time are all there, nothing is a frame.
      if (n < 18) expect(p).toBeNull();
    }
    // Cut inside the time's varint, and inside the exchange's string.
    expect(decodePricing(all.subarray(0, 14))).toBeNull();
    expect(decodePricing(all.subarray(0, 20))).toBeNull();
  });

  it("never throws on garbage, and reads none of it as a frame unless it really is one", () => {
    let seed = 42;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let i = 0; i < 500; i++) {
      const b = new Uint8Array(1 + (next() % 64)).map(() => next() % 256);
      expect(() => decodePricing(b)).not.toThrow();
    }
    // A symbol that is not UTF-8, a varint that never ends, a group, field 0.
    expect(decodePricing(new Uint8Array([0x0a, 0x02, 0xff, 0xfe]))).toBeNull();
    expect(decodePricing(new Uint8Array([0x18, ...Array(12).fill(0xff)]))).toBeNull();
    expect(decodePricing(new Uint8Array([0x0b]))).toBeNull();
    expect(decodePricing(new Uint8Array([0x00, 0x01]))).toBeNull();
    for (const text of [
      "",
      "{",
      "null",
      '{"type":"other","message":"CgR"}',
      '{"type":"pricing","message":"%%%"}',
    ])
      expect(decodeFrame(text)).toBeNull();
  });
});

const T = Date.UTC(2026, 10, 23, 15, 0);

describe("the stream", () => {
  let got: StreamQuote[][];
  let logged: string[];
  const make = (more: Partial<ConstructorParameters<typeof YahooStream>[0]> = {}) => {
    const s = new YahooStream({
      config: { host: "streamer.example", unhealthy_ms: 30_000 },
      now: () => Date.now(),
      socket: FakeSocket,
      random: () => 1,
      baseMs: 1_000,
      maxMs: 8_000,
      log: (what) => logged.push(what),
      ...more,
    });
    s.listen((q) => got.push(q));
    return s;
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: T });
    FakeSocket.reset();
    got = [];
    logged = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes every symbol once open and hands on the newest regular frame per symbol once a second", async () => {
    const s = make();
    s.update(["NVDA", "AAPL", "NVDA"], true);
    const ws = FakeSocket.last();
    expect(ws.url).toBe("wss://streamer.example/?version=2");
    expect(s.healthy()).toBe(false);
    ws.open();
    expect(ws.messages()).toEqual([{ subscribe: ["AAPL", "NVDA"] }]);
    ws.text(frame({ id: "NVDA", price: 160.2, time: T - 3000, change: 2 }));
    ws.text(frame({ id: "NVDA", price: 160.5, time: T - 1000 }));
    // An older one after a newer one does not replace it.
    ws.text(frame({ id: "NVDA", price: 159, time: T - 2000 }));
    ws.text(frame({ id: "AAPL", price: 230.1, time: T - 500, marketHours: 2 }));
    // A symbol not asked for is not counted at all.
    ws.text(frame({ id: "TSLA", price: 300, time: T }));
    expect(got).toEqual([]);
    expect(s.healthy()).toBe(true);
    expect(s.covers("NVDA")).toBe(true);
    // A post-market frame keeps the stream healthy, but the symbol is not covered by it.
    expect(s.covers("AAPL")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual([
      { symbol: "NVDA", price: 160.5, at: T - 1000, regular: true, change: null },
      { symbol: "AAPL", price: 230.1, at: T - 500, regular: false, change: null },
    ]);
    // Many frames in the next second: one batch, the newest.
    for (let i = 1; i <= 5; i++)
      ws.text(frame({ id: "NVDA", price: 161 + i / 10, time: T + i * 100 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(got).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(got[1]).toEqual([
      { symbol: "NVDA", price: 161.5, at: T + 500, regular: true, change: null },
    ]);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("subscribes what was added and unsubscribes what went", () => {
    const s = make();
    s.update(["AAPL", "NVDA"], true);
    const ws = FakeSocket.last();
    ws.open();
    s.update(["AAPL", "NVDA"], true);
    expect(ws.messages()).toHaveLength(1);
    s.update(["AAPL", "BRK-B"], true);
    expect(ws.messages().slice(1)).toEqual([
      { unsubscribe: ["NVDA"] },
      { subscribe: ["AAPL", "BRK-B"] },
    ]);
    expect(FakeSocket.made).toHaveLength(1);
    s.stop();
  });

  it("comes back after a drop with exponential backoff, capped, and starts over once frames come", async () => {
    const s = make();
    s.update(["NVDA"], true);
    FakeSocket.last().drop();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = FakeSocket.made.length;
      let waited = 0;
      while (FakeSocket.made.length === before) {
        await vi.advanceTimersByTimeAsync(250);
        waited += 250;
      }
      waits.push(waited);
      FakeSocket.last().drop();
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 8000]);
    // A connection that delivers resets the backoff.
    await vi.advanceTimersByTimeAsync(8000);
    const ws = FakeSocket.last();
    ws.open();
    ws.text(frame({ id: "NVDA", price: 100, time: T }));
    ws.drop();
    const before = FakeSocket.made.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.made.length).toBe(before + 1);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is unhealthy after a quiet spell, and a quiet connection is opened again", async () => {
    const s = make();
    s.update(["NVDA"], true);
    const ws = FakeSocket.last();
    ws.open();
    ws.text(frame({ id: "NVDA", price: 100, time: T }));
    expect(s.healthy()).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(s.healthy()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.healthy()).toBe(false);
    expect(s.covers("NVDA")).toBe(false);
    expect(s.status()).toMatchObject({
      active: true,
      connected: true,
      healthy: false,
      last_frame_at: T,
      symbols: 1,
    });
    // The desk's next pass finds it quiet: closed, and a new one after the backoff.
    s.update(["NVDA"], true);
    expect(ws.closed).toBe(true);
    expect(logged).toContain("yahoo stream: quiet, opening it again");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.made).toHaveLength(2);
    s.stop();
  });

  it("opens a connection that never opened again", async () => {
    const s = make();
    s.update(["NVDA"], true);
    await vi.advanceTimersByTimeAsync(30_000);
    s.update(["NVDA"], true);
    expect(FakeSocket.made[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.made).toHaveLength(2);
    s.stop();
  });

  it("closes when not wanted, never connects with nothing to follow or no WebSocket, and stops clean", async () => {
    const s = make();
    s.update([], true);
    expect(FakeSocket.made).toHaveLength(0);
    s.update(["NVDA"], true);
    const ws = FakeSocket.last();
    ws.open();
    ws.text(frame({ id: "NVDA", price: 100, time: T }));
    s.update(["NVDA"], false);
    expect(ws.closed).toBe(true);
    expect(s.status()).toMatchObject({ active: false, connected: false, healthy: false });
    // Its close is ours: no reconnect, and the pending frame is still handed on.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
    s.update(["NVDA"], true);
    FakeSocket.last().open();
    FakeSocket.last().text(frame({ id: "NVDA", price: 101, time: T + 61_000 }));
    s.stop();
    expect(FakeSocket.last().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    s.update(["NVDA"], true);
    expect(FakeSocket.made).toHaveLength(2);
    const none = make({ socket: null });
    none.update(["NVDA"], true);
    expect(none.status().active).toBe(false);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it("takes only a host name", () => {
    expect(() => make({ config: { host: "evil.example/x?", unhealthy_ms: 1000 } })).toThrow();
  });
});
