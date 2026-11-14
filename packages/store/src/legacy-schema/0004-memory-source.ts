// Legacy migration 4 (was `0004_memory_source.sql`). Never edit it: its checksum is recorded.

export const m0004 = `-- Who told her a memory (\`remember\`): JSON \`{"account": {...}, "name": "..."}\`; NULL for
-- memories she extracted herself.
ALTER TABLE memory_records ADD COLUMN source TEXT;
`;
