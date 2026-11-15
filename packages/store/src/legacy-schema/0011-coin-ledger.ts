// Legacy migration 11 (was `0011_coin_ledger.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `coin_ledger`, `coin_wallets` and their indexes: the coins and the wallets are the
// `economy` plugin's `economy_ledger` and `economy_wallets` (`packages/economy/src/schema.ts`),
// keyed by person. It stays, as a comment, so the versions keep their numbers.

export const m0011 = `-- Coins (docs/design/economy.md §6): an append-only ledger and the wallets' choices.
-- The tables went: they are the economy plugin's economy_ledger and economy_wallets.
`;
