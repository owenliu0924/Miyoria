// Each person's AI quota (docs/design/v6-agent.md 「上限收成三種」): the model cost she spent for
// one person in a rolling hour and in her local day, against `[modules.agent.quota]`. A run that
// answers someone and a helper job someone asked for are charged to that person (`Payer`); her
// own initiative is charged to nobody and only the router's daily budget bounds it. The owner is
// charged too, so the numbers can be read, but never capped.
//
// One unit, USD: a call of a model with no price in `[llm.pricing]` is charged at
// `unpriced_usd_per_mtok` per million prompt and completion tokens.
//
// Kept per minute (for the rolling hour) and per day in a `QuotaBook` (the `quota` table), so a
// restart does not reset it; a person's rows are read the first time they are charged or checked.
//
// A capped stretch: from the first refusal of a person until they are under both limits again.
// One mark per stretch, so the fixed line is said once per stretch, not once per message.

import { callCost, type Pricing, type Usage } from "@miyoria/llm/llm";
import { serviceKey } from "@miyoria/types";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MINUTES_PER_HOUR = 60;
/** USD in the book: integers. */
const MICROS = 1_000_000;

/** The defaults of `[modules.agent.quota]`. */
export const QUOTA_DEFAULTS: QuotaRules = {
  usdPerHour: 3,
  usdPerDay: 10,
  unpricedUsdPerMtok: 1,
};

/** `[modules.agent.quota]` as the quota reads it; 0 in a limit: no such limit. */
export interface QuotaRules {
  usdPerHour: number;
  usdPerDay: number;
  /** What a million tokens of a model without a price cost. */
  unpricedUsdPerMtok: number;
}

/** Whom a run's model calls are charged to. */
export interface Payer {
  /** The person's key: their person id, else their account (`personKey` of the host). */
  person: string;
  /** The owner: charged, never capped. */
  exempt?: boolean;
}

/** What a person used (USD). */
export interface QuotaUse {
  hour: number;
  day: number;
}

/** A person at a limit. */
export interface QuotaCap {
  which: "hour" | "day";
  used: QuotaUse;
  /** The limit of `which`. */
  limit: number;
  /** When they are under it again if nothing more is spent. */
  until: number;
  /** The first refusal of this stretch: marked now. */
  first: boolean;
}

/** Her day: its key and when the next one starts. */
export interface QuotaDay {
  key: string;
  endsAt: number;
}

/** UTC days, for a host without her local clock. */
export function utcQuotaDay(now: number): QuotaDay {
  const start = Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS;
  return { key: new Date(start).toISOString().slice(0, 10), endsAt: start + 24 * HOUR_MS };
}

/** Where the quota is kept across restarts. Amounts are micro-USD. */
export interface QuotaBook {
  /** Adds `micros` to `person`'s minute `minute` (epoch minutes) and to their day `day`. */
  add(person: string, minute: number, day: string, micros: number, at: number): void;
  /** `person`'s minutes from `sinceMinute` on, and their total of `day`. */
  load(
    person: string,
    sinceMinute: number,
    day: string,
  ): { minutes: [number, number][]; day: number };
  /** Everyone's totals of `day`, the largest first. */
  dayTotals(day: string): { person: string; micros: number }[];
  /** Drops minutes before `beforeMinute` and days other than `keepDays`. */
  prune(beforeMinute: number, keepDays: readonly string[]): void;
}

/** The cost of one call from the router's price table, or `null` when `model` has no price. */
export function stepCost(
  prices: Record<string, Pricing> | undefined,
  model: string | null,
  usage: Usage,
): number | null {
  const price = model === null ? undefined : prices?.[model];
  return price === undefined ? null : callCost(price, usage);
}

