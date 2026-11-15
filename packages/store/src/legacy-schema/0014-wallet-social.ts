// Legacy migration 14 (was `0014_wallet_social.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `coin_wallets` (migration 11), so its `on_board` column went with it (it was no
// longer read since migration 15).

export const m0014 = `-- People with each other (docs/design/economy.md §13): who is on the sponsor board, and the
-- fortune slips she writes. Transfers need no table; they are two ledger rows.

-- A fortune slip, at most one per person per local day. They go when the person asks her to
-- forget them.
CREATE TABLE fortunes (
    -- ULID.
    id              TEXT    PRIMARY KEY,
    profile_id      TEXT    NOT NULL,
    -- The session account it was written for.
    author_platform TEXT    NOT NULL,
    author_id       TEXT    NOT NULL,
    person_id       TEXT,
    -- The local day number (days since the epoch, at the API's UTC offset).
    day             INTEGER NOT NULL,
    issued_at       INTEGER NOT NULL,
    -- The \`fortune\` row of the coin ledger that paid for it.
    entry_id        TEXT,
    -- JSON of the slip: rank, title, poem, fields, line.
    slip            TEXT    NOT NULL
);

CREATE INDEX fortunes_author_idx
    ON fortunes (profile_id, author_platform, author_id, day);
`;
