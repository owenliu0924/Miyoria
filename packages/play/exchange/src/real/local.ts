// The five local stocks tied to her (owner 2026-11-21: back as the beginners' recommendation), as
// one more quote provider, so they trade in the same order flow as everything else: market orders,
// the same fee and caps, the house as counterparty, shares, priced directly in fish coins.
//
// The price: a tick every `local_tick_seconds` (60 by default; owner 2026-11-22: "as fast as the
// real ones") from 12:00 to 23:00 Taipei, every day (661 ticks at 60 s; 12 at 3600 s, the hourly
// cadence before). Each tick is a mean-reverting walk with the company's own temperament (the
// feeding and silence stocks calm, the model stock jumpy) towards its anchor (config
// `local_companies.<role>.anchor`, about 100 coins: owner 2026-11-21, cheap enough that a whole
// share is affordable), seeded and reproducible from the market's seed and the tick's time. The
// temperaments were tuned for the hourly model; a faster cadence scales each step (`cadenceOf`) so a
// day comes out the same: the same variance and pull of a day, the same ±10% band, the same gap.
// A hard ±10% daily limit from the previous day's last tick. Soft bounds: outside 0.7×–1.4× of the
// anchor the pull back grows, and 0.5×–2× is a hard floor and ceiling, so a local stock never drifts
// to pennies or to thousands (the simulated year in `test/local.test.ts` shows the range).
//
// Her real things (feedings, songs finished, silent hours, game goals and deaths, her model API
// errors and slow calls: one role each, RICE WHLE NAPS CUBE DPSK by default) move it by at most
// ±3% a day:
// the signal is the LAST COMPLETED Taipei day's count against that company's own trailing
// baseline (`signals.ts`, counted from the event log by `sources.ts`), and the whole move lands as
// a gap at the day's first tick (12:00). Every order placed before then fills at a price that
// already has it, so nothing a member does today can be traded on at a known price today. The
// offline checks (`test/local.test.ts`, `test/signals.test.ts`) show that feeding her to push
// the feeding stock, buying and selling loses money once the feedings and the fee are counted, and that causing
// model errors never pays. No leverage on these, no treasury, no rounds, no news deck.
//
// Every tick is kept before it is used, and a restart continues from the last one kept: ticks
// missed while Core was not running are worked out the same way (the seed, the tick's time, the
// state before it), so the series never depends on whether Core was running, and two instances on
// the same database give the same prices.

import { rngFor } from "../engine/rng.js";
import { DEFAULT_SESSIONS, isOpenAt } from "./instruments.js";
import type { QuoteProvider, RawQuote } from "./provider.js";

/**
 * The five local stocks by what moves them (docs/design/v5-profiles.md): the logic (signals,
 * directions, temperaments, sources) is keyed by role; each role's code, name, anchor and words are
 * the profile's (`[modules.exchange.local_companies.<role>]`), today's by default. In this order.
 */
export const LOCAL_ROLES = ["feeding", "songs", "silence", "game", "model"] as const;
export type LocalRole = (typeof LOCAL_ROLES)[number];

/** What a profile may name of a role's stock: the first character's companies by default. */
export interface LocalIdentity {
  /** The ticker people type: four capital letters. */
  code: string;
  /** Its zh-TW name. */
  name: string;
  /** Its first price and the level its walk returns to, in coins. */
  anchor: number;
}

/** Miyoria's five companies: every default of `[modules.exchange.local_companies]`. */
export const DEFAULT_LOCAL: Readonly<Record<LocalRole, LocalIdentity>> = {
  feeding: { code: "RICE", name: "白飯食品", anchor: 100 },
  songs: { code: "WHLE", name: "鯨落唱片", anchor: 108 },
  silence: { code: "NAPS", name: "打盹床業", anchor: 88 },
  game: { code: "CUBE", name: "方塊礦業", anchor: 116 },
  model: { code: "DPSK", name: "DipSick AI", anchor: 94 },
};

/** A role's stock as the running profile names it. */
export interface LocalCompany extends LocalIdentity {
  role: LocalRole;
  /** What moves it, in one plain sentence (the 新手推薦 section). */
  what_moves: string;
  /** One line for the old local market's company page. */
  blurb: string;
}

/** `name` then `rest`, with a space after a name that ends in a Latin letter or digit. */
const joined = (name: string, rest: string) =>
  `${name}${/[A-Za-z0-9]$/.test(name) ? " " : ""}${rest}`;

