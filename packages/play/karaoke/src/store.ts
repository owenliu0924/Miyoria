// The `karaoke` plugin's tables on the store's database (`schema.ts`): songs, the daily requests,
// sessions, tracks and results (`KaraokeStore`). Every write is one `Db.tx`; a scored session is
// its track, its result, the session marked scored and one `karaoke.scored` event, together.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `karaoke` (`module.ts`) owns it.
// A person who asks to be forgotten loses their sessions, tracks, results and requests; the songs
// stay (nobody's), with who asked for them cleared. A merge moves them.

import {
  type CategoryData,
  type Db,
  type EventStore,
  type PersonHookResult,
  type PersonMerge,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import { newId, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, count, desc, eq, gte, inArray, lte, max } from "drizzle-orm";
import { type KaraokeScoredData, karaokeScoredWrite } from "./events.js";
import { karaokeSchema } from "./migrations.js";
import {
  karaokeRequests,
  karaokeResults,
  karaokeSessions,
  karaokeSongs,
  karaokeTracks,
} from "./schema.js";

export type SongStatus = "preparing" | "ready" | "failed";
export type CommentState = "waiting" | "said" | "none";

export type SongRow = typeof karaokeSongs.$inferSelect;
export type SessionRow = typeof karaokeSessions.$inferSelect;
export type TrackRow = typeof karaokeTracks.$inferSelect;
export type ResultRow = typeof karaokeResults.$inferSelect;

/** What a song row may change once it is made. */
export type SongPatch = Partial<Omit<SongRow, "id" | "source_key" | "source" | "created_at">>;

const at = (ms: number): Timestamp => toTimestamp(ms);

export class KaraokeStore {
  readonly #db: Db;
  readonly #events: EventStore;

  constructor(db: Db, events: EventStore) {
    this.#db = db;
    this.#events = events;
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }

  #read() {
    this.#db.ensureOpen();
    return this.#db.orm;
  }

  // ---- songs --------------------------------------------------------------------------------

  song(id: string): SongRow | null {
    return this.#read().select().from(karaokeSongs).where(eq(karaokeSongs.id, id)).get() ?? null;
  }

  songBySource(key: string): SongRow | null {
    return (
      this.#read().select().from(karaokeSongs).where(eq(karaokeSongs.source_key, key)).get() ?? null
    );
  }

  /** Songs in `status`, newest first. */
  songsIn(status: SongStatus, limit = 500): SongRow[] {
    return this.#read()
      .select()
      .from(karaokeSongs)
      .where(eq(karaokeSongs.status, status))
      .orderBy(desc(karaokeSongs.created_at))
      .limit(limit)
      .all();
  }

  /** What `person` asked for since `since` that is not ready (preparing, or failed). */
  pendingOf(person: PersonId, since: number): SongRow[] {
    return this.#read()
      .select()
      .from(karaokeSongs)
      .where(
        and(
          eq(karaokeSongs.requested_by, person),
          inArray(karaokeSongs.status, ["preparing", "failed"]),
          gte(karaokeSongs.created_at, at(since)),
        ),
      )
      .orderBy(desc(karaokeSongs.created_at))
      .all();
  }

  /** A new song asked for by `person`, and the request that counts against their day. */
  addSong(
    song: { id: string; source_key: string; source: string; title: string },
    person: PersonId | null,
    now: number,
  ): SongRow {
    return this.#write(() => {
      this.#db.orm
        .insert(karaokeSongs)
        .values({
          ...song,
          status: "preparing",
          requested_by: person,
          created_at: at(now),
        })
        .run();
      return this.song(song.id) as SongRow;
    });
  }

  /** A failed song asked for again: preparing once more. */
  retrySong(id: string, person: PersonId | null): void {
    this.patchSong(id, {
      status: "preparing",
      job: null,
      error: null,
      error_detail: null,
      requested_by: person,
    });
  }

  patchSong(id: string, patch: SongPatch): void {
    this.#write(() => {
      this.#db.orm.update(karaokeSongs).set(patch).where(eq(karaokeSongs.id, id)).run();
    });
  }

  addRequest(person: PersonId, song: string, now: number): void {
    this.#write(() => {
      this.#db.orm
        .insert(karaokeRequests)
        .values({ id: newId(), person_id: person, song_id: song, created_at: at(now) })
        .run();
    });
  }

  requestsSince(person: PersonId, since: number): number {
    const row = this.#read()
      .select({ n: count() })
      .from(karaokeRequests)
      .where(and(eq(karaokeRequests.person_id, person), gte(karaokeRequests.created_at, at(since))))
      .get();
    return row?.n ?? 0;
  }

  /** Ready songs last used (or made) before `before`. */
  idleReady(before: number): SongRow[] {
    const limit = Date.parse(at(before));
    return this.songsIn("ready", 10_000).filter(
      (s) => Date.parse(s.used_at ?? s.ready_at ?? s.created_at) < limit,
    );
  }

  // ---- sessions -----------------------------------------------------------------------------

  addSession(row: Omit<SessionRow, "status" | "scored_at">): SessionRow {
    return this.#write(() => {
      this.#db.orm
        .insert(karaokeSessions)
        .values({ ...row, status: "open" })
        .run();
      this.#db.orm
        .update(karaokeSongs)
        .set({ used_at: row.started_at })
        .where(eq(karaokeSongs.id, row.song_id))
        .run();
      return this.session(row.id) as SessionRow;
    });
  }

  session(id: string): SessionRow | null {
    return (
      this.#read().select().from(karaokeSessions).where(eq(karaokeSessions.id, id)).get() ?? null
    );
  }

  // ---- results ------------------------------------------------------------------------------

  /**
   * A session scored: its track, its result, the session marked, and one `karaoke.scored`, in
   * one transaction. `false` when the session was scored already (a second submit).
   */
  scored(track: TrackRow, result: ResultRow, event: KaraokeScoredData): boolean {
    return this.#write(() => {
      const moved = this.#db.orm
        .update(karaokeSessions)
        .set({ status: "scored", scored_at: result.created_at })
        .where(and(eq(karaokeSessions.id, track.session_id), eq(karaokeSessions.status, "open")))
        .run().changes;
      if (Number(moved) === 0) return false;
      this.#db.orm.insert(karaokeTracks).values(track).run();
      this.#db.orm.insert(karaokeResults).values(result).run();
      this.#events.appendNow(karaokeScoredWrite(event, result.person_id, result.created_at));
      return true;
    });
  }

  result(session: string): ResultRow | null {
    return (
      this.#read()
        .select()
        .from(karaokeResults)
        .where(eq(karaokeResults.session_id, session))
        .get() ?? null
    );
  }

  /** A person's results, newest first. */
  resultsOf(person: PersonId, limit: number): ResultRow[] {
    return this.#read()
      .select()
      .from(karaokeResults)
      .where(eq(karaokeResults.person_id, person))
      .orderBy(desc(karaokeResults.created_at))
      .limit(limit)
      .all();
  }

  /** A person's best ranked total on each song they sang, and how often they sang it. */
  bestsOf(person: PersonId): Map<string, { best: number | null; sung: number }> {
    const rows = this.#read()
      .select({
        song: karaokeResults.song_id,
        sung: count(),
      })
      .from(karaokeResults)
      .where(eq(karaokeResults.person_id, person))
      .groupBy(karaokeResults.song_id)
      .all();
    const bests = this.#read()
      .select({ song: karaokeResults.song_id, best: max(karaokeResults.total) })
      .from(karaokeResults)
      .where(and(eq(karaokeResults.person_id, person), eq(karaokeResults.unranked, false)))
      .groupBy(karaokeResults.song_id)
      .all();
    const out = new Map<string, { best: number | null; sung: number }>();
    for (const r of rows) out.set(r.song, { best: null, sung: r.sung });
    for (const b of bests) {
      const entry = out.get(b.song);
      if (entry !== undefined) entry.best = b.best;
    }
    return out;
  }

  /** Results waiting for her comment in `channel`, told since `since`, oldest first. */
  waitingIn(channel: string, since: number): ResultRow[] {
    return this.#read()
      .select()
      .from(karaokeResults)
      .where(
        and(
          eq(karaokeResults.comment_state, "waiting"),
          eq(karaokeResults.channel, channel),
          gte(karaokeResults.noted_at, at(since)),
        ),
      )
      .orderBy(karaokeResults.noted_at)
      .all();
  }

  setComment(session: string, state: CommentState, text: string | null, now: number): void {
    this.#write(() => {
      this.#db.orm
        .update(karaokeResults)
        .set({ comment_state: state, comment: text, comment_at: state === "said" ? at(now) : null })
        .where(eq(karaokeResults.session_id, session))
        .run();
    });
  }

  /** Comments still waiting that were asked for before `before`: she did not make one. */
  giveUpComments(before: number): number {
    return this.#write(() =>
      Number(
        this.#db.orm
          .update(karaokeResults)
          .set({ comment_state: "none" })
          .where(
            and(
              eq(karaokeResults.comment_state, "waiting"),
              lte(karaokeResults.noted_at, at(before)),
            ),
          )
          .run().changes,
      ),
    );
  }

  /** The latest results, for the owner. */
  latest(limit: number): (ResultRow & { name: string; title: string; track: TrackRow | null })[] {
    const rows = this.#read()
      .select()
      .from(karaokeResults)
      .orderBy(desc(karaokeResults.created_at))
      .limit(limit)
      .all();
    return rows.map((r) => ({
      ...r,
      name: this.session(r.session_id)?.name ?? "",
      title: this.song(r.song_id)?.title ?? "",
      track:
        this.#read()
          .select()
          .from(karaokeTracks)
          .where(eq(karaokeTracks.session_id, r.session_id))
          .get() ?? null,
    }));
  }

  // ---- upkeep -------------------------------------------------------------------------------

  /** Tracks past their week: deleted (the results stay). */
  purgeTracks(now: number): number {
    return this.#write(() =>
      Number(
        this.#db.orm
          .delete(karaokeTracks)
          .where(lte(karaokeTracks.purge_at, at(now)))
          .run().changes,
      ),
    );
  }

  forgetPerson(ids: readonly PersonId[]): Record<string, number> {
    if (ids.length === 0) return {};
    const list = [...ids];
    return this.#write(() => {
      const o = this.#db.orm;
      const sessions = o
        .select({ id: karaokeSessions.id })
        .from(karaokeSessions)
        .where(inArray(karaokeSessions.person_id, list))
        .all()
        .map((s) => s.id);
      const tracks =
        sessions.length === 0
          ? 0
          : Number(
              o.delete(karaokeTracks).where(inArray(karaokeTracks.session_id, sessions)).run()
                .changes,
            );
      return {
        karaoke_tracks: tracks,
        karaoke_results: Number(
          o.delete(karaokeResults).where(inArray(karaokeResults.person_id, list)).run().changes,
        ),
        karaoke_sessions: Number(
          o.delete(karaokeSessions).where(inArray(karaokeSessions.person_id, list)).run().changes,
        ),
        karaoke_requests: Number(
          o.delete(karaokeRequests).where(inArray(karaokeRequests.person_id, list)).run().changes,
        ),
        karaoke_songs: Number(
          o
            .update(karaokeSongs)
            .set({ requested_by: null })
            .where(inArray(karaokeSongs.requested_by, list))
            .run().changes,
        ),
      };
    });
  }

  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#write((): PersonHookResult => {
      const o = this.#db.orm;
      const moved = (n: { changes: number | bigint }) => Number(n.changes);
      return {
        counts: {
          karaoke_sessions: moved(
            o
              .update(karaokeSessions)
              .set({ person_id: keep })
              .where(eq(karaokeSessions.person_id, absorb))
              .run(),
          ),
          karaoke_results: moved(
            o
              .update(karaokeResults)
              .set({ person_id: keep })
              .where(eq(karaokeResults.person_id, absorb))
              .run(),
          ),
          karaoke_requests: moved(
            o
              .update(karaokeRequests)
              .set({ person_id: keep })
              .where(eq(karaokeRequests.person_id, absorb))
              .run(),
          ),
          karaoke_songs: moved(
            o
              .update(karaokeSongs)
              .set({ requested_by: keep })
              .where(eq(karaokeSongs.requested_by, absorb))
              .run(),
          ),
        },
      };
    });
  }
}

