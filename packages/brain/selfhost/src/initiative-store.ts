// Reads and writes of the `initiative` plugin's tables (`initiative-schema.ts`): her schedules and
// her inbox. Every time is given by the caller (her clock), never the store's.

import type { Db, StorePlugin } from "@miyoria/store";
import { type AccountRef, type ContextKey, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { initiativeSchema } from "./initiative-migrations.js";
import {
  initiativeInbox as I,
  type InboxKind,
  type InboxRow,
  initiativeSchedules as S,
  type ScheduleRow,
  type ScheduleSource,
  type ScheduleState,
} from "./initiative-schema.js";

export type { InboxKind, InboxRow, ScheduleRow, ScheduleSource, ScheduleState };

/** A new schedule. */
export interface NewSchedule {
  id: string;
  note: string;
  due: number;
  daily: string | null;
  context: ContextKey | null;
  person: string | null;
  for_account: AccountRef | null;
  source: ScheduleSource;
  at: number;
}

/** A new inbox item. */
export interface NewInboxItem {
  key: string;
  kind: InboxKind;
  session: string | null;
  context: ContextKey | null;
  text: string;
  person: string | null;
  at: number;
}

const ts = (ms: number): Timestamp => toTimestamp(ms);

export class InitiativeStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // ---- schedules ------------------------------------------------------------------------------

  addSchedule(s: NewSchedule): ScheduleRow {
    const row = {
      id: s.id,
      note: s.note,
      due: ts(s.due),
      daily: s.daily,
      context: s.context,
      person: s.person,
      for_account: s.for_account,
      source: s.source,
      fired: 0,
      state: "open" as const,
      created_at: ts(s.at),
      updated_at: ts(s.at),
    };
    this.#db.orm.insert(S).values(row).run();
    return row;
  }

  /** The schedules still waiting, soonest first. */
  openSchedules(): ScheduleRow[] {
    return this.#db.orm.select().from(S).where(eq(S.state, "open")).orderBy(asc(S.due)).all();
  }

  schedule(id: string): ScheduleRow | null {
    return this.#db.orm.select().from(S).where(eq(S.id, id)).get() ?? null;
  }

  /** Moves an open schedule to its next time (a daily one that came due). */
  reschedule(id: string, due: number, fired: number, at: number): void {
    this.#db.orm
      .update(S)
      .set({ due: ts(due), fired, updated_at: ts(at) })
      .where(and(eq(S.id, id), eq(S.state, "open")))
      .run();
  }

  /** Ends an open schedule; `false` when it was not open. */
  endSchedule(
    id: string,
    state: Exclude<ScheduleState, "open">,
    fired: number,
    at: number,
  ): boolean {
    const changed = this.#db.orm
      .update(S)
      .set({ state, fired, updated_at: ts(at) })
      .where(and(eq(S.id, id), eq(S.state, "open")))
      .run();
    return changed.changes > 0;
  }

  // ---- the inbox ------------------------------------------------------------------------------

  /** Adds an item; `null` when one with its key is there already (seen or not). */
  addItem(item: NewInboxItem): InboxRow | null {
    const inserted = this.#db.orm
      .insert(I)
      .values({
        key: item.key,
        kind: item.kind,
        session: item.session,
        context: item.context,
        text: item.text,
        person: item.person,
        created_at: ts(item.at),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return null;
    return this.#db.orm.select().from(I).where(eq(I.key, item.key)).get() ?? null;
  }

  hasItem(key: string): boolean {
    return this.#db.orm.select({ id: I.id }).from(I).where(eq(I.key, key)).get() !== undefined;
  }

  /** What a run in `session` is shown: its unseen items and home's, oldest first, at most `max`. */
  unseenFor(session: string, max: number): InboxRow[] {
    return this.#db.orm
      .select()
      .from(I)
      .where(and(isNull(I.seen_at), or(eq(I.session, session), isNull(I.session))))
      .orderBy(desc(I.id))
      .limit(max)
      .all()
      .reverse();
  }

  /** Every unseen item, oldest first. */
  unseen(): InboxRow[] {
    return this.#db.orm.select().from(I).where(isNull(I.seen_at)).orderBy(asc(I.id)).all();
  }

  /** It woke her (once). */
  woke(id: number, at: number): void {
    this.#db.orm
      .update(I)
      .set({ woke_at: ts(at) })
      .where(and(eq(I.id, id), isNull(I.woke_at)))
      .run();
  }

  /** The turn its wake started. */
  wokeTurn(id: number, turn: string): void {
    this.#db.orm.update(I).set({ woke_turn: turn }).where(eq(I.id, id)).run();
  }

  /** A run that showed `ids` finished. */
  seen(ids: readonly number[], turn: string, at: number): void {
    if (ids.length === 0) return;
    this.#db.orm
      .update(I)
      .set({ seen_at: ts(at), seen_turn: turn })
      .where(and(inArray(I.id, [...ids]), isNull(I.seen_at)))
      .run();
  }

  item(id: number): InboxRow | null {
    return this.#db.orm.select().from(I).where(eq(I.id, id)).get() ?? null;
  }
}

/**
 * Her schedules and her inbox as a plugin of the store: Core opens the store with it
 * (`STORE_PLUGINS`), so the tables exist; only the new runner writes them.
 */
export const initiativeTables: StorePlugin<InitiativeStore> = {
  schema: initiativeSchema,
  open: ({ db }) => new InitiativeStore(db),
};