/** The cost of a call in USD: its price, or tokens at the fallback rate when it has none. */
export function chargeOf(
  cost: number | null,
  usage: Pick<Usage, "prompt_tokens" | "completion_tokens">,
  unpricedUsdPerMtok: number,
): number {
  if (cost !== null) return Math.max(0, cost);
  const tokens = usage.prompt_tokens + usage.completion_tokens;
  return Math.max(0, (tokens * unpricedUsdPerMtok) / 1_000_000);
}

interface Ledger {
  /** Micro-USD by epoch minute, the last hour only. */
  minutes: Map<number, number>;
  day: string;
  dayMicros: number;
  /** The capped stretch, while there is one. */
  stretch: { noticed: boolean } | null;
}

export interface PersonQuotaOptions {
  rules: () => QuotaRules;
  /** Her day at `now`. Default: UTC days. */
  day?: (now: number) => QuotaDay;
  book?: QuotaBook | null;
  /** A book that failed: logged by the caller, the quota goes on in memory. */
  onError?: (what: string, error: unknown) => void;
}

export class PersonQuota {
  readonly #rules: () => QuotaRules;
  readonly #day: (now: number) => QuotaDay;
  readonly #book: QuotaBook | null;
  readonly #onError: (what: string, error: unknown) => void;
  readonly #people = new Map<string, Ledger>();
  #prunedAt = 0;

  constructor(options: PersonQuotaOptions) {
    this.#rules = options.rules;
    this.#day = options.day ?? utcQuotaDay;
    this.#book = options.book ?? null;
    this.#onError = options.onError ?? (() => undefined);
  }

  rules(): QuotaRules {
    return this.#rules();
  }

  /** USD of a call for the quota (`chargeOf` at the configured rate). */
  charge(cost: number | null, usage: Pick<Usage, "prompt_tokens" | "completion_tokens">): number {
    return chargeOf(cost, usage, this.#rules().unpricedUsdPerMtok);
  }

  #ledger(person: string, now: number): Ledger {
    const day = this.#day(now).key;
    let ledger = this.#people.get(person);
    if (ledger === undefined) {
      ledger = { minutes: new Map(), day, dayMicros: 0, stretch: null };
      try {
        const kept = this.#book?.load(person, minuteOf(now) - MINUTES_PER_HOUR + 1, day);
        if (kept !== undefined) {
          for (const [minute, micros] of kept.minutes) ledger.minutes.set(minute, micros);
          ledger.dayMicros = kept.day;
        }
      } catch (error) {
        this.#onError("could not read the quota", error);
      }
      this.#people.set(person, ledger);
    }
    if (ledger.day !== day) {
      ledger.day = day;
      ledger.dayMicros = 0;
    }
    const oldest = minuteOf(now) - MINUTES_PER_HOUR + 1;
    for (const minute of ledger.minutes.keys()) if (minute < oldest) ledger.minutes.delete(minute);
    return ledger;
  }

