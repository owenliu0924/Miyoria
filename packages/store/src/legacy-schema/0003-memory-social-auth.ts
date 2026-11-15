// Legacy migration 3 (was `0003_memory_social_auth.sql`). Never edit it: its checksum is recorded.
// Step 4 of docs/design/v5-data.md §8 took `link_codes` out (see `0001-init.ts`). Step 6 took out
// `audit_log` and its indexes: audit entries are events (`events/audit.ts`). Step 9a took out
// `roles`, `role_assignments`, `role_mappings` and `node_overrides`: they are the `auth` plugin's
// tables (`packages/auth/src/schema.ts`). Step 9b took out `memory_records` with its indexes, the
// full-text index `memory_fts` and its triggers: they are the `memory` plugin's tables
// (`packages/memory/memory/src/schema.ts`, `migrations.ts`).

export const m0003 = `-- Long-term memory, relationships, identity linking and roles.
-- Ids are ULIDs stored as text. Per-character data carries \`profile_id\`.
-- Arrays (\`subjects\`, \`tags\`, \`grants\`, \`denies\`) are JSON text arrays.

-- Memory records and their full-text index are the memory plugin's tables.

-- One profile's feelings about one person, plus the change history.
CREATE TABLE relationships (
    profile_id       TEXT    NOT NULL,
    person_id        TEXT    NOT NULL,
    affinity         REAL    NOT NULL,
    trust            REAL    NOT NULL,
    familiarity      REAL    NOT NULL,
    tags             TEXT    NOT NULL DEFAULT '[]',
    notes            TEXT    NOT NULL,
    call_name        TEXT,
    interactions     INTEGER NOT NULL DEFAULT 0,
    last_interaction INTEGER,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (profile_id, person_id)
);

CREATE TABLE relationship_deltas (
    seq         INTEGER PRIMARY KEY,
    profile_id  TEXT    NOT NULL,
    person_id   TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    affinity    REAL    NOT NULL,
    trust       REAL    NOT NULL,
    familiarity REAL    NOT NULL,
    reason      TEXT    NOT NULL
);

CREATE INDEX relationship_deltas_idx
    ON relationship_deltas (profile_id, person_id, at, seq);

-- Roles, role assignments, role mappings and node overrides are the auth plugin's tables.
`;
