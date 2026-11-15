// Legacy migration 8 (was `0008_directives.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 9a of docs/design/v5-data.md
// §8 took out `directives` and its indexes: the owner's rules are the `directive` plugin's
// `directive_rules` (`packages/brain/directive/src/schema.ts`). It stays, as a comment, so the
// versions keep their numbers.

export const m0008 = `-- Directives (docs/design/v3-architecture.md §9): the owner's rules.
-- The table went: the rules are the directive plugin's directive_rules.
`;