/** What moves a role's stock called `name`, about her (`pronoun`). */
export function whatMovesOf(role: LocalRole, name: string, pronoun = "她"): string {
  switch (role) {
    case "feeding":
      return `大家多餵${pronoun},${joined(name, "就容易漲")}`;
    case "songs":
      return `${pronoun}唱完的歌越多,${joined(name, "越好")}`;
    case "silence":
      return `${pronoun}安靜不說話的時間越長,${joined(name, "越好")}`;
    case "game":
      return `${pronoun}在遊戲裡達成目標就漲,死掉就跌`;
    case "model":
      return `${pronoun}的模型出錯變多,${joined(name, "就跌")}`;
  }
}

/** The old local market's line for a role's company. */
export function blurbOf(role: LocalRole, pronoun = "她"): string {
  switch (role) {
    case "feeding":
      return "穩,大家每天都要吃飯";
    case "songs":
      return "跟著新歌起伏";
    case "silence":
      return "最穩的一家";
    case "game":
      return "景氣循環,偶爾出事故";
    case "model":
      return `${pronoun}的老家。波動大,消息多`;
  }
}

/** The configured identity of one role (`code`, `name`, `anchor`, optional words). */
export interface LocalCompanyInput {
  code: string;
  name: string;
  anchor?: number | undefined;
  what_moves?: string | undefined;
  blurb?: string | undefined;
}

/**
 * The five stocks as the profile names them, in role order. `legacyAnchors` is the old
 * `local_anchors` table, keyed by the first character's codes: it gives a role's anchor when its
 * own `anchor` is not set.
 */
export function resolveLocal(
  companies: Readonly<Record<LocalRole, LocalCompanyInput>>,
  legacyAnchors: Readonly<Partial<Record<string, number>>> = {},
  pronoun = "她",
): LocalCompany[] {
  return LOCAL_ROLES.map((role) => {
    const c = companies[role];
    return {
      role,
      code: c.code,
      name: c.name,
      anchor: c.anchor ?? legacyAnchors[DEFAULT_LOCAL[role].code] ?? DEFAULT_LOCAL[role].anchor,
      what_moves: c.what_moves ?? whatMovesOf(role, c.name, pronoun),
      blurb: c.blurb ?? blurbOf(role, pronoun),
    };
  });
}

/** A role's stock: its role (the logic) and its code (the walk's seed, the rows in the store). */
export interface LocalStock {
  role: LocalRole;
  code: string;
}

/**
 * A temperament in the hourly model: the walk's noise per hourly step and how fast it returns to
 * its base. Another cadence scales them (`cadenceOf`).
 */
export const TEMPER: Readonly<Record<LocalRole, { sigma: number; reversion: number }>> = {
  feeding: { sigma: 0.004, reversion: 0.03 },
  silence: { sigma: 0.003, reversion: 0.03 },
  songs: { sigma: 0.007, reversion: 0.02 },
  game: { sigma: 0.008, reversion: 0.02 },
  model: { sigma: 0.012, reversion: 0.015 },
};

/** Outside this band around the anchor the pull back is stronger; the outer one is a hard stop. */
export const SOFT_BAND = { lo: 0.7, hi: 1.4 } as const;
export const HARD_BAND = { lo: 0.5, hi: 2 } as const;
/** The extra pull per hourly step, per unit of log distance outside the soft band. */
const SOFT_PULL = 0.15;

/** The most a day's signal moves a price. */
export const SIGNAL_MAX = 0.03;
export const DAILY_LIMIT = 0.1;

/**
 * A completed day's signal of a company: in [-1, 1], already in the company's direction (+1 is the
 * full +`SIGNAL_MAX` gap; more model errors give the model stock a negative one). `signals.ts` makes it from
 * the day's count and the company's own baseline.
 */
export interface LocalSignal {
  signal: number;
}

/** The signal of a company for the completed Taipei day `day` (`null`: none, a neutral open). */
export type LocalSignals = (role: LocalRole, day: number) => LocalSignal | null;

/** Where the local stocks' signals come from (`signals.ts`'s `LocalSignalBook`). */
export interface LocalSignalFeed {
  /** The signal of a completed day, at once (`null`: neutral). */
  signal(role: LocalRole, day: number): LocalSignal | null;
  /** Readies the signals of these completed Taipei days. */
  prepare(days: readonly number[], now: number): Promise<void>;
  /** The card's plain line: what moved today's open of `role`'s stock (`null`: nothing known yet). */
  line(role: LocalRole, now: number, pronoun?: string): string | null;
}

