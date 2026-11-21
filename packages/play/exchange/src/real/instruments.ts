// Real instruments (owner 2026-11-21): stocks and crypto whose price is a provider's quote. The list
// is config (`[[modules.exchange.instruments]]`): adding or removing a ticker needs no code. Each
// names its market (which hours it trades), its provider and the provider's symbol, its display
// name, a volatility class (which sets the most leverage it allows and how big a jump is believed
// without a second look) and how many coins one unit of its quote currency is worth.

export type MarketKind = "us" | "tw" | "crypto";
export type VolClass = "low" | "mid" | "high" | "crypto";

export interface RealInstrument {
  /** What people type: 2 to 10 capital letters or digits (`AAPL`, `2330`, `BTC`). */
  code: string;
  name: string;
  market: MarketKind;
  /** The provider's id (`[modules.exchange.providers]`) and its symbol for this instrument. */
  provider: string;
  symbol: string;
  vol: VolClass;
  /** Coins per unit of the quote's currency (1: one US dollar is one coin). */
  coins_per_unit: number;
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
