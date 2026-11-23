// US quotes pushed by Yahoo's streamer (owner 2026-11-23: polled US quotes were 3–40 s old; a
// trading app ticks). One WebSocket to `wss://<host>/?version=2`, no account, no cookie; after it
// opens, one text frame `{"subscribe":[...]}` names every active US ticker on Yahoo (held or not:
// the stream has no per-request budget). Each answer is a text frame
// `{"type":"pricing","message":"<base64>"}` whose message is a protobuf `PricingData`, read here
// by hand (`decodePricing`): only the fields below are used, every other one is skipped by its
// wire type, and anything that does not parse is no frame at all.
//
//     1 id (string, the symbol)        2 price (float32)          3 time (sint64, epoch ms)
//     5 exchange (string, `NMS`)        7 marketHours (enum: 0 pre, 1 regular, 2 post, 3 extended)
//     8 changePercent (float32, %)     12 change (float32)
//
// The newest frame of each symbol is handed on at most once a `flushMs` (one batch), so a busy
// ticker never floods the desk. The connection comes back after a drop with capped exponential
// backoff and jitter; it counts as unhealthy (the poll takes over, as without a stream) when no
// frame at all came for `unhealthy_ms` while it should be streaming, and it is then opened again.
// What a frame says is untrusted numbers: the desk checks each one exactly like a polled quote.

/** One `PricingData` as decoded (the fields used here). */
export interface PricingData {
  id: string;
  price: number;
  /** Epoch ms. */
  time: number;
  exchange: string | null;
  /** 0 pre-market, 1 regular, 2 post-market, 3 extended; `null`: not sent. */
  marketHours: number | null;
  changePercent: number | null;
  change: number | null;
}

/** The longest varint (10 bytes, 64 bits). */
const VARINT_MAX = 10;

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** An unsigned varint as a number (exact up to 2^53), or `null` when it runs past the end. */
  varint(): number | null {
    let out = 0;
    let scale = 1;
    for (let i = 0; i < VARINT_MAX; i++) {
      if (this.pos >= this.buf.length) return null;
      const b = this.buf[this.pos++] as number;
      out += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return out;
      scale *= 128;
    }
    return null;
  }

  bytes(n: number): Uint8Array | null {
    if (n < 0 || this.pos + n > this.buf.length) return null;
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** A zigzag-encoded signed varint. */
const unzigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

const float32 = (b: Uint8Array): number =>
  new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);

/** A `PricingData` from its bytes; `null` when it does not parse or lacks a symbol, price or time. */
export function decodePricing(buf: Uint8Array): PricingData | null {
  const r = new Reader(buf);
  const out: Partial<PricingData> = {};
  const text = new TextDecoder("utf-8", { fatal: true });
  try {
    while (!r.done) {
      const key = r.varint();
      if (key === null) return null;
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (field === 0) return null;
      switch (wire) {
        case 0: {
          const v = r.varint();
          if (v === null) return null;
          if (field === 3) out.time = unzigzag(v);
          else if (field === 7) out.marketHours = v;
          break;
        }
        case 1:
          if (r.bytes(8) === null) return null;
          break;
        case 2: {
          const n = r.varint();
          if (n === null) return null;
          const b = r.bytes(n);
          if (b === null) return null;
          if (field === 1) out.id = text.decode(b);
          else if (field === 5) out.exchange = text.decode(b);
          break;
        }
        case 5: {
          const b = r.bytes(4);
          if (b === null) return null;
          const f = float32(b);
          if (field === 2) out.price = f;
          else if (field === 8) out.changePercent = f;
          else if (field === 12) out.change = f;
          break;
        }
        default:
          // Groups (3, 4) and the unused 6 and 7: not a frame this reads.
          return null;
      }
    }
  } catch {
    // A string that is not UTF-8.
    return null;
  }
  if (typeof out.id !== "string" || out.id === "") return null;
  if (typeof out.price !== "number" || typeof out.time !== "number") return null;
  return {
    id: out.id,
    price: out.price,
    time: out.time,
    exchange: out.exchange ?? null,
    marketHours: out.marketHours ?? null,
    changePercent: out.changePercent ?? null,
    change: out.change ?? null,
  };
}

/** A text frame of the streamer: its `PricingData`, or `null` (another type, or junk). */
export function decodeFrame(text: string): PricingData | null {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  const { type, message } = json as { type?: unknown; message?: unknown };
  if (type !== "pricing" || typeof message !== "string" || message.length > 4096) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(message)) return null;
  return decodePricing(Buffer.from(message, "base64"));
}

/** What the desk is handed: the newest frame of a symbol, its price rounded to 4 places. */
export interface StreamQuote {
  symbol: string;
  price: number;
  /** The frame's own time (epoch ms): the quote's time. */
  at: number;
  /** The regular session (`marketHours == 1`): only these are quotes that can be traded at. */
  regular: boolean;
  /** The day's change in the same currency (`price - change` is the previous close), when sent. */
  change: number | null;
}

