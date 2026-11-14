// Legacy migration 17 (was `0017_goal_fulfilled.sql`). Never edit it: its checksum is recorded.

export const m0017 = `-- A reached goal's promise kept (docs/design/economy.md §13): when it was marked done and by whom
-- (\`owner\` from the panel, \`self\` when she said so herself). NULL while it is still owed.
ALTER TABLE goals ADD COLUMN fulfilled_at INTEGER;
ALTER TABLE goals ADD COLUMN fulfilled_by TEXT;
`;
