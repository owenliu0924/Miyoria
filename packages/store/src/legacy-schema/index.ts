// The `legacy` schema: the store's tables as V4 left them (migrations 0001-0018), wrapped as one
// temporary schema so the V5 runner records them in `_migrations`. Its tables keep their names,
// so it is exempt from the prefix lint. Later steps move each table into the plugin that owns it;
// step 14 of docs/design/v5-data.md §8 deletes this schema.

import type { PluginSchema } from "../migrate.js";
import { m0001 } from "./0001-init.js";
import { m0002 } from "./0002-decisions-settings.js";
import { m0003 } from "./0003-memory-social-auth.js";
import { m0004 } from "./0004-memory-source.js";
import { m0005 } from "./0005-turn-outcomes.js";
import { m0006 } from "./0006-event-log.js";
import { m0007 } from "./0007-memory-provenance.js";
import { m0008 } from "./0008-directives.js";
import { m0009 } from "./0009-message-author.js";
import { m0010 } from "./0010-member-card.js";
import { m0011 } from "./0011-coin-ledger.js";
import { m0012 } from "./0012-deals.js";
import { m0013 } from "./0013-goals-bounties.js";
import { m0014 } from "./0014-wallet-social.js";
import { m0015 } from "./0015-off-board.js";
import { m0016 } from "./0016-economy-docs.js";
import { m0017 } from "./0017-goal-fulfilled.js";
import { m0018 } from "./0018-memory-vector-version.js";

/** The store's V4 tables. Temporary: see the file comment. */
export const legacySchema: PluginSchema = {
  plugin: "legacy",
  migrations: [
    { version: 1, name: "init", sql: m0001 },
    { version: 2, name: "decisions_settings", sql: m0002 },
    { version: 3, name: "memory_social_auth", sql: m0003 },
    { version: 4, name: "memory_source", sql: m0004 },
    { version: 5, name: "turn_outcomes", sql: m0005 },
    { version: 6, name: "event_log", sql: m0006 },
    { version: 7, name: "memory_provenance", sql: m0007 },
    { version: 8, name: "directives", sql: m0008 },
    { version: 9, name: "message_author", sql: m0009 },
    { version: 10, name: "member_card", sql: m0010 },
    { version: 11, name: "coin_ledger", sql: m0011 },
    { version: 12, name: "deals", sql: m0012 },
    { version: 13, name: "goals_bounties", sql: m0013 },
    { version: 14, name: "wallet_social", sql: m0014 },
    { version: 15, name: "off_board", sql: m0015 },
    { version: 16, name: "economy_docs", sql: m0016 },
    { version: 17, name: "goal_fulfilled", sql: m0017 },
    { version: 18, name: "memory_vector_version", sql: m0018 },
  ],
};