/** Prices are float32 on the wire: 4 places is finer than any ticker's tick. */
export const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** What the stream needs of a WebSocket (Node's global one, or a test's). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (ev: unknown) => void,
  ): void;
}
export type SocketCtor = new (url: string) => SocketLike;

const OPEN = 1;

export interface StreamConfig {
  /** The streamer's host; the only one ever called. */
  host: string;
  /** No frame at all for this long while streaming: unhealthy, and the connection is opened again. */
  unhealthy_ms: number;
}

export interface StreamStatus {
  /** It is wanted now (US tickers, the market about to open or open). */
  active: boolean;
  connected: boolean;
  healthy: boolean;
  /** When the last frame came (epoch ms), any symbol. */
  last_frame_at: number | null;
  symbols: number;
}

export interface YahooStreamOptions {
  config: StreamConfig;
  now: () => number;
  /** The WebSocket class; default Node's global one (none: the stream never connects). */
  socket?: SocketCtor | null;
  /** A batch is handed on at most this often (ms). */
  flushMs?: number;
  /** Backoff after a drop: from `baseMs`, doubling, at most `maxMs`, times 0.5–1 for jitter. */
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
  log?: (what: string, detail?: Record<string, unknown>) => void;
}

/** One frame per `FLUSH_MS` per symbol at most (the newest). */
export const FLUSH_MS = 1_000;
const BASE_MS = 1_000;
const MAX_MS = 60_000;

const globalSocket = (): SocketCtor | null =>
  (globalThis as { WebSocket?: SocketCtor }).WebSocket ?? null;

