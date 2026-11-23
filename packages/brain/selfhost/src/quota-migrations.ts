// The `quota` plugin's migrations.
//
// Generated from the Drizzle table in `quota-schema.ts` with `pnpm --filter @miyoria/store
// schema:sql quota` (drizzle-kit, plus `STRICT`) and never edited after it is released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle table agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`quota_spend\` (
	\`person\` text NOT NULL,
	\`slot\` text NOT NULL,
	\`key\` text NOT NULL,
	\`micros\` integer DEFAULT 0 NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT \`quota_spend_pk\` PRIMARY KEY(\`person\`, \`slot\`, \`key\`),
	CONSTRAINT "quota_spend_slot_check" CHECK("slot" IN ('minute','day')),
	CONSTRAINT "quota_spend_micros_check" CHECK("micros" >= 0)
) STRICT;

CREATE INDEX \`quota_spend_slot_idx\` ON \`quota_spend\` (\`slot\`,\`key\`);
`;

/** Each person's AI quota as it was spent. */
export const quotaSchema: PluginSchema = {
  plugin: "quota",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
