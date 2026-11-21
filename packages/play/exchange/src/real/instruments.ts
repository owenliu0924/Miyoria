// Real instruments (owner 2026-11-21, v1: Taiwan and US stocks; an ETF is a ticker like any other):
// the price is a provider's quote, in the instrument's own currency (TWD or USD), turned into fish
// coins by two fixed rates in config (`rates.ts`). The list is config
// (`[[modules.exchange.instruments]]`): adding or removing a ticker needs no code. Each names its
// market (which hours it trades), its provider and the provider's symbol (Yahoo: `2330.TW`,
// `6488.TWO`, `AAPL`) and its display name. `crypto` stays a market kind for later; v1 lists none.

export type MarketKind = "us" | "tw" | "crypto";

export interface RealInstrument {
  /** What people type: 2 to 10 capital letters or digits (`AAPL`, `2330`, `BTC`). */
  code: string;
  name: string;
  market: MarketKind;
  /** The provider's id (`[modules.exchange.providers]`) and its symbol for this instrument. */
  provider: string;
  symbol: string;
  /** Off: no new order; holdings stay and can be sold. */
  enabled: boolean;
}

/** A market's trading hours: its time zone, the sessions of a weekday, its closed dates. */
export interface Session {
  /** An IANA zone (`America/New_York`). */
  zone: string;
  /** `HH:MM` local opening and closing; `24h`: always open. */
  open: string;
  close: string;
  /** Trading weekdays, Sunday 0 .. Saturday 6. */
  days: number[];
  /** Closed dates in the zone, `YYYY-MM-DD` (holidays). */
  holidays: string[];
  always: boolean;
}

export const DEFAULT_SESSIONS: Readonly<Record<MarketKind, Session>> = {
  us: {
    zone: "America/New_York",
    open: "09:30",
    close: "16:00",
    days: [1, 2, 3, 4, 5],
    holidays: [],
    always: false,
  },
  tw: {
    zone: "Asia/Taipei",
    open: "09:00",
    close: "13:30",
    days: [1, 2, 3, 4, 5],
    holidays: [],
    always: false,
  },
  crypto: {
    zone: "UTC",
    open: "00:00",
    close: "24:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    holidays: [],
    always: true,
  },
};

const parts = new Map<string, Intl.DateTimeFormat>();

/** The date, weekday and minutes after midnight of `ms` in `zone`. */
export function zonedParts(
  ms: number,
  zone: string,
): { date: string; weekday: number; minutes: number } {
  let f = parts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    parts.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "");
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const minutesOf = (hhmm: string) => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

/** Whether the market of `session` is open at `ms`. */
export function isOpenAt(session: Session, ms: number): boolean {
  if (session.always) return true;
  const z = zonedParts(ms, session.zone);
  if (!session.days.includes(z.weekday) || session.holidays.includes(z.date)) return false;
  return z.minutes >= minutesOf(session.open) && z.minutes < minutesOf(session.close);
}

/** The trading date of `ms` in the session's zone (for the day's reference price). */
export function tradingDate(session: Session, ms: number): string {
  return zonedParts(ms, session.zone).date;
}

/** The currency a market quotes in. */
export function currencyOf(market: MarketKind): "TWD" | "USD" {
  return market === "tw" ? "TWD" : "USD";
}

/** Fixed rates (owner 2026-11-21): never fetched, never floating. */
export interface Rates {
  /** NT dollars per fish coin. */
  twd_per_coin: number;
  /** NT dollars per US dollar. */
  twd_per_usd: number;
}

/** A quoted price in coins: TWD ÷ twd_per_coin; USD × twd_per_usd ÷ twd_per_coin. */
export function toCoins(price: number, market: MarketKind, r: Rates): number {
  const twd = market === "tw" ? price : price * r.twd_per_usd;
  return twd / r.twd_per_coin;
}
