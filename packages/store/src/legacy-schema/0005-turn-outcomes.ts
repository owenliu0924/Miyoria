// Legacy migration 5 (was `0005_turn_outcomes.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 6 of docs/design/v5-data.md
// §8 took out `turn_outcomes` and its indexes: how a turn ended is an event (`events/turns.ts`).
// It stays, as a comment, so the versions keep their numbers.

export const m0005 = `-- How each agent turn ended (sent / silence / cancelled / error).
-- The table went: turn outcomes are events (core migration 4).
`;
