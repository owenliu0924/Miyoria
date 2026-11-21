// The `gifts` plugin's migrations (docs/design/economy.md §16).
//
// Generated from the Drizzle tables in `gift-schema.ts` with `pnpm --filter @miyoria/store schema:sql
// gifts` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner refuses a
// database whose recorded checksum differs. The store's drift test proves the migrated database
// and the Drizzle tables agree. Additive: nothing of the economy's own tables changes.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`gifts_prices\` (
	\`item_key\` text PRIMARY KEY,
	\`item\` text NOT NULL,
	\`kind\` text,
	\`tier\` integer,
	\`refuse\` text,
	\`source\` text NOT NULL,
	\`by\` text,
	\`at\` integer NOT NULL,
	CONSTRAINT "gifts_prices_source_check" CHECK("source" IN ('model','pinned','blocked'))
) STRICT;

CREATE TABLE \`gifts_requests\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text,
	\`platform\` text,
	\`account_id\` text,
	\`name\` text NOT NULL,
	\`item\` text NOT NULL,
	\`item_key\` text NOT NULL,
	\`kind\` text,
	\`tier\` integer,
	\`price\` integer DEFAULT 0 NOT NULL,
	\`priced_by\` text NOT NULL,
	\`asked_model\` integer DEFAULT false NOT NULL,
	\`hunger\` real DEFAULT 0 NOT NULL,
	\`status\` text NOT NULL,
	\`reason\` text,
	\`source\` text NOT NULL,
	\`request_key\` text NOT NULL,
	\`entry_id\` text,
	\`line\` text,
	\`favourite\` integer DEFAULT false NOT NULL,
	\`answered_by\` text,
	\`refunded_by\` text,
	\`created_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`confirmed_at\` integer,
	\`answer_due\` integer,
	\`answered_at\` integer,
	\`refunded_at\` integer,
	CONSTRAINT "gifts_requests_status_check" CHECK("status" IN ('pending','cancelled','expired','rejected','confirmed','accepted','refused','refunded','refund_due')),
	CONSTRAINT "gifts_requests_price_check" CHECK("price" >= 0 AND "hunger" >= 0)
) STRICT;

CREATE INDEX \`gifts_prices_source_idx\` ON \`gifts_prices\` (\`source\`,\`at\`);

CREATE UNIQUE INDEX \`gifts_requests_key_idx\` ON \`gifts_requests\` (\`person_id\`,\`request_key\`);

CREATE INDEX \`gifts_requests_person_idx\` ON \`gifts_requests\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`gifts_requests_status_idx\` ON \`gifts_requests\` (\`status\`,\`created_at\`);

CREATE INDEX \`gifts_requests_created_idx\` ON \`gifts_requests\` (\`created_at\`);
`;

/** The gift requests and the price cache with the owner's pins and blocks. */
export const giftSchema: PluginSchema = {
  plugin: "gifts",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
