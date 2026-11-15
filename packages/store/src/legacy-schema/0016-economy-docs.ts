// Legacy migration 16 (was `0016_economy_docs.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `economy_docs` and its indexes: economy 2.0's documents are the `economy` plugin's
// table of the same name (`packages/economy/src/schema.ts`), by account. It stays, as a comment,
// so the versions keep their numbers.

export const m0016 = `-- Economy 2.0 documents (docs/design/v4-plan.md §10).
-- The table went: it is the economy plugin's economy_docs.
`;
