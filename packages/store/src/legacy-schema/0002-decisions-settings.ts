// Legacy migration 2 (was `0002_decisions_settings.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 6 of docs/design/v5-data.md
// §8 took out `decision_log` and its indexes: her decisions are events (`events/turns.ts`).

export const m0002 = `-- Small per-profile runtime settings. (Attention decisions are events: core migration 4.)

-- Free-form JSON settings per profile, keyed \`area:subkey\` by convention.
CREATE TABLE profile_settings (
    profile_id  TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    -- JSON text.
    value       TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, key)
);
`;
