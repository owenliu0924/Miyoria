// The Taiwan Stock Exchange's own public quote feed as the Taiwan quote provider (owner 2026-11-23).
// Yahoo's Taiwan data is about 20 minutes late, so with `quote_max_age_seconds` at 300 every Yahoo
// Taiwan quote is stale and the market never trades; this feed answered seconds old on the first
// Taiwan session. Written against an answer actually observed (`test/fixtures/twse-*.json`):
//
//     GET https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw|otc_6488.tw&json=1&delay=0
//     → { msgArray: [{ c, ex, n, z, trade: { t, z, v }, b, a, o, h, l, y, v, u, w, d, t, tlong }], rtcode }
//
// `c` the code, `ex` `tse` (listed, `.TW`) or `otc` (TPEx, `.TWO`), `z` the last trade price ("-"
// when the latest snapshot has no trade, often between matches), `trade` the latest trade when
// present, `b` / `a` the best five bids / asks joined by `_`, `y` the previous close, `u` / `w` the
// day's limit up / down, `d` the date (`YYYYMMDD`), `t` the snapshot's time and `tlong` the same in
// epoch ms. The answer starts with blank lines; an unknown symbol comes back as an entry without a
// code. Several symbols per request (at most `max_symbols`), a generic browser user agent, no
// cookies, no account, nothing about who asks; a daily request budget; exponential backoff on 429,
// 5xx and no answer; never a redirect. Anything unparseable or absurd is no quote.
//
// The price: `z` when it is a number; else the latest trade `trade.z`; else, only when both the best
// bid and the best ask are numbers, their midpoint rounded to the tick; else no quote. Its time: the
// snapshot's (`tlong`); the trade's own time only when the snapshot falls in a call auction. A snapshot
// dated before today (Taipei) is the last session's: a close, never a quote. One taken before 09:00
// (the pre-open trial matching) or in the closing call auction (13:25–13:30, nothing trades) gives
// no price either: only its previous close is kept, to show.
//
// `TaiwanQuotes` puts it in front of Yahoo for the Taiwan market: quotes from here, and from Yahoo
// only for what this feed could not answer (it failed, or does not know the symbol); lookups,
// names and charts stay Yahoo's.

import type { Candle, Timeframe } from "./candles.js";
import type { QuoteProvider, RawQuote } from "./provider.js";
import type { YahooQuote } from "./yahoo.js";

export interface TwseConfig {
  /** The host; the only one ever called. */
  host: string;
  /** Requests per Taipei day at most; past it, no request until the next day. */
  daily_budget: number;
  timeout_ms: number;
  max_backoff_seconds: number;
  /** Symbols per request at most. */
  max_symbols: number;
}

export const DEFAULT_TWSE: TwseConfig = {
  host: "mis.twse.com.tw",
  daily_budget: 3000,
  timeout_ms: 5000,
  max_backoff_seconds: 900,
  max_symbols: 50,
};

/** A generic browser user agent: nothing about who asks. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_BYTES = 1_000_000;
const TAIPEI_MS = 8 * 3_600_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One symbol as the feed answered it. `regular`: a price of today's session (the desk still checks
 * its time against the session); `prev_only`: no price today yet, `price` is the previous close
 * (kept to show as the last session's close, never traded at). Neither: a close of an earlier day.
 */
export interface TwseQuote extends RawQuote {
  regular: boolean;
  prev_only: boolean;
  /** Where the price came from. */
  from: "last" | "trade" | "mid" | "prev";
  /** The snapshot's date, `YYYY-MM-DD`. */
  date: string;
}

/** `2330.TW` → `tse_2330.tw`, `6488.TWO` → `otc_6488.tw`; `null` for anything else. */
export function twseChannel(symbol: string): string | null {
  const m = /^([0-9A-Z]{4,6})\.(TW|TWO)$/.exec(symbol);
  if (!m) return null;
  return `${m[2] === "TWO" ? "otc" : "tse"}_${(m[1] as string).toLowerCase()}.tw`;
}

