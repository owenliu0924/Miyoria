// Each person's sandbox CPU seconds (docs/design/v6-sandbox.md §8): the same machinery as the AI
// quota (`PersonQuota`, the `quota_spend` table) in a second instance whose unit is CPU seconds
// instead of USD. Its rows are keyed `~cpu:<person>`; `~` never starts a person id or an account,
// so they cannot meet the AI quota's rows, and `QuotaStore.dayTotals` leaves them out of the AI
// page.

import { StoreKey } from "@miyoria/store";
import type { Principal, WorkPayer, WorkQuota } from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import type { LocalTime } from "../../arbiter/src/index.js";
import { PersonQuota, type QuotaBook } from "../../self/src/index.js";
import { localQuotaDay, payerOfAuthor } from "./quota.js";
import { quotaTables, WORK_KEY_PREFIX } from "./quota-store.js";

/** What `PrefixedBook` needs of the table: the AI quota's book, and the day's totals under a prefix. */
interface PrefixableBook extends QuotaBook {
  dayTotalsUnder(day: string, prefix: string): { person: string; micros: number }[];
}

/** A book that keeps its people under a prefix, in a table shared with the AI quota. */
export class PrefixedBook implements QuotaBook {
  readonly #inner: PrefixableBook;
  readonly #prefix: string;

  constructor(inner: PrefixableBook, prefix: string) {
    this.#inner = inner;
    this.#prefix = prefix;
  }

  add(person: string, minute: number, day: string, micros: number, at: number): void {
    this.#inner.add(this.#prefix + person, minute, day, micros, at);
  }

  load(person: string, sinceMinute: number, day: string) {
    return this.#inner.load(this.#prefix + person, sinceMinute, day);
  }

  dayTotals(day: string): { person: string; micros: number }[] {
    return this.#inner.dayTotalsUnder(day, this.#prefix);
  }

  /** Pruning is by slot and key, for every person: the same call as the AI quota's. */
  prune(beforeMinute: number, keepDays: readonly string[]): void {
    this.#inner.prune(beforeMinute, keepDays);
  }
}

/**
 * The work quota over the store's `quota` table (when there is one). The limits are
 * `[modules.agent.quota]`, read each time so an edit is picked up.
 */
export function hostWorkQuota(agent: Agent, quiet: LocalTime | null): WorkQuota {
  const store = agent.ctx.services.get(StoreKey)?.plugin(quotaTables) ?? null;
  return workQuotaOver({
    agent,
    quiet,
    book: store === null ? null : new PrefixedBook(store, WORK_KEY_PREFIX),
  });
}

/** `hostWorkQuota` with the book given (tests). */
export function workQuotaOver(o: {
  agent: Agent;
  quiet: LocalTime | null;
  book: QuotaBook | null;
}): WorkQuota {
  const { agent } = o;
  const quota = new PersonQuota({
    rules: () => {
      const q = agent.config.quota;
      // `PersonQuota` counts in dollars it multiplies by a million; fed CPU seconds, the integers
      // it keeps are CPU microseconds.
      return {
        usdPerHour: q.person_cpu_seconds_per_hour,
        usdPerDay: q.person_cpu_seconds_per_day,
        unpricedUsdPerMtok: 0,
      };
    },
    day: localQuotaDay(o.quiet),
    book: o.book,
    onError: (what, error) => agent.log.warn({ err: String(error) }, what),
  });
  return {
    payerOf(principal: Principal): WorkPayer | null {
      if (principal.requester === null) return null;
      return payerOfAuthor(agent, { account: principal.requester, name: "" });
    },
    capped(payer, now) {
      const cap = quota.capped(payer, now);
      return cap === null ? null : { ...cap };
    },
    charge(payer, now, cpuSeconds) {
      if (payer === null) return;
      quota.add(payer.person, now, cpuSeconds);
    },
    claimNotice: (person) => quota.claimNotice(person),
    used: (person, now) => quota.used(person, now),
    rules() {
      const r = quota.rules();
      return { cpuSecondsPerHour: r.usdPerHour, cpuSecondsPerDay: r.usdPerDay };
    },
  };
}
