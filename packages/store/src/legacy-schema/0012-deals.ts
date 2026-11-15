// Legacy migration 12 (was `0012_deals.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `deals` and its indexes: the deals are the `economy` plugin's `economy_deals`
// (`packages/economy/src/schema.ts`). It stays, as a comment, so the versions keep their numbers.

export const m0012 = `-- Deals (docs/design/economy.md §12): a bribe she accepted.
-- The table went: the deals are the economy plugin's economy_deals.
`;
