// Legacy migration 17 (was `0017_goal_fulfilled.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `goals` (migration 13), so its kept-promise columns went with it: they are
// `economy_goals.fulfilled_at` and `fulfilled_by` (`packages/economy/src/schema.ts`). It stays, as
// a comment, so the versions keep their numbers.

export const m0017 = `-- A reached goal's promise kept (docs/design/economy.md §13).
-- The columns went with goals: they are the economy plugin's economy_goals.fulfilled_at and
-- fulfilled_by.
`;
