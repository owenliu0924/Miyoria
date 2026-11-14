// Legacy migration 1 (was `0001_init.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 4 of docs/design/v5-data.md
// §8 took out `people` and `accounts` (and `link_codes` from migration 3). The `identity` schema
// owns `persons`, `accounts` and `link_codes` now, and it migrates before `legacy`.

export const m0001 = `-- Phase-1 schema (SQLite port of migrations/postgres/0001_init.sql). Ids are ULIDs stored as
-- text. Data that belongs to one character carries \`profile_id\`. Timestamps are INTEGER
-- microseconds since the Unix epoch (PostgreSQL's precision); booleans are 0 / 1.

-- Conversation log (working memory source), per profile and context.
CREATE TABLE message_log (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE,
    profile_id   TEXT    NOT NULL,
    -- Canonical JSON of the \`ContextKey\`, used for lookups.
    context_key  TEXT    NOT NULL,
    platform     TEXT    NOT NULL,
    scope        TEXT,
    channel      TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    author_platform TEXT NOT NULL,
    author_id    TEXT    NOT NULL,
    author_name  TEXT    NOT NULL,
    text         TEXT    NOT NULL,
    is_self      INTEGER NOT NULL,
    ts           INTEGER NOT NULL,
    turn_id      TEXT
);

CREATE INDEX message_log_recent_idx
    ON message_log (profile_id, context_key, ts DESC, seq DESC);

-- Runtime enabled / disabled flag per module (node-wide, not per profile).
CREATE TABLE module_state (
    module_id   TEXT    PRIMARY KEY,
    enabled     INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Versioned runtime edits of persona sections.
CREATE TABLE persona_overrides (
    profile_id  TEXT    NOT NULL,
    section_key TEXT    NOT NULL,
    version     INTEGER NOT NULL,
    body        TEXT    NOT NULL,
    edited_by   TEXT    NOT NULL,
    edited_at   INTEGER NOT NULL,
    PRIMARY KEY (profile_id, section_key, version)
);
`;
