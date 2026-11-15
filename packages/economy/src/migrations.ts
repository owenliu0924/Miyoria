// The `economy` plugin's migrations (docs/design/v5-data.md §3.2).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// economy` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`economy_deals\` (
	\`id\` text PRIMARY KEY,
	\`account_id\` text NOT NULL,
	\`reward_item\` text NOT NULL,
	\`reward_count\` integer NOT NULL,
	\`reward_value\` integer NOT NULL,
	\`task\` text NOT NULL,
	\`prepaid\` integer DEFAULT false NOT NULL,
	\`escrow_entry\` text,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`done_at\` integer,
	\`due_at\` integer,
	\`closed_at\` integer,
	CONSTRAINT \`fk_economy_deals_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT "economy_deals_status_check" CHECK("status" IN ('open','owed','settled','broken','refunded','cancelled'))
) STRICT;

CREATE TABLE \`economy_ledger\` (
	\`seq\` integer PRIMARY KEY AUTOINCREMENT,
	\`id\` text NOT NULL,
	\`person_id\` text NOT NULL,
	\`delta\` integer NOT NULL,
	\`reason\` text NOT NULL,
	\`ref\` text,
	\`idem_key\` text,
	\`ts\` integer NOT NULL
) STRICT;

CREATE TABLE \`economy_wallets\` (
	\`person_id\` text PRIMARY KEY,
	\`frame\` text,
	\`updated_at\` integer NOT NULL,
	\`off_board\` integer DEFAULT false NOT NULL,
	CONSTRAINT \`fk_economy_wallets_person_id_persons_id_fk\` FOREIGN KEY (\`person_id\`) REFERENCES \`persons\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE INDEX \`economy_deals_account_idx\` ON \`economy_deals\` (\`account_id\`,\`created_at\`);

CREATE INDEX \`economy_deals_status_idx\` ON \`economy_deals\` (\`status\`,\`due_at\`);

CREATE UNIQUE INDEX \`economy_ledger_id_idx\` ON \`economy_ledger\` (\`id\`);

CREATE UNIQUE INDEX \`economy_ledger_idem_idx\` ON \`economy_ledger\` (\`person_id\`,\`idem_key\`);

CREATE INDEX \`economy_ledger_person_idx\` ON \`economy_ledger\` (\`person_id\`,\`ts\`);

CREATE INDEX \`economy_ledger_reason_idx\` ON \`economy_ledger\` (\`reason\`,\`ts\`);
`;

/** The coin ledger, the wallets and the deals. */
export const economySchema: PluginSchema = {
  plugin: "economy",
  requires: ["identity"],
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
