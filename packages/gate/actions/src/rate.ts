// Rate limits and cooldowns of medium / high risk capabilities: rolling 24-hour and one-hour
// windows per capability and per capability and person, plus a minimum gap between runs.

import type { Limit, TierLimit } from "./config.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Effective limits of one capability (tier defaults filled in). */
export interface Limits {
  perDay: number;
  perPersonPerDay: number;
  cooldownMs: number;
  /** `Infinity`: no hourly limit. */
  perHour: number;
  perPersonPerHour: number;
}

const orNone = (n: number | null | undefined): number | undefined =>
  n === null || n === undefined ? undefined : n;

/** Configured limits first, then the capability's own defaults, then the tier's. */
export function effectiveLimits(
  own: Limit | undefined,
  tier: TierLimit,
  defaults: Partial<Limit> | null = null,
): Limits {
  return {
    perDay: own?.per_day ?? defaults?.per_day ?? tier.per_day,
    perPersonPerDay:
      own?.per_person_per_day ?? defaults?.per_person_per_day ?? tier.per_person_per_day,
    cooldownMs: own?.cooldown_ms ?? defaults?.cooldown_ms ?? tier.cooldown_ms,
    perHour:
      orNone(own?.per_hour) ?? orNone(defaults?.per_hour) ?? orNone(tier.per_hour) ?? Infinity,
    perPersonPerHour:
      orNone(own?.per_person_per_hour) ??
      orNone(defaults?.per_person_per_hour) ??
      orNone(tier.per_person_per_hour) ??
      Infinity,
  };
}

/** While the LLM budget is degraded: half the runs (at least one), twice the cooldown. */
export function tightened(limits: Limits): Limits {
  const half = (n: number) => (n === 0 ? 0 : Math.max(1, Math.floor(n / 2)));
  return {
    perDay: half(limits.perDay),
    perPersonPerDay: half(limits.perPersonPerDay),
    cooldownMs: limits.cooldownMs * 2,
    perHour: half(limits.perHour),
    perPersonPerHour: half(limits.perPersonPerHour),
  };
}

/** One recorded run. Kept by the caller to say later that it failed. */
export interface RateRun {
  at: number;
  person: string | null;
  /** Its executor failed: it counts toward the daily limits, and no cooldown follows it. */
  failed: boolean;
}

/** Recorded runs (allowed decisions), in memory. */
export class RateLimiter {
  /** Runs by capability, oldest first. */
  readonly #runs = new Map<string, RateRun[]>();

  #recent(capability: string, now: number): RateRun[] {
    const runs = (this.#runs.get(capability) ?? []).filter((r) => now - r.at < DAY_MS);
    this.#runs.set(capability, runs);
    return runs;
  }

  /** Why a run now would exceed `limits`, or `null` when it is within them. */
  check(capability: string, person: string | null, limits: Limits, now: number): string | null {
    const runs = this.#recent(capability, now);
    // The gap is between things she did: after a run that failed she may try again at once
    // (a join with a wrong channel, then the right one). The daily limits still count it.
    const last = runs.findLast((r) => !r.failed);
    if (last !== undefined && now - last.at < limits.cooldownMs) {
      const wait = Math.ceil((limits.cooldownMs - (now - last.at)) / 1000);
      return `cooling down (${wait} s left)`;
    }
    if (runs.length >= limits.perDay) return `daily limit reached (${limits.perDay} per day)`;
    const hour = runs.filter((r) => now - r.at < HOUR_MS);
    if (hour.length >= limits.perHour) return `hourly limit reached (${limits.perHour} per hour)`;
    if (person !== null) {
      const theirs = runs.filter((r) => r.person === person).length;
      if (theirs >= limits.perPersonPerDay) {
        return `daily limit for this person reached (${limits.perPersonPerDay} per day)`;
      }
      const theirHour = hour.filter((r) => r.person === person).length;
      if (theirHour >= limits.perPersonPerHour) {
        return `hourly limit for this person reached (${limits.perPersonPerHour} per hour)`;
      }
    }
    return null;
  }

  record(capability: string, person: string | null, now: number): RateRun {
    const run: RateRun = { at: now, person, failed: false };
    this.#recent(capability, now).push(run);
    return run;
  }

  /** The executor of `run` failed (see `RateRun.failed`). */
  failed(run: RateRun): void {
    run.failed = true;
  }
}
