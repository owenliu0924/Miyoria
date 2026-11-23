// Reads and writes of the `quota` plugin's table (`quota-schema.ts`): the `QuotaBook` behind each
// person's AI quota (`PersonQuota` of `@miyoria/brain/self`). Every time is given by the caller.

import type { Db, PersonForget, StorePlugin } from "@miyoria/store";
import { accountRefString, toTimestamp } from "@miyoria/types";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { QuotaBook } from "../../self/src/index.js";
import { quotaSchema } from "./quota-migrations.js";
import { quotaSpend as Q } from "./quota-schema.js";

export class QuotaStore implements QuotaBook {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #bump(person: string, slot: "minute" | "day", key: string, micros: number, at: number): void {
    const updated_at = toTimestamp(at);
    this.#db.orm
      .insert(Q)
      .values({ person, slot, key, micros, updated_at })
      .onConflictDoUpdate({
        target: [Q.person, Q.slot, Q.key],
        set: { micros: sql`${Q.micros} + ${micros}`, updated_at },
      })
      .run();
  }

  add(person: string, minute: number, day: string, micros: number, at: number): void {
    if (!(micros > 0)) return;
    this.#db.tx(() => {
      this.#bump(person, "minute", String(minute), micros, at);
      this.#bump(person, "day", day, micros, at);
    });
  }

  load(person: string, sinceMinute: number, day: string) {
    const rows = this.#db.orm
      .select({ slot: Q.slot, key: Q.key, micros: Q.micros })
      .from(Q)
      .where(eq(Q.person, person))
      .all();
    const minutes: [number, number][] = [];
    let total = 0;
    for (const r of rows) {
      if (r.slot === "day") {
        if (r.key === day) total = r.micros;
        continue;
      }
      const minute = Number(r.key);
      if (Number.isFinite(minute) && minute >= sinceMinute) minutes.push([minute, r.micros]);
    }
    return { minutes, day: total };
  }

  dayTotals(day: string): { person: string; micros: number }[] {
    return this.#db.orm
      .select({ person: Q.person, micros: Q.micros })
      .from(Q)
      .where(and(eq(Q.slot, "day"), eq(Q.key, day)))
      .orderBy(desc(Q.micros))
      .all();
  }

  prune(beforeMinute: number, keepDays: readonly string[]): void {
    this.#db.tx(() => {
      // The minute keys are decimal text: compared as numbers.
      this.#db.orm
        .delete(Q)
        .where(and(eq(Q.slot, "minute"), lt(sql`CAST(${Q.key} AS INTEGER)`, beforeMinute)))
        .run();
      this.#db.orm
        .delete(Q)
        .where(and(eq(Q.slot, "day"), notInArray(Q.key, [...keepDays])))
        .run();
    });
  }

  /** Every row (tests, the data page). */
  all(): { person: string; slot: string; key: string; micros: number }[] {
    return this.#db.orm
      .select({ person: Q.person, slot: Q.slot, key: Q.key, micros: Q.micros })
      .from(Q)
      .all();
  }

  /** "Forget me": the person's rows, by id and by account, are deleted. */
  forgetPerson(request: PersonForget): { spend: number } {
    const keys = [...request.ids, ...request.accounts.map((a) => accountRefString(a))];
    if (keys.length === 0) return { spend: 0 };
    const out = this.#db.orm.delete(Q).where(inArray(Q.person, keys)).run();
    return { spend: Number(out.changes ?? 0) };
  }
}

/**
 * Each person's AI quota as a plugin of the store: Core opens the store with it, so the table
 * exists; the text host reads and writes it.
 */
export const quotaTables: StorePlugin<QuotaStore> = {
  schema: quotaSchema,
  open: ({ db }) => new QuotaStore(db),
  forgetPerson: (store, request: PersonForget) => ({ counts: store.forgetPerson(request) }),
};
