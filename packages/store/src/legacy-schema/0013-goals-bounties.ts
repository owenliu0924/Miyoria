// Legacy migration 13 (was `0013_goals_bounties.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `goals`, `goal_pledges`, `bounties` and their indexes: they are the `economy`
// plugin's `economy_goals`, `economy_goal_pledges` and `economy_bounties`
// (`packages/economy/src/schema.ts`). It stays, as a comment, so the versions keep their numbers.

export const m0013 = `-- Her own money (docs/design/economy.md §13): crowdfunding goals and bounties.
-- The tables went: they are the economy plugin's economy_goals, economy_goal_pledges and
-- economy_bounties.
`;