  /** Adds `usd` spent for `person` at `now`. */
  add(person: string, now: number, usd: number): void {
    if (!(usd > 0)) return;
    const micros = Math.round(usd * MICROS);
    if (micros === 0) return;
    const ledger = this.#ledger(person, now);
    // Under both limits right before this spend: the stretch it was in has ended.
    if (ledger.stretch !== null && this.#over(ledger, now) === null) ledger.stretch = null;
    const minute = minuteOf(now);
    ledger.minutes.set(minute, (ledger.minutes.get(minute) ?? 0) + micros);
    ledger.dayMicros += micros;
    try {
      this.#book?.add(person, minute, ledger.day, micros, now);
      if (now - this.#prunedAt >= HOUR_MS) {
        this.#prunedAt = now;
        const today = this.#day(now).key;
        const yesterday = this.#day(now - 24 * HOUR_MS).key;
        this.#book?.prune(minute - MINUTES_PER_HOUR + 1, [today, yesterday]);
      }
    } catch (error) {
      this.#onError("could not keep the quota", error);
    }
  }

  /** What `person` used in the hour before `now` and in her day. */
  used(person: string, now: number): QuotaUse {
    const ledger = this.#ledger(person, now);
    let hour = 0;
    for (const micros of ledger.minutes.values()) hour += micros;
    return { hour: hour / MICROS, day: ledger.dayMicros / MICROS };
  }

  /** Everyone charged in her day at `now`, from the book (the admin page). */
  today(now: number): { person: string; used: QuotaUse }[] {
    const day = this.#day(now).key;
    let rows: { person: string; micros: number }[] = [];
    try {
      rows = this.#book?.dayTotals(day) ?? [];
    } catch (error) {
      this.#onError("could not read the quota", error);
    }
    const seen = new Set(rows.map((r) => r.person));
    for (const [person, ledger] of this.#people) {
      if (!seen.has(person) && ledger.day === day && ledger.dayMicros > 0) {
        rows.push({ person, micros: ledger.dayMicros });
      }
    }
    return rows.map((r) => ({ person: r.person, used: this.used(r.person, now) }));
  }

  /** The limit `ledger` is at now, the day's first; `null`: under both. */
  #over(ledger: Ledger, now: number): Omit<QuotaCap, "first" | "used"> | null {
    const rules = this.#rules();
    if (rules.usdPerDay > 0 && ledger.dayMicros >= rules.usdPerDay * MICROS) {
      return { which: "day", limit: rules.usdPerDay, until: this.#day(now).endsAt };
    }
    if (!(rules.usdPerHour > 0)) return null;
    const cap = rules.usdPerHour * MICROS;
    const minutes = [...ledger.minutes.entries()].sort((a, b) => a[0] - b[0]);
    let total = minutes.reduce((n, [, m]) => n + m, 0);
    if (total < cap) return null;
    // The first minute at which what is left of the hour is under the cap.
    let until = now;
    for (const [minute, micros] of minutes) {
      total -= micros;
      until = (minute + MINUTES_PER_HOUR) * MINUTE_MS;
      if (total < cap) break;
    }
    return { which: "hour", limit: rules.usdPerHour, until };
  }

  /** The limit `person` is at now and when it frees up, without marking a stretch (a read). */
  limitAt(person: string, now: number): { which: "hour" | "day"; until: number } | null {
    const over = this.#over(this.#ledger(person, now), now);
    return over === null ? null : { which: over.which, until: over.until };
  }

  /**
   * `payer` at a limit at `now`, or `null` when under both (which ends the stretch) or exempt. The
   * first call of a stretch marks it (`first`).
   */
  capped(payer: Payer | null, now: number): QuotaCap | null {
    if (payer === null || payer.exempt === true) return null;
    const ledger = this.#ledger(payer.person, now);
    const over = this.#over(ledger, now);
    if (over === null) {
      ledger.stretch = null;
      return null;
    }
    const first = ledger.stretch === null;
    if (first) ledger.stretch = { noticed: false };
    return { ...over, used: this.used(payer.person, now), first };
  }

  /**
   * Takes the one notice of `person`'s stretch: `true` the first time, `false` after (or when they
   * are not capped). `releaseNotice` gives it back when it could not be said.
   */
  claimNotice(person: string): boolean {
    const stretch = this.#people.get(person)?.stretch ?? null;
    if (stretch === null || stretch.noticed) return false;
    stretch.noticed = true;
    return true;
  }

  releaseNotice(person: string): void {
    const stretch = this.#people.get(person)?.stretch ?? null;
    if (stretch !== null) stretch.noticed = false;
  }
}

function minuteOf(now: number): number {
  return Math.floor(now / MINUTE_MS);
}

/**
 * The whole minutes from `now` until a capped person is under the limit again, rounded up and at
 * least one: never a time already past.
 */
export function capMinutes(cap: Pick<QuotaCap, "until">, now: number): number {
  return Math.max(1, Math.ceil((cap.until - now) / MINUTE_MS));
}

/** Each person's AI quota, for the admin and member pages (the text host provides it). */
export const PersonQuotaKey = serviceKey<PersonQuota>("PersonQuota");
