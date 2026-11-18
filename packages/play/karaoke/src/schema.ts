// The tables of the `karaoke` plugin (docs/design/karaoke.md 「做了什麼(第一步)」), as Drizzle
// definitions: `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and
// the store's drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// - `karaoke_songs`: one row per song asked for (by its link or search): its worker job, the
//   worker's karaoke id, whether it is ready, and what its reference holds.
// - `karaoke_requests`: one row per preparation a person started, for the daily limit.
// - `karaoke_sessions`: one singing of one song by one person (single-player in this milestone),
//   in the key the singer chose (`shift`, migration 2).
// - `karaoke_tracks`: the pitch track a session sent: 50 Hz, one byte a frame, base64; deleted
//   after a week (`purge_at`).
// - `karaoke_results`: Core's score of a session, and her comment on it; since migration 3 which
//   score it is (`source`: `estimate` from the browser's track, `voice` from the recording of the
//   singer) and what became of the recording (`voice_state`).
//
// No foreign key to `persons`: a person who asks to be forgotten loses their sessions, tracks and
// results through the plugin's hook; a song stays (it is nobody's).

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const karaokeSongs = sqliteTable(
  "karaoke_songs",
  {
    id: text().primaryKey(),
    /** `url:<link>` or `query:<words>`, normalised: the same request is the same song. */
    source_key: text().notNull(),
    /** The link or the words as given. */
    source: text().notNull(),
    title: text().notNull().default(""),
    artist: text(),
    duration_ms: integer(),
    status: text().notNull(),
    /** The worker's job while preparing, and its karaoke song once done. */
    job: text(),
    worker_song: text(),
    /** Why it failed: a sentence for people, and the worker's own words for the owner. */
    error: text(),
    error_detail: text(),
    lyrics: integer({ mode: "boolean" }).notNull().default(false),
    /** `found` (looked up) or `heard` (transcribed: shown as 聽寫); `null` without lyrics or before step 2. */
    lyrics_source: text(),
    notes: integer().notNull().default(0),
    /** The worker made a background video for it (migration 3). */
    video: integer({ mode: "boolean" }).notNull().default(false),
    /** Who asked for it first. */
    requested_by: text(),
    created_at: micros().notNull(),
    ready_at: micros(),
    /** Last sung: the files kept on Core go a day after. */
    used_at: micros(),
  },
  (t) => [
    uniqueIndex("karaoke_songs_source_idx").on(t.source_key),
    index("karaoke_songs_status_idx").on(t.status, t.created_at),
    check("karaoke_songs_status_check", sql`${t.status} IN ('preparing', 'ready', 'failed')`),
  ],
);

export const karaokeRequests = sqliteTable(
  "karaoke_requests",
  {
    id: text().primaryKey(),
    person_id: text().notNull(),
    song_id: text().notNull(),
    created_at: micros().notNull(),
  },
  (t) => [index("karaoke_requests_person_idx").on(t.person_id, t.created_at)],
);

export const karaokeSessions = sqliteTable(
  "karaoke_sessions",
  {
    id: text().primaryKey(),
    song_id: text().notNull(),
    /** `null` for an account she has no person for. */
    person_id: text(),
    platform: text().notNull(),
    account_id: text().notNull(),
    /** Their display name when they started (untrusted). */
    name: text().notNull(),
    status: text().notNull(),
    started_at: micros().notNull(),
    expires_at: micros().notNull(),
    scored_at: micros(),
    /** Semitones the singer moved the key by (-6..6): the backing and the reference both moved. */
    shift: integer().notNull().default(0),
  },
  (t) => [
    index("karaoke_sessions_account_idx").on(t.platform, t.account_id, t.started_at),
    index("karaoke_sessions_person_idx").on(t.person_id),
    check("karaoke_sessions_status_check", sql`${t.status} IN ('open', 'scored')`),
  ],
);

export const karaokeTracks = sqliteTable(
  "karaoke_tracks",
  {
    session_id: text().primaryKey(),
    hz: integer().notNull(),
    /** One byte a frame (0 = not voiced, else MIDI 24 + a quarter semitone a step), base64. */
    frames: text().notNull(),
    latency_ms: integer().notNull(),
    calibrated: integer({ mode: "boolean" }).notNull(),
    browser: text().notNull().default(""),
    submitted_at: micros().notNull(),
    purge_at: micros().notNull(),
    /** The recording's pitch, placed in song time, in the same form (migration 3); never the sound. */
    voice_frames: text(),
  },
  (t) => [index("karaoke_tracks_purge_idx").on(t.purge_at)],
);

export const karaokeResults = sqliteTable(
  "karaoke_results",
  {
    session_id: text().primaryKey(),
    song_id: text().notNull(),
    person_id: text(),
    total: real().notNull(),
    pitch: real().notNull(),
    stability: real().notNull(),
    rhythm: real().notNull(),
    expression: real().notNull(),
    /** Flagged as not sung: shown, never a best; `reasons` (JSON) are the owner's to see. */
    unranked: integer({ mode: "boolean" }).notNull().default(false),
    reasons: text().notNull().default("[]"),
    /** The whole result as JSON (the API's `KaraokeResult` without the comment). */
    detail: text().notNull(),
    client_total: real(),
    best_before: real(),
    /** `waiting`, `said`, `none`. */
    comment_state: text().notNull(),
    comment: text(),
    /** The channel she was told to comment in, and when she was told. */
    channel: text(),
    noted_at: micros(),
    comment_at: micros(),
    created_at: micros().notNull(),
    /** `estimate` (the browser's track) or `voice` (the recording: the official score). */
    source: text().notNull().default("estimate"),
    /** `none`, `waiting`, `scoring`, `scored`, `failed`: what became of the recording. */
    voice_state: text().notNull().default("none"),
    /** Core's score of the browser's track, kept when the recording's replaces it. */
    estimate_total: real(),
    /** What the checks of the recording found, shown to the singer (JSON: `quiet`, `bleed`). */
    checks: text().notNull().default("[]"),
  },
  (t) => [
    index("karaoke_results_person_idx").on(t.person_id, t.song_id, t.created_at),
    index("karaoke_results_comment_idx").on(t.comment_state, t.channel, t.noted_at),
    check("karaoke_results_comment_check", sql`${t.comment_state} IN ('waiting', 'said', 'none')`),
  ],
);
