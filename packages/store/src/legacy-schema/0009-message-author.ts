// Legacy migration 9 (was `0009_message_author.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 5 of docs/design/v5-data.md
// §8 took out its index together with `message_log` (legacy migration 1). It stays, as a comment,
// so the versions keep their numbers.

export const m0009 = `-- What someone wrote over time, for the member page's chart (docs/design/v3-architecture.md §17.1).
-- The index on message_log went with the table: chat lines are events (core migration 3).
`;