/** Where the karaoke tables sit in the data categories: what people did with her. */
const karaokeData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("karaoke_songs", "karaoke_songs", "node", "created_at", "created_at, id", {
        id: "text",
        source_key: "text",
        source: "text",
        title: "text",
        artist: "text",
        duration_ms: "num",
        status: "text",
        job: "text",
        worker_song: "text",
        error: "text",
        error_detail: "text",
        lyrics: "bool",
        notes: "num",
        requested_by: "text",
        created_at: "ts",
        ready_at: "ts",
        used_at: "ts",
      }),
      tablePart("karaoke_requests", "karaoke_requests", "node", "created_at", "created_at, id", {
        id: "text",
        person_id: "text",
        song_id: "text",
        created_at: "ts",
      }),
      tablePart("karaoke_sessions", "karaoke_sessions", "node", "started_at", "started_at, id", {
        id: "text",
        song_id: "text",
        person_id: "text",
        platform: "text",
        account_id: "text",
        name: "text",
        status: "text",
        started_at: "ts",
        expires_at: "ts",
        scored_at: "ts",
      }),
      tablePart(
        "karaoke_tracks",
        "karaoke_tracks",
        "node",
        "submitted_at",
        "submitted_at, session_id",
        {
          session_id: "text",
          hz: "num",
          frames: "text",
          latency_ms: "num",
          calibrated: "bool",
          browser: "text",
          submitted_at: "ts",
          purge_at: "ts",
        },
      ),
      tablePart(
        "karaoke_results",
        "karaoke_results",
        "node",
        "created_at",
        "created_at, session_id",
        {
          session_id: "text",
          song_id: "text",
          person_id: "text",
          total: "num",
          pitch: "num",
          stability: "num",
          rhythm: "num",
          expression: "num",
          unranked: "bool",
          reasons: "text",
          detail: "text",
          client_total: "num",
          best_before: "num",
          comment_state: "text",
          comment: "text",
          channel: "text",
          noted_at: "ts",
          comment_at: "ts",
          created_at: "ts",
        },
      ),
    ],
  },
];

/** The `karaoke` plugin's tables and code (`StorePlugin`). */
export const karaokeTables: StorePlugin<KaraokeStore> = {
  schema: karaokeSchema,
  open: ({ db, events }) => new KaraokeStore(db, events),
  data: karaokeData,
  forgetPerson: (opened, request) => ({ counts: opened.forgetPerson(request.ids) }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};