/** The day's move from yesterday's signal: ±`SIGNAL_MAX` at most. */
export function signalMove(s: LocalSignal | null): number {
  if (!s || !Number.isFinite(s.signal)) return 0;
  return SIGNAL_MAX * Math.max(-1, Math.min(1, s.signal));
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The first and the last tick of a trading day, after Taipei midnight (12:00 and 23:00). */
const OPEN_MS = 12 * HOUR;
const LAST_MS = 23 * HOUR;

/** How often the local stocks tick by default (`[modules.exchange] local_tick_seconds`). */
export const DEFAULT_TICK_SECONDS = 60;
/**
 * The steps of a day in the hourly model the temperaments were tuned at (12:00 … 23:00, the night's
 * step to 12:00 included): every other cadence is scaled to give the same day.
 */
export const HOURLY_STEPS = 12;

/**
 * A cadence's numbers: the tick, the ticks of a day, and each step's reversion, noise and soft
 * pull, scaled from the hourly model so a day comes out the same (docs/design/exchange.md §9):
 * with `k = 12 / perDay` steps of the hourly model in one tick, the reversion compounds
 * (`1 − r' = (1 − r)^k`), the noise keeps the day's variance of the mean-reverting walk
 * (`σ'² = σ² (1 − (1 − r')²) / (1 − (1 − r)²)`, about `σ² k`), and the soft pull compounds like
 * the reversion. At 3600 s these are the hourly numbers themselves.
 */
export interface Cadence {
  tickMs: number;
  /** Ticks a trading day: 661 at 60 s, 12 at 3600 s. */
  perDay: number;
  temper: Readonly<Record<LocalRole, { sigma: number; reversion: number }>>;
  softPull: number;
}

const cadences = new Map<number, Cadence>();

/** The cadence of a tick every `tickSeconds` (10 … 3600). */
export function cadenceOf(tickSeconds: number): Cadence {
  const known = cadences.get(tickSeconds);
  if (known) return known;
  const tickMs = Math.round(tickSeconds * 1000);
  const perDay = Math.floor((LAST_MS - OPEN_MS) / tickMs) + 1;
  let c: Cadence;
  if (perDay === HOURLY_STEPS) c = { tickMs, perDay, temper: TEMPER, softPull: SOFT_PULL };
  else {
    const k = HOURLY_STEPS / perDay;
    const temper = Object.fromEntries(
      LOCAL_ROLES.map((role) => {
        const { sigma, reversion } = TEMPER[role];
        const a = 1 - reversion;
        const a2 = a ** k;
        return [role, { reversion: 1 - a2, sigma: sigma * Math.sqrt((1 - a2 * a2) / (1 - a * a)) }];
      }),
    ) as Record<LocalRole, { sigma: number; reversion: number }>;
    c = { tickMs, perDay, temper, softPull: 1 - (1 - SOFT_PULL) ** k };
  }
  cadences.set(tickSeconds, c);
  return c;
}

/** The hourly model (`local_tick_seconds = 3600`, the cadence before 2026-11-22). */
export const HOURLY = cadenceOf(3600);

/** The Taipei day number of `ms` (Taipei has no daylight saving): the local stocks' day. */
export const taipeiDay = (ms: number): number => Math.floor((ms + 8 * HOUR) / DAY);

/** The epoch ms window [start, end) of Taipei day `day`. */
export function taipeiDayWindow(day: number): { start: number; end: number } {
  const start = day * DAY - 8 * HOUR;
  return { start, end: start + DAY };
}

const dayStart = (day: number) => day * DAY - 8 * HOUR;

/** The first tick of Taipei day `day` (12:00). */
export const dayOpen = (day: number): number => dayStart(day) + OPEN_MS;

/** The last tick of Taipei day `day` (23:00, or the last one before it on the grid). */
export const dayLast = (day: number, c: Cadence): number =>
  dayOpen(day) + (c.perDay - 1) * c.tickMs;

/** Whether `t` is the first tick of its day (where yesterday's signal lands). */
export const isDayOpen = (t: number): boolean => t - dayStart(taipeiDay(t)) === OPEN_MS;

/** The latest tick at or before `ms`, whether or not the market is open now (the night: yesterday's last). */
export function tickAtOrBefore(ms: number, c: Cadence): number {
  const day = taipeiDay(ms);
  const off = ms - dayStart(day);
  if (off < OPEN_MS) return dayLast(day - 1, c);
  return dayOpen(day) + Math.min(c.perDay - 1, Math.floor((off - OPEN_MS) / c.tickMs)) * c.tickMs;
}

/** The tick at or before `ms` while the local stocks trade (12:00 … 23:00 Taipei), or `null` outside. */
export function lastTick(ms: number, tickSeconds = DEFAULT_TICK_SECONDS): number | null {
  if (!isOpenAt(DEFAULT_SESSIONS.local, ms)) return null;
  return tickAtOrBefore(ms, cadenceOf(tickSeconds));
}

/** The tick after `ms` (skipping the night). */
export function nextTickAfter(ms: number, tickSeconds = DEFAULT_TICK_SECONDS): number {
  return tickAfter(ms, cadenceOf(tickSeconds));
}

function tickAfter(ms: number, c: Cadence): number {
  const day = taipeiDay(ms);
  const off = ms - dayStart(day);
  if (off < OPEN_MS) return dayOpen(day);
  const k = Math.floor((off - OPEN_MS) / c.tickMs) + 1;
  return k < c.perDay ? dayOpen(day) + k * c.tickMs : dayOpen(day + 1);
}

export interface LocalState {
  /** The last tick's price (coins) and time, and the reference the day's band is measured from. */
  price: number;
  at: number;
  close: number;
}

/**
 * The price of `stock` at tick `t`, from the state at the tick before, around `anchor` (coins), in
 * cadence `c` (the hourly model unless given). Pure: the same seed, stock, tick, state, signal,
 * anchor and cadence give the same price. The walk is seeded by the code and the tick's time (a
 * stock's price history is its code's); its temperament and signal are its role's.
 */
export function nextPrice(
  seed: string,
  stock: LocalStock,
  t: number,
  prev: LocalState,
  signals: LocalSignals,
  anchor: number,
  c: Cadence = HOURLY,
): LocalState {
  const { role, code } = stock;
  const temper = c.temper[role];
  const first = isDayOpen(t);
  const ref = first ? prev.price : prev.close;
  const rng = rngFor(seed, "local", code, t);
  const base = Math.log(anchor);
  let ln = Math.log(prev.price);
  ln +=
    temper.reversion * (base - ln) +
    temper.sigma * rng.normal() -
    (temper.sigma * temper.sigma) / 2;
  // Soft bounds: the farther outside the band, the harder it is pulled back.
  const lo = base + Math.log(SOFT_BAND.lo);
  const hi = base + Math.log(SOFT_BAND.hi);
  if (ln < lo) ln += c.softPull * (lo - ln);
  if (ln > hi) ln -= c.softPull * (ln - hi);
  // Yesterday's whole signal lands at the day's first tick, as a gap, whatever the cadence.
  if (first) ln += signalMove(signals(role, taipeiDay(t) - 1));
  const floor = Math.max(ref * (1 - DAILY_LIMIT), anchor * HARD_BAND.lo);
  const ceiling = Math.min(ref * (1 + DAILY_LIMIT), anchor * HARD_BAND.hi);
  const price = Math.round(Math.min(ceiling, Math.max(floor, Math.exp(ln))) * 100) / 100;
  return { price, at: t, close: ref };
}

/** One tick of a local stock: its price, its time and the day's reference (yesterday's close). */
export interface LocalTick {
  at: number;
  price: number;
  close: number;
}

/** What a stock's last kept tick was (a restart continues from it). */
export interface StoredTick {
  price: number;
  at: number;
  prev_close: number | null;
}

export interface LocalProviderOptions {
  /** Seconds between ticks (`local_tick_seconds`, 10 … 3600); default 60. */
  tickSeconds?: number;
  /**
   * Keeps new ticks before they are used, a day's worth at a time and in order; a throw stops that
   * stock's advance there (the next call computes the same ticks again from what was kept).
   */
  record?: (code: string, ticks: readonly LocalTick[]) => void;
  /** At most this many days of ticks per stock per call; the rest on the next call. */
  catchUpDays?: number;
}

/** Days of missed ticks worked out per stock per call (a long downtime is caught up over several passes). */
export const CATCH_UP_DAYS = 31;
/** Days back the signals are read for (older days of a long downtime open neutral, as before). */
const SIGNAL_DAYS = 14;

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The local stocks as a provider: every tick from the last one kept to the latest one due, in
 * order, each kept (`record`) before it is used. The series depends only on the seed, the last
 * kept tick and the signals, never on when Core ran: missed ticks are worked out the same way,
 * a day at a time (yielding between days, at most `catchUpDays` days a call).
 */
export class LocalProvider implements QuoteProvider {
  readonly id = "local";
  readonly #state = new Map<string, LocalState>();
  readonly #c: Cadence;
  readonly #record: LocalProviderOptions["record"];
  readonly #catchUpDays: number;

  constructor(
    private readonly seed: string,
    private readonly signals: LocalSignals,
    /** The five stocks as the profile names them, with their anchors in coins. */
    private readonly stocks: () => readonly (LocalStock & { anchor: number })[],
    /** The last kept tick of a code (a restart continues from it). */
    private readonly stored: (code: string) => StoredTick | null,
    /**
     * Readies the signals of these completed Taipei days before the ticks that read them are
     * priced (the counts come from the event log, which is asynchronous). Optional: without it a
     * signal is whatever `signals` already has.
     */
    private readonly prepare?: (days: readonly number[], now: number) => Promise<void>,
    options: LocalProviderOptions = {},
  ) {
    this.#c = cadenceOf(options.tickSeconds ?? DEFAULT_TICK_SECONDS);
    this.#record = options.record;
    this.#catchUpDays = options.catchUpDays ?? CATCH_UP_DAYS;
  }

  get cadence(): Cadence {
    return this.#c;
  }

  /** The latest price of each symbol while the local stocks trade (nothing outside the hours). */
  async quotes(symbols: readonly string[], now: number): Promise<Map<string, RawQuote>> {
    const out = new Map<string, RawQuote>();
    await this.advance(symbols, now);
    if (lastTick(now, this.#c.tickMs / 1000) === null) return out;
    for (const symbol of symbols) {
      const st = this.#state.get(symbol);
      if (st) out.set(symbol, { symbol, price: st.price, at: st.at, prev_close: st.close });
    }
    return out;
  }

  /**
   * Works out every tick of each symbol from its last kept one up to the latest due at `now` (the
   * night: yesterday's last), a day at a time, at most `catchUpDays` days; each day is kept before
   * the next. The new ticks of each symbol, oldest first.
   */
  async advance(symbols: readonly string[], now: number): Promise<Map<string, LocalTick[]>> {
    const out = new Map<string, LocalTick[]>();
    const c = this.#c;
    const target = tickAtOrBefore(now, c);
    const stocks = this.stocks();
    for (const symbol of symbols) {
      const stock = stocks.find((s) => s.code === symbol);
      if (!stock) continue;
      const code = stock.code;
      let st = this.#state.get(code) ?? this.#fromStore(code, stock.anchor, now);
      const fresh: LocalTick[] = [];
      for (let days = 0; st.at < target && days < this.#catchUpDays; days++) {
        const first = tickAfter(st.at, c);
        if (first > target) break;
        const day = taipeiDay(first);
        const end = Math.min(target, dayLast(day, c));
        // Today's open reads yesterday: ready it (only the recent days, as the event log keeps them).
        if (this.prepare && isDayOpen(first) && day - 1 >= taipeiDay(now) - SIGNAL_DAYS) {
          try {
            await this.prepare([day - 1], now);
          } catch {
            // A source that cannot answer is a neutral open, never a failed quote.
          }
        }
        const ticks: LocalTick[] = [];
        let next = st;
        for (let t = first; t <= end; t += c.tickMs) {
          next = nextPrice(this.seed, stock, t, next, this.signals, stock.anchor, c);
          ticks.push({ at: next.at, price: next.price, close: next.close });
        }
        // Kept first: what is used is always what a restart would read back.
        this.#record?.(code, ticks);
        st = next;
        this.#state.set(code, st);
        fresh.push(...ticks);
        if (st.at < target) await yieldTurn();
      }
      out.set(code, fresh);
    }
    return out;
  }

  /** Forgets what is in memory (the next call reads the kept ticks again). */
  reset(): void {
    this.#state.clear();
  }

  #fromStore(code: string, anchor: number, now: number): LocalState {
    const s = this.stored(code);
    if (s) {
      const st = { price: s.price, at: s.at, close: s.prev_close ?? s.price };
      this.#state.set(code, st);
      return st;
    }
    // Never priced (a new instance): from the anchor, from today's first tick (before 12:00:
    // nothing yet, the anchor is the opening reference).
    return { price: anchor, at: dayOpen(taipeiDay(now)) - 1, close: anchor };
  }
}
