// Legacy migration 4 (was `0004_memory_source.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9b of docs/design/v5-data.md
// §8 took out the column it added, `memory_records.source`: the table is the `memory` plugin's
// (`packages/memory/memory/src/schema.ts`). It stays, as a comment, so the versions keep their
// numbers.

export const m0004 = `-- Who told her a memory (\`remember\`).
-- The column is the memory plugin's memory_records.source.
`;
