// Legacy migration 7 (was `0007_memory_provenance.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9b of docs/design/v5-data.md
// §8 took out the columns it added to `memory_records` and the rows it marked: the table is the
// `memory` plugin's (`packages/memory/memory/src/schema.ts`), with `origin` and `source_events`,
// and V5 starts from an empty database. It stays, as a comment, so the versions keep their
// numbers.

export const m0007 = `-- Memory provenance (docs/design/v3-architecture.md §11): whether she lived it or was told it.
-- The columns are the memory plugin's memory_records.origin and memory_records.source_events.
`;
