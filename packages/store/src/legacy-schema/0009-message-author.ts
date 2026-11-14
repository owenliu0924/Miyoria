// Legacy migration 9 (was `0009_message_author.sql`). Never edit it: its checksum is recorded.

export const m0009 = `-- What someone wrote over time, for the member page's chart (docs/design/v3-architecture.md §17.1).
CREATE INDEX message_log_author_idx
    ON message_log (profile_id, author_platform, author_id, ts);
`;
