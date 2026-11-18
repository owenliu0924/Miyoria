// The `karaoke` plugin's migrations (docs/design/v5-data.md §3.2, karaoke.md).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// karaoke` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`karaoke_requests\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`song_id\` text NOT NULL,
	\`created_at\` integer NOT NULL
) STRICT;

CREATE TABLE \`karaoke_results\` (
	\`session_id\` text PRIMARY KEY,
	\`song_id\` text NOT NULL,
	\`person_id\` text,
	\`total\` real NOT NULL,
	\`pitch\` real NOT NULL,
	\`stability\` real NOT NULL,
	\`rhythm\` real NOT NULL,
	\`expression\` real NOT NULL,
	\`unranked\` integer DEFAULT false NOT NULL,
	\`reasons\` text DEFAULT '[]' NOT NULL,
	\`detail\` text NOT NULL,
	\`client_total\` real,
	\`best_before\` real,
	\`comment_state\` text NOT NULL,
	\`comment\` text,
	\`channel\` text,
	\`noted_at\` integer,
	\`comment_at\` integer,
	\`created_at\` integer NOT NULL,
	CONSTRAINT "karaoke_results_comment_check" CHECK("comment_state" IN ('waiting', 'said', 'none'))
) STRICT;

CREATE TABLE \`karaoke_sessions\` (
	\`id\` text PRIMARY KEY,
	\`song_id\` text NOT NULL,
	\`person_id\` text,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`status\` text NOT NULL,
	\`started_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`scored_at\` integer,
	CONSTRAINT "karaoke_sessions_status_check" CHECK("status" IN ('open', 'scored'))
) STRICT;

CREATE TABLE \`karaoke_songs\` (
	\`id\` text PRIMARY KEY,
	\`source_key\` text NOT NULL,
	\`source\` text NOT NULL,
	\`title\` text DEFAULT '' NOT NULL,
	\`artist\` text,
	\`duration_ms\` integer,
	\`status\` text NOT NULL,
	\`job\` text,
	\`worker_song\` text,
	\`error\` text,
	\`error_detail\` text,
	\`lyrics\` integer DEFAULT false NOT NULL,
	\`notes\` integer DEFAULT 0 NOT NULL,
	\`requested_by\` text,
	\`created_at\` integer NOT NULL,
	\`ready_at\` integer,
	\`used_at\` integer,
	CONSTRAINT "karaoke_songs_status_check" CHECK("status" IN ('preparing', 'ready', 'failed'))
) STRICT;

CREATE TABLE \`karaoke_tracks\` (
	\`session_id\` text PRIMARY KEY,
	\`hz\` integer NOT NULL,
	\`frames\` text NOT NULL,
	\`latency_ms\` integer NOT NULL,
	\`calibrated\` integer NOT NULL,
	\`browser\` text DEFAULT '' NOT NULL,
	\`submitted_at\` integer NOT NULL,
	\`purge_at\` integer NOT NULL
) STRICT;

CREATE INDEX \`karaoke_requests_person_idx\` ON \`karaoke_requests\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`karaoke_results_person_idx\` ON \`karaoke_results\` (\`person_id\`,\`song_id\`,\`created_at\`);

CREATE INDEX \`karaoke_results_comment_idx\` ON \`karaoke_results\` (\`comment_state\`,\`channel\`,\`noted_at\`);

CREATE INDEX \`karaoke_sessions_account_idx\` ON \`karaoke_sessions\` (\`platform\`,\`account_id\`,\`started_at\`);

CREATE INDEX \`karaoke_sessions_person_idx\` ON \`karaoke_sessions\` (\`person_id\`);

CREATE UNIQUE INDEX \`karaoke_songs_source_idx\` ON \`karaoke_songs\` (\`source_key\`);

CREATE INDEX \`karaoke_songs_status_idx\` ON \`karaoke_songs\` (\`status\`,\`created_at\`);

CREATE INDEX \`karaoke_tracks_purge_idx\` ON \`karaoke_tracks\` (\`purge_at\`);
`;

/** Step 2: the key a session is sung in, and where a song's lyrics came from. */
const KEY_AND_LYRICS = `ALTER TABLE \`karaoke_sessions\` ADD \`shift\` integer DEFAULT 0 NOT NULL;
ALTER TABLE \`karaoke_songs\` ADD \`lyrics_source\` text;
`;

/** The songs, requests, sessions, tracks and results. */
export const karaokeSchema: PluginSchema = {
  plugin: "karaoke",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "key_and_lyrics", sql: KEY_AND_LYRICS },
  ],
};
