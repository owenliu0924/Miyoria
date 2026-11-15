// Legacy migration 18 (was `0018_memory_vector_version.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9b of docs/design/v5-data.md
// §8 took out `memory_vector_version` and its triggers: they are the `memory` plugin's
// (`packages/memory/memory/src/migrations.ts`). It stays, as a comment, so the versions keep their
// numbers.

export const m0018 = `-- The counter vector search keeps decoded vectors by.
-- The table and its triggers went: they are the memory plugin's memory_vector_version.
`;
