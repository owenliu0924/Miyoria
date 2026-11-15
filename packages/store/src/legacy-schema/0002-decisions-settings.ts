// Legacy migration 2 (was `0002_decisions_settings.sql`). Never edit it: its checksum is recorded.
//
// Exceptions, before any V5 database existed outside tests: step 6 of docs/design/v5-data.md §8
// took out `decision_log` and its indexes: her decisions are events (`events/turns.ts`). Step 8
// took out `profile_settings`: settings are rows of `plugin_state` (the `config` schema). It
// stays, as a comment, so the versions keep their numbers.

export const m0002 = `-- Small per-profile runtime settings. (Attention decisions are events: core migration 4.)
-- The settings table went: settings are rows of plugin_state (config migration 1).
`;