export class YahooStream {
  readonly #o: Required<Omit<YahooStreamOptions, "socket" | "log">> & {
    socket: SocketCtor | null;
    log: NonNullable<YahooStreamOptions["log"]>;
  };
  #listener: ((quotes: StreamQuote[]) => void) | null = null;
  #symbols: string[] = [];
  #active = false;
  #stopped = false;
  #ws: SocketLike | null = null;
  #openedAt: number | null = null;
  #createdAt = 0;
  #lastFrame: number | null = null;
  /** When each symbol's last regular-session frame came (receive time). */
  readonly #regular = new Map<string, number>();
  readonly #pending = new Map<string, StreamQuote>();
  #flush: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #attempts = 0;

  constructor(options: YahooStreamOptions) {
    if (!/^[a-z0-9.-]+$/i.test(options.config.host))
      throw new Error("yahoo stream: a host name, nothing else");
    this.#o = {
      config: options.config,
      now: options.now,
      socket: options.socket === undefined ? globalSocket() : options.socket,
      flushMs: options.flushMs ?? FLUSH_MS,
      baseMs: options.baseMs ?? BASE_MS,
      maxMs: options.maxMs ?? MAX_MS,
      random: options.random ?? Math.random,
      log: options.log ?? (() => undefined),
    };
  }

  /** Where batches go (the desk). */
  listen(fn: (quotes: StreamQuote[]) => void): void {
    this.#listener = fn;
  }

  /**
   * What to stream and whether to now (the desk asks at every pass): connects, subscribes what
   * was added, unsubscribes what went, closes when not wanted, and opens again a connection that
   * went quiet for `unhealthy_ms`.
   */
  update(symbols: readonly string[], active: boolean): void {
    if (this.#stopped) return;
    const next = [...new Set(symbols)].sort();
    const was = this.#symbols;
    this.#symbols = next;
    this.#active = active && next.length > 0 && this.#o.socket !== null;
    if (!this.#active) {
      this.#close();
      this.#cancelRetry();
      this.#attempts = 0;
      return;
    }
    const ws = this.#ws;
    if (ws === null) {
      if (this.#retry === undefined) this.#connect();
      return;
    }
    const now = this.#o.now();
    const quiet = this.#o.config.unhealthy_ms;
    if (ws.readyState !== OPEN) {
      // The subscription goes out when it opens; one that never opens is tried again.
      if (now - this.#createdAt >= quiet) this.#drop();
      return;
    }
    if (
      this.#openedAt !== null &&
      now - this.#openedAt >= quiet &&
      (this.#lastFrame === null || now - this.#lastFrame >= quiet)
    ) {
      this.#o.log("yahoo stream: quiet, opening it again", { quiet_ms: quiet });
      this.#drop();
      return;
    }
    const gone = was.filter((s) => !next.includes(s));
    if (gone.length > 0) {
      for (const s of gone) {
        this.#regular.delete(s);
        this.#pending.delete(s);
      }
      this.#send({ unsubscribe: gone });
    }
    if (next.some((s) => !was.includes(s))) this.#send({ subscribe: next });
  }

  /** Connected, and a frame came within `unhealthy_ms`. */
  healthy(now = this.#o.now()): boolean {
    return (
      this.#active &&
      this.#ws?.readyState === OPEN &&
      this.#lastFrame !== null &&
      now - this.#lastFrame < this.#o.config.unhealthy_ms
    );
  }

  /** The stream is healthy and `symbol` had a regular-session frame within `unhealthy_ms`. */
  covers(symbol: string, now = this.#o.now()): boolean {
    const at = this.#regular.get(symbol);
    return at !== undefined && now - at < this.#o.config.unhealthy_ms && this.healthy(now);
  }

  status(now = this.#o.now()): StreamStatus {
    return {
      active: this.#active,
      connected: this.#ws?.readyState === OPEN,
      healthy: this.healthy(now),
      last_frame_at: this.#lastFrame,
      symbols: this.#symbols.length,
    };
  }

  /** Closes everything; no timer is left. */
  stop(): void {
    this.#stopped = true;
    this.#active = false;
    this.#close();
    this.#cancelRetry();
    if (this.#flush !== undefined) clearTimeout(this.#flush);
    this.#flush = undefined;
    this.#pending.clear();
  }

  #connect(): void {
    const Ctor = this.#o.socket;
    if (Ctor === null || this.#stopped) return;
    let ws: SocketLike;
    try {
      ws = new Ctor(`wss://${this.#o.config.host}/?version=2`);
    } catch (error) {
      this.#o.log("yahoo stream: cannot connect", { err: String(error) });
      this.#later();
      return;
    }
    this.#ws = ws;
    this.#openedAt = null;
    this.#createdAt = this.#o.now();
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      this.#openedAt = this.#o.now();
      this.#send({ subscribe: this.#symbols });
    });
    ws.addEventListener("message", (ev) => {
      if (this.#ws !== ws) return;
      this.#take((ev as { data?: unknown }).data);
    });
    const ended = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#openedAt = null;
      this.#regular.clear();
      if (this.#active && !this.#stopped) this.#later();
    };
    ws.addEventListener("close", ended);
    ws.addEventListener("error", () => {
      if (this.#ws !== ws) return;
      this.#o.log("yahoo stream: socket error");
      try {
        ws.close();
      } catch {
        // already closing
      }
      ended();
    });
  }

  #take(data: unknown): void {
    const text =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
            : null;
    if (text === null || text.length > 16_384) return;
    const p = decodeFrame(text);
    if (p === null || !this.#symbols.includes(p.id)) return;
    const now = this.#o.now();
    this.#lastFrame = now;
    this.#attempts = 0;
    const regular = p.marketHours === 1;
    if (regular) this.#regular.set(p.id, now);
    const quote: StreamQuote = {
      symbol: p.id,
      price: round4(p.price),
      at: p.time,
      regular,
      change: p.change === null || !Number.isFinite(p.change) ? null : round4(p.change),
    };
    const held = this.#pending.get(p.id);
    if (held && held.at > quote.at) return; // never an older one over a newer one
    this.#pending.set(p.id, quote);
    if (this.#flush === undefined) {
      this.#flush = setTimeout(() => this.#hand(), this.#o.flushMs);
      this.#flush.unref?.();
    }
  }

  #hand(): void {
    this.#flush = undefined;
    if (this.#pending.size === 0 || this.#stopped) return;
    const batch = [...this.#pending.values()];
    this.#pending.clear();
    try {
      this.#listener?.(batch);
    } catch (error) {
      this.#o.log("yahoo stream: the desk could not take a batch", { err: String(error) });
    }
  }

  #send(body: { subscribe?: string[]; unsubscribe?: string[] }): void {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== OPEN) return;
    try {
      ws.send(JSON.stringify(body));
    } catch (error) {
      this.#o.log("yahoo stream: cannot send", { err: String(error) });
    }
  }

  /** Closes the connection on purpose (no reconnect from its close event). */
  #close(): void {
    const ws = this.#ws;
    this.#ws = null;
    this.#openedAt = null;
    this.#regular.clear();
    if (ws === null) return;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  /** Closes a connection that went quiet and opens it again after the backoff. */
  #drop(): void {
    this.#close();
    this.#later();
  }

  #later(): void {
    this.#cancelRetry();
    if (this.#stopped || !this.#active) return;
    const wait =
      Math.min(this.#o.maxMs, this.#o.baseMs * 2 ** this.#attempts) *
      (0.5 + 0.5 * this.#o.random());
    this.#attempts = Math.min(this.#attempts + 1, 30);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      if (this.#active && !this.#stopped && this.#ws === null) this.#connect();
    }, wait);
    this.#retry.unref?.();
  }

  #cancelRetry(): void {
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
  }
}
