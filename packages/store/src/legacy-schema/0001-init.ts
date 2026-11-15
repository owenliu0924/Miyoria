// Legacy migration 1 (was `0001_init.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 4 of docs/design/v5-data.md
// §8 took out `people` and `accounts` (and `link_codes` from migration 3). The `identity` schema
// owns `persons`, `accounts` and `link_codes` now, and it migrates before `legacy`. Step 5 took
// out `message_log` (and its index from migration 9): chat lines are events (`events/chat.ts`).
// Step 8 took out `module_state`: module on/off is the `enabled` flag in the current config
// revision (the `config` schema). Step 9a took out `persona_overrides`: runtime persona edits are
// the `config` schema's `config_persona_overrides`.

export const m0001 = `-- Phase-1 schema (SQLite port of migrations/postgres/0001_init.sql). Ids are ULIDs stored as
-- text. Data that belongs to one character carries \`profile_id\`. Timestamps are INTEGER
-- microseconds since the Unix epoch (PostgreSQL's precision); booleans are 0 / 1.

-- Module on/off is the enabled flag in the current config revision (config migration 1).

-- Runtime persona edits are config_persona_overrides (config migration 1).
`;
