// Legacy migration 15 (was `0015_off_board.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `coin_wallets` (migration 11), so its `off_board` column went with it: leaving the
// sponsor board is `economy_wallets.off_board` (`packages/economy/src/schema.ts`). It stays, as a
// comment, so the versions keep their numbers.

export const m0015 = `-- The sponsor board is opt-out (docs/design/economy.md §13).
-- The column went with coin_wallets: it is the economy plugin's economy_wallets.off_board.
`;
