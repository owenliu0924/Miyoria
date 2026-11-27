// The `sandbox` plugin's migrations: the jobs Core has open on the computers of the cluster
// (docs/design/v6-sandbox.md §9.3). Generated from the Drizzle definition in the store's
// `scripts/schema-sql.ts` (plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. Later changes only add tables or columns.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`sandbox_jobs\` (
	\`id\` text PRIMARY KEY,
	\`host\` text NOT NULL,
	\`service\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`name\` text,
	\`folder\` text,
	\`payer\` text,
	\`for\` text NOT NULL,
	\`state\` text NOT NULL,
	\`ended_reason\` text,
	\`manifest\` text,
	\`cpu_ms\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	CONSTRAINT "sandbox_jobs_kind_check" CHECK("kind" IN ('run','session','browser','plugin')),
	CONSTRAINT "sandbox_jobs_state_check" CHECK("state" IN ('open','ended'))
) STRICT;

CREATE INDEX \`sandbox_jobs_open_idx\` ON \`sandbox_jobs\` (\`state\`) WHERE "sandbox_jobs"."state" = 'open';
`;

/** The jobs Core opened on the computers of the cluster, and what it knows of each. */
export const sandboxSchema: PluginSchema = {
  plugin: "sandbox",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
