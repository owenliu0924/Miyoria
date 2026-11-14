// Core migration 2: the event log (docs/design/v5-data.md §2.2). Hand-written SQL, not Drizzle:
// the redaction trigger, the partial indexes and the JSON views of later steps are outside what
// Drizzle declares (research_notes/v5/drizzle-trial.md). Never edit it once a V5 database exists.
//
// Differences from the design's draft, on purpose:
// - `seq` is AUTOINCREMENT: compaction deletes rows, and a paging cursor must never be reused
//   (without it SQLite hands out the highest deleted `seq` again).
// - `events_source_idx`: the facts module reads its lifecycle lines by source at every start, and
//   the panel filters by source; without it both scan the whole table.
// - The trigger checks every envelope column, not only the draft's list (`v`, the place ids,
//   `account_id` and `key` could otherwise change on a redaction).

export const EVENTS_SQL = `-- One table is the raw record: what she perceived, thought, decided, said and did.
CREATE TABLE events (
    -- Commit order; the paging cursor. Never reused.
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- ULID made when the event was created; appending the same id again stores it once.
    id           TEXT    NOT NULL UNIQUE,
    -- When it happened, microseconds since the epoch.
    at           INTEGER NOT NULL,
    -- Registered type.
    type         TEXT    NOT NULL,
    -- Schema version of \`data\` for this type.
    v            INTEGER NOT NULL DEFAULT 1,
    -- Stamped by Core: the plugin, provider or host it came from.
    source       TEXT    NOT NULL,
    -- The id of the causing event.
    parent       TEXT,
    turn         TEXT,
    -- Session key ('discord:<g>:<c>', 'discord:dm:<person>', 'home').
    session      TEXT,
    -- Copied from the session for scope checks. No foreign keys: the log takes rows for places
    -- and people that are not resolved yet, and a check on every insert costs time.
    space_id     TEXT,
    room_id      TEXT,
    -- The acting person (a person id, never a handle) and account.
    person_id    TEXT,
    account_id   TEXT,
    scope        TEXT    NOT NULL CHECK (scope IN ('public', 'space', 'room', 'dm', 'self', 'owner')),
    tier         TEXT    NOT NULL CHECK (tier IN ('keep', 'long', 'short', 'ambient')),
    -- Attention and dedupe key, e.g. 'msg:discord:<id>'.
    key          TEXT,
    -- JSON text.
    data         TEXT    NOT NULL,
    -- Set once by redact(), together with data = '{"redacted":true}'.
    redacted_at  INTEGER
) STRICT;

CREATE INDEX events_type_idx    ON events (type, seq);
CREATE INDEX events_source_idx  ON events (source, seq);
CREATE INDEX events_session_idx ON events (session, seq) WHERE session IS NOT NULL;
CREATE INDEX events_person_idx  ON events (person_id, type, at) WHERE person_id IS NOT NULL;
CREATE INDEX events_turn_idx    ON events (turn) WHERE turn IS NOT NULL;
CREATE INDEX events_parent_idx  ON events (parent) WHERE parent IS NOT NULL;
CREATE INDEX events_key_idx     ON events (key) WHERE key IS NOT NULL;
CREATE INDEX events_tier_idx    ON events (tier, at);
CREATE INDEX events_at_idx      ON events (at);

-- Rows never change, with one exception: redact() replaces \`data\` and sets \`redacted_at\`, once.
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
          AND NEW.data = '{"redacted":true}'
          AND NEW.seq = OLD.seq AND NEW.id = OLD.id AND NEW.at = OLD.at
          AND NEW.type = OLD.type AND NEW.v = OLD.v AND NEW.source = OLD.source
          AND NEW.parent IS OLD.parent AND NEW.turn IS OLD.turn AND NEW.session IS OLD.session
          AND NEW.space_id IS OLD.space_id AND NEW.room_id IS OLD.room_id
          AND NEW.person_id IS OLD.person_id AND NEW.account_id IS OLD.account_id
          AND NEW.scope = OLD.scope AND NEW.tier = OLD.tier AND NEW.key IS OLD.key)
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

-- What compaction removed, per UTC day (microseconds of its start), type and source.
CREATE TABLE event_rollups (
    day      INTEGER NOT NULL,
    type     TEXT    NOT NULL,
    source   TEXT    NOT NULL,
    count    INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at  INTEGER NOT NULL,
    PRIMARY KEY (day, type, source)
) STRICT;
`;
