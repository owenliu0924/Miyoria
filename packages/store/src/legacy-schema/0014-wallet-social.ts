// Legacy migration 14 (was `0014_wallet_social.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out the sponsor board's `coin_wallets.on_board` (no longer read since migration 15) and
// `fortunes` with its index: the fortune slips are the `economy` plugin's `economy_fortunes`
// (`packages/economy/src/schema.ts`). It stays, as a comment, so the versions keep their numbers.

export const m0014 = `-- People with each other (docs/design/economy.md §13): the sponsor board and fortune slips.
-- The table and the column went: they are the economy plugin's economy_fortunes and
-- economy_wallets.
`;