/** The feed's code and board back as a symbol: `tse` + `2330` → `2330.TW`. */
function symbolOf(code: unknown, ex: unknown): string | null {
  if (typeof code !== "string" || !/^[0-9A-Za-z]{4,6}$/.test(code)) return null;
  if (ex === "tse") return `${code.toUpperCase()}.TW`;
  if (ex === "otc") return `${code.toUpperCase()}.TWO`;
  return null;
}

/** A number the feed wrote as a string (`"2010.0000"`); "-", "" and anything odd are `null`. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The first level of a `_`-joined book (`"2005.0000_2000.0000_"` → 2005). */
function best(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = num(v.split("_")[0]);
  return n !== null && n > 0 ? n : null;
}

/** `20261123` → `2026-11-23`. */
function dateOf(d: unknown): string | null {
  if (typeof d !== "string" || !/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** A Taipei date and `HH:MM:SS` as epoch ms. */
function timeOn(date: string, hms: unknown): number | null {
  if (typeof hms !== "string") return null;
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(hms);
  if (!m) return null;
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (h > 23 || mi > 59 || s > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s) - TAIPEI_MS;
}

/** Today's date in Taipei. */
export function taipeiDate(ms: number): string {
  return new Date(ms + TAIPEI_MS).toISOString().slice(0, 10);
}

/** Minutes after Taipei midnight. */
function taipeiMinutes(ms: number): number {
  const d = new Date(ms + TAIPEI_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * The tick of a Taiwan price (TWSE and TPEx since 2020): ETFs (codes starting `00`) 0.01 below 50,
 * else 0.05; stocks 0.01 below 10, 0.05 below 50, 0.1 below 100, 0.5 below 500, 1 below 1000, else 5.
 */
export function tickOf(code: string, price: number): number {
  if (code.startsWith("00")) return price < 50 ? 0.01 : 0.05;
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

/** `x` rounded to the tick of `code` at that price, without float dust. */
export function roundToTick(code: string, x: number): number {
  const tick = tickOf(code, x);
  return Math.round(Math.round(x / tick) * tick * 100) / 100;
}

/**
 * One `msgArray` entry, or `null` when it is not a quote at all (an unknown symbol, a missing
 * field, an absurd number). `now` decides what today is.
 */
export function parseTwseItem(item: unknown, now: number): TwseQuote | null {
  if (item === null || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const symbol = symbolOf(r.c, r.ex);
  const date = dateOf(r.d);
  if (symbol === null || date === null) return null;
  const code = symbol.split(".")[0] as string;
  const prev = num(r.y);
  if (prev === null || prev <= 0 || prev > 1e7) return null;
  const up = num(r.u);
  const down = num(r.w);
  // Inside the day's limits (when the feed gives them; a cent of rounding), and sane at all.
  const sane = (p: number | null): p is number =>
    p !== null &&
    p > 0 &&
    p < 1e7 &&
    (up === null || up <= 0 || p <= up + 0.01) &&
    (down === null || down <= 0 || p >= down - 0.01);
  const tlong = num(r.tlong);
  const snapshot =
    tlong !== null && tlong > 0 && taipeiDate(tlong) === date ? tlong : timeOn(date, r.t);
  if (snapshot === null || snapshot > now + 60_000) return null;
  // No trades before the open (trial matching) nor in the closing call auction.
  const trial = (ms: number) => {
    const m = taipeiMinutes(ms);
    return m < 9 * 60 || (m >= 13 * 60 + 25 && m < 13 * 60 + 30);
  };
  const trade =
    r.trade !== null && typeof r.trade === "object" ? (r.trade as Record<string, unknown>) : null;
  let price: number | null = null;
  let at: number | null = null;
  let from: TwseQuote["from"] = "prev";
  const last = num(r.z);
  const tradeAt = trade ? timeOn(date, trade.t) : null;
  const tradePrice = trade ? num(trade.z) : null;
  if (sane(last) && !trial(snapshot)) {
    price = last;
    at = snapshot;
    from = "last";
  } else if (sane(tradePrice) && (tradeAt === null || !trial(tradeAt))) {
    price = tradePrice;
    // The book is live at the snapshot: the last match is still the price, however long ago it
    // was, so a thinly traded stock does not go stale between trades.
    at = trial(snapshot) ? (tradeAt ?? snapshot) : snapshot;
    from = "trade";
  } else if (!trial(snapshot)) {
    const bid = best(r.b);
    const ask = best(r.a);
    if (bid !== null && ask !== null && bid < ask && ask / bid - 1 < 0.1) {
      const mid = roundToTick(code, (bid + ask) / 2);
      if (sane(mid)) {
        price = Math.min(ask, Math.max(bid, mid));
        at = snapshot;
        from = "mid";
      }
    }
  }
  if (at !== null && at > now + 60_000) return null;
  const today = date === taipeiDate(now);
  if (price === null || at === null)
    return {
      symbol,
      price: prev,
      at: snapshot,
      prev_close: prev,
      regular: false,
      prev_only: today,
      from: "prev",
      date,
    };
  return { symbol, price, at, prev_close: prev, regular: today, prev_only: false, from, date };
}

/** A whole answer: each asked symbol it gives a quote of (an unknown one is simply missing). */
export function parseTwse(text: string, now: number): Map<string, TwseQuote> {
  const json = JSON.parse(text.trim()) as unknown;
  const list = (json as { msgArray?: unknown } | null)?.msgArray;
  if (!Array.isArray(list)) throw new Error("twse: not a quote answer");
  const out = new Map<string, TwseQuote>();
  for (const item of list) {
    const q = parseTwseItem(item, now);
    if (q) out.set(q.symbol, q);
  }
  return out;
}

export class TwseProvider implements QuoteProvider {
  readonly id = "twse";
  readonly #c: TwseConfig;
  readonly #fetch: Fetch;
  #day = "";
  #used = 0;
  #failures = 0;
  #notBefore = 0;
  /** The last thing that went wrong (the owner's panel shows it). */
  lastError: string | null = null;

  constructor(config: TwseConfig = DEFAULT_TWSE, fetch: Fetch = globalThis.fetch.bind(globalThis)) {
    if (!/^[a-z0-9.-]+$/i.test(config.host)) throw new Error("twse: a host name, nothing else");
    this.#c = config;
    this.#fetch = fetch;
  }

  /** Requests made today (Taipei). */
  get used(): number {
    return this.#used;
  }

  /** Today's quotes only (a close of an earlier day or no price yet is not a quote). */
  async quotes(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, RawQuote>> {
    const out = new Map<string, RawQuote>();
    for (const [s, q] of await this.snapshot(symbols, now, signal)) if (q.regular) out.set(s, q);
    return out;
  }

  /**
   * Everything the feed says of each symbol, in chunks of `max_symbols`. A chunk that fails leaves
   * its symbols out (and stops the rest: the feed is backing off); throws only when nothing at all
   * came back. Symbols that are not Taiwan tickers are never asked.
   */
  async snapshot(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, TwseQuote>> {
    const asked = [...new Set(symbols)].filter((s) => twseChannel(s) !== null);
    const out = new Map<string, TwseQuote>();
    if (asked.length === 0) return out;
    let failed: unknown = null;
    for (let i = 0; i < asked.length; i += this.#c.max_symbols) {
      const chunk = asked.slice(i, i + this.#c.max_symbols);
      try {
        this.#spend(now);
        const got = parseTwse(await this.#get(chunk, signal), now);
        for (const s of chunk) {
          const q = got.get(s);
          if (q) out.set(s, q);
        }
        this.#failures = 0;
      } catch (error) {
        failed = error;
        if ((error as { backoff?: boolean }).backoff) this.#backOff(now);
        this.lastError = String(error instanceof Error ? error.message : error);
        break;
      }
    }
    if (failed === null) {
      const missing = asked.filter((s) => !out.has(s));
      this.lastError = missing.length > 0 ? `沒有讀到:${missing.join("、")}` : null;
    } else if (out.size === 0) throw failed;
    return out;
  }

  /** Starts a new Taipei day's count; throws while backing off or past the day's budget. */
  #spend(now: number): void {
    const day = taipeiDate(now);
    if (day !== this.#day) {
      this.#day = day;
      this.#used = 0;
    }
    if (now < this.#notBefore) throw new Error("twse: backing off");
    if (this.#used >= this.#c.daily_budget)
      throw new Error("twse: the day's request budget is spent");
    this.#used++;
  }

  #backOff(now: number): void {
    this.#failures++;
    this.#notBefore = now + Math.min(this.#c.max_backoff_seconds, 15 * 2 ** this.#failures) * 1000;
  }

  /** One GET of a chunk: the text, or a throw (429, 5xx and no answer marked to back off). */
  async #get(chunk: readonly string[], signal?: AbortSignal): Promise<string> {
    const ex = chunk.map((s) => twseChannel(s) as string).join("|");
    const url = `https://${this.#c.host}/stock/api/getStockInfo.jsp?ex_ch=${ex}&json=1&delay=0`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#c.timeout_ms);
    try {
      const res = await this.#fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        redirect: "error",
        referrerPolicy: "no-referrer",
        credentials: "omit",
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500)
        throw Object.assign(new Error(`twse: HTTP ${res.status}`), { backoff: true });
      if (!res.ok) throw new Error(`twse: HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error("twse: the answer is too big");
      return text;
    } catch (error) {
      // A network failure, a refused redirect or a timeout backs off like a 429.
      if (!(error instanceof Error) || !/^twse: /.test(error.message))
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          backoff: true,
        });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** What `TaiwanQuotes` falls back on: Yahoo (its quotes, its lookups' answers, its charts). */
export type TaiwanFallback = QuoteProvider & {
  describe?: (
    s: readonly string[],
    now: number,
    signal?: AbortSignal,
  ) => Promise<Map<string, YahooQuote>>;
  candles?: (symbol: string, tf: Timeframe, now: number, signal?: AbortSignal) => Promise<Candle[]>;
  lastError?: string | null;
};

/**
 * Taiwan quotes from the exchange's feed, Yahoo for whatever it could not answer: the feed failed
 * (an outage, a backoff, the budget) or does not know the symbol. A symbol the feed knows but has
 * no price of yet is not asked of Yahoo (Yahoo's is older still). Charts are Yahoo's.
 */
export class TaiwanQuotes implements QuoteProvider {
  readonly id = "twse";

  constructor(
    readonly twse: TwseProvider,
    readonly fallback: TaiwanFallback,
  ) {}

  get lastError(): string | null {
    return this.twse.lastError;
  }

  async #feed(symbols: readonly string[], now: number, signal?: AbortSignal) {
    try {
      return { got: await this.twse.snapshot(symbols, now, signal), failed: null as unknown };
    } catch (error) {
      return { got: new Map<string, TwseQuote>(), failed: error };
    }
  }

  async quotes(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, RawQuote>> {
    const { got, failed } = await this.#feed(symbols, now, signal);
    const out = new Map<string, RawQuote>();
    for (const [s, q] of got) if (q.regular) out.set(s, q);
    const rest = symbols.filter((s) => !got.has(s));
    if (rest.length === 0) return out;
    try {
      for (const [s, q] of await this.fallback.quotes(rest, now, signal)) out.set(s, q);
    } catch (error) {
      if (got.size === 0) throw failed ?? error;
    }
    return out;
  }

  /** Everything known of each symbol (the desk keeps closes from it): the feed's, else Yahoo's. */
  async describe(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, TwseQuote | YahooQuote | RawQuote>> {
    const { got, failed } = await this.#feed(symbols, now, signal);
    const out = new Map<string, TwseQuote | YahooQuote | RawQuote>(got);
    const rest = symbols.filter((s) => !got.has(s));
    if (rest.length === 0) return out;
    try {
      const more = this.fallback.describe
        ? await this.fallback.describe(rest, now, signal)
        : await this.fallback.quotes(rest, now, signal);
      for (const [s, q] of more) out.set(s, q);
    } catch (error) {
      if (got.size === 0) throw failed ?? error;
    }
    return out;
  }

  /** Charts stay Yahoo's. */
  async candles(
    symbol: string,
    tf: Timeframe,
    now: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    if (!this.fallback.candles) throw new Error("twse: no charts");
    return this.fallback.candles(symbol, tf, now, signal);
  }
}
