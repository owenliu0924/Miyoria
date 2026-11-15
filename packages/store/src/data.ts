// Data categories: every kind of data the store holds for a profile, which tables / settings
// keys make it up, and the SQL to count, export and delete it. One definition, shared by the
// panel's data page (`/api/data/*`), the Discord `/admin memory wipe` and the factory reset.
//
// Settings keys belong to other packages; they are repeated here as strings (the store cannot
// depend on the modules), and `@miyoria/api`'s tests check them against the owners' constants.
// They are rows of plugin `settings` in `plugin_state` (`config/state.ts`): one key space, whatever
// profile their owners write them under, since one database belongs to one character.
//
// Invariants kept by the shape of the registry:
// - Consolidation watermarks (`memory_watermark:*`) exist only inside `messages`, so they are
//   never deleted without the log they point into (otherwise the log would be extracted into
//   memories again).
// - The audit log, LLM usage (the `llm.call` events) and panel sessions are `kept`: never deleted,
//   also not by a reset.
// - `roles` is reset, not emptied: the built-in roles are written again in the same
//   transaction, and the config owners (not stored) keep `owner`.

import type { JsonObject, JsonValue, ProfileId, Timestamp } from "@miyoria/types";
import { StoreError } from "./common.js";
import { ConfigRevised, SettingsChanged } from "./events/types.js";
import type { PersonPrefs } from "./identity/schema.js";
import { type ExportColumn, exportValue } from "./profile-data.js";
import type { RoleDefinition } from "./records.js";

/** Settings profile of node-wide settings (`arbiter:state`, `queue:state`, ...). */
export const GLOBAL_SETTINGS_PROFILE: ProfileId = "_global";

export type DataCategoryId =
  | "memories"
  | "relationships"
  | "call_names"
  | "inner"
  | "knowledge"
  | "learning"
  | "conversation"
  | "mood"
  | "messages"
  | "decisions"
  | "event_log"
  | "directives"
  | "initiative"
  | "artifacts"
  | "people"
  | "channels"
  | "voice_consent"
  | "privacy"
  | "queue"
  | "roles"
  | "persona"
  | "proposed_tools"
  | "extensions"
  | "module_state"
  | "other_settings"
  | "audit"
  | "llm_usage"
  | "panel_sessions";

/** A table, or the rows of a table that belong to the profile. */
export interface TablePart {
  kind: "table";
  id: string;
  table: string;
  /** `profile`: rows with `profile_id` = the profile; `node`: every row (shared). */
  rows: "profile" | "node";
  /** Column of the "last updated" time, if any. */
  updated: string | null;
  order: string;
  columns: Readonly<Record<string, ExportColumn>>;
  /** Only the rows matching this (a code constant, never input); `null`: every row. */
  where: string | null;
  /** Where the export reads `columns` from (a view over `table`); `null`: `table`. */
  exportFrom: string | null;
}

/**
 * Settings keys (rows of plugin `settings` in `plugin_state`). `profile` says which profile their
 * owners write them under, the profile's (`active`) or `_global` (`global`); both are one key
 * space now.
 */
export interface SettingsPart {
  kind: "settings";
  id: string;
  profile: "active" | "global";
  keys: readonly string[];
  prefixes: readonly string[];
}

/** `relationships.call_name` (cleared, the relationship stays). */
export interface CallNamesPart {
  kind: "call_names";
  id: string;
}

/** Settings keys that no other part covers. */
export interface OtherSettingsPart {
  kind: "other_settings";
  id: string;
}

/** One entry of `persons.prefs` (cleared, the person stays). */
export interface PrefsPart {
  kind: "prefs";
  id: string;
  key: keyof PersonPrefs;
}

/**
 * The modules' `enabled` flags in the current config revision (`config/revisions.ts`). Cleared by
 * writing the next revision without them (`ConfigModuleState.clear`), not by a statement; earlier
 * revisions keep theirs, as config history.
 */
export interface ModuleFlagsPart {
  kind: "module_flags";
  id: string;
}

export type DataPart =
  | TablePart
  | SettingsPart
  | CallNamesPart
  | OtherSettingsPart
  | PrefsPart
  | ModuleFlagsPart;

/** Parts that clear a column of rows another part may delete; they run first. */
function clears(part: DataPart): boolean {
  return part.kind === "call_names" || part.kind === "prefs";
}

export interface DataCategory {
  id: DataCategoryId;
  parts: readonly DataPart[];
  /** Deleting this category also deletes these (their data would point at nothing). */
  requires: readonly DataCategoryId[];
  /**
   * Modules caching this data: stopped around a delete (so a module saving its state on stop
   * cannot write the deleted state back) and started again afterwards.
   */
  modules: readonly string[];
  /** Shared by every profile on this node (people, roles, ...). */
  shared: boolean;
  /** Deleting needs the profile id typed (`typed`) or one confirmation (`simple`). */
  confirm: "typed" | "simple";
  /** Never deleted (read and export only). */
  kept: boolean;
  /** Never exported (secrets or hashes). */
  exportable: boolean;
}

const MEMORY_COLUMNS = {
  id: "text",
  kind: "text",
  scope: "json",
  subjects: "json",
  content: "text",
  importance: "num",
  confidence: "num",
  created_at: "ts",
  updated_at: "ts",
  last_accessed: "ts",
  access_count: "num",
  source_context: "json",
  source: "json",
  origin: "text",
  source_events: "json",
  due: "ts",
  done: "bool",
  superseded_by: "text",
} as const satisfies Record<string, ExportColumn>;

const RELATIONSHIP_COLUMNS = {
  person_id: "text",
  affinity: "num",
  trust: "num",
  familiarity: "num",
  tags: "json",
  notes: "text",
  call_name: "text",
  interactions: "num",
  last_interaction: "ts",
  updated_at: "ts",
} as const satisfies Record<string, ExportColumn>;

function table(
  id: string,
  name: string,
  rows: TablePart["rows"],
  updated: string | null,
  order: string,
  columns: Record<string, ExportColumn>,
  options: { where?: string; exportFrom?: string } = {},
): TablePart {
  return {
    kind: "table",
    id,
    table: name,
    rows,
    updated,
    order,
    columns,
    where: options.where ?? null,
    exportFrom: options.exportFrom ?? null,
  };
}

/** The chat lines among `events` (`events/chat.ts`): the conversation log. */
const CHAT_LINES = "type IN ('platform.message.created', 'voice.utterance', 'voice.playback')";
/** Her decisions among `events` (`events/turns.ts`). */
const DECISIONS = "type = 'agent.decision'";
/** How her turns ended, among `events` (`events/turns.ts`). */
const OUTCOMES = "type = 'agent.turn.outcome'";
/** The audit entries among `events` (`events/audit.ts`). */
const AUDIT = "type GLOB 'audit.*'";
/** The LLM calls among `events` (`events/llm.ts`). */
const LLM_CALLS = "type = 'llm.call'";
/** Configuration changes among `events` (`config/revisions.ts`, `config/places.ts`). */
const CONFIG_CHANGES = `type IN ('${ConfigRevised.type}', '${SettingsChanged.type}')`;

function settings(
  id: string,
  profile: SettingsPart["profile"],
  keys: string[],
  prefixes: string[] = [],
): SettingsPart {
  return { kind: "settings", id, profile, keys, prefixes };
}

function prefs(id: string, key: PrefsPart["key"]): PrefsPart {
  return { kind: "prefs", id, key };
}

function category(
  id: DataCategoryId,
  parts: DataPart[],
  options: Partial<Omit<DataCategory, "id" | "parts">> = {},
): DataCategory {
  return {
    id,
    parts,
    requires: options.requires ?? [],
    modules: options.modules ?? [],
    shared: options.shared ?? false,
    confirm: options.confirm ?? "typed",
    kept: options.kept ?? false,
    exportable: options.exportable ?? true,
  };
}

/** Every category, in display order. */
export const DATA_CATEGORIES: readonly DataCategory[] = [
  category(
    "memories",
    [
      table("memory_records", "memory_records", "profile", "updated_at", "created_at, id", {
        ...MEMORY_COLUMNS,
      }),
      // @miyoria/memory/memory `MAINTENANCE_KEY`
      settings("memory_maintenance", "active", ["memory_maintenance_last"]),
    ],
    { modules: ["memory", "arbiter"] },
  ),
  category(
    "relationships",
    [
      table("relationships", "relationships", "profile", "updated_at", "person_id", {
        ...RELATIONSHIP_COLUMNS,
      }),
      table("relationship_deltas", "relationship_deltas", "profile", "at", "seq", {
        person_id: "text",
        at: "ts",
        affinity: "num",
        trust: "num",
        familiarity: "num",
        reason: "text",
      }),
      // The member page's cards are snapshots of the relationship; they go with it.
      table("member_cards", "member_cards", "profile", "issued_at", "issued_at, serial", {
        serial: "text",
        author_platform: "text",
        author_id: "text",
        person_id: "text",
        issued_at: "ts",
        snapshot: "json",
      }),
      // Coins come from being with her; the wallet goes with the relationship, not with a forget.
      table("coin_ledger", "coin_ledger", "profile", "ts", "ts, id", {
        id: "text",
        author_platform: "text",
        author_id: "text",
        delta: "num",
        reason: "text",
        ref: "text",
        idem_key: "text",
        ts: "ts",
      }),
      table("coin_wallets", "coin_wallets", "profile", "updated_at", "author_platform, author_id", {
        author_platform: "text",
        author_id: "text",
        frame: "text",
        on_board: "bool",
        off_board: "bool",
        updated_at: "ts",
      }),
      // The fortune slips she wrote for them, kept like their cards.
      table("fortunes", "fortunes", "profile", "issued_at", "issued_at, id", {
        id: "text",
        author_platform: "text",
        author_id: "text",
        person_id: "text",
        day: "num",
        issued_at: "ts",
        entry_id: "text",
        slip: "json",
      }),
      // Deals are promises between her and a member, kept like the wallet.
      table("deals", "deals", "profile", "created_at", "created_at, id", {
        id: "text",
        author_platform: "text",
        author_id: "text",
        reward_item: "text",
        reward_count: "num",
        reward_value: "num",
        task: "text",
        prepaid: "bool",
        escrow_entry: "text",
        status: "text",
        created_at: "ts",
        done_at: "ts",
        due_at: "ts",
        closed_at: "ts",
      }),
      // Her crowdfunding goals, the pledges to them and the bounties from her purse.
      table("goals", "goals", "profile", "created_at", "created_at, id", {
        id: "text",
        title: "text",
        promise: "text",
        target: "num",
        status: "text",
        created_at: "ts",
        deadline: "ts",
        closed_at: "ts",
      }),
      table("goal_pledges", "goal_pledges", "profile", "created_at", "created_at, id", {
        id: "text",
        goal_id: "text",
        author_platform: "text",
        author_id: "text",
        amount: "num",
        created_at: "ts",
      }),
      table("bounties", "bounties", "profile", "created_at", "created_at, id", {
        id: "text",
        task: "text",
        reward: "num",
        hold_entry: "text",
        status: "text",
        created_at: "ts",
        expires_at: "ts",
        closed_at: "ts",
        winner_platform: "text",
        winner_id: "text",
      }),
      // Economy 2.0: collection items, predictions and bets, commissions, her room.
      table("economy_docs", "economy_docs", "profile", "updated_at", "created_at, id", {
        kind: "text",
        id: "text",
        owner_platform: "text",
        owner_id: "text",
        status: "text",
        version: "num",
        data: "json",
        created_at: "ts",
        updated_at: "ts",
      }),
    ],
    { modules: ["social", "agent"] },
  ),
  category("call_names", [{ kind: "call_names", id: "call_names" }], {
    modules: ["social", "agent"],
    confirm: "simple",
  }),
  category(
    "inner",
    // @miyoria/heart/self `STATE_KEY`, `FEELING_PREFIX`; @miyoria/heart/mind's thought journal and its
    // digests (`THOUGHT_PREFIX`, `DIGEST_PREFIX`), her goals and plan state (`GOAL_PREFIX`,
    // `GOAL_MIGRATION_KEY` and `PLAN_STATE_KEY` under `mind:plan:`)
    [
      settings("self_state", "active", ["self:state"]),
      settings("self_feelings", "active", [], ["self:feeling:"]),
      settings("self_cards_migration", "active", ["self:cards:migration"]),
      settings("mind_thoughts", "active", [], ["mind:thought:"]),
      settings("mind_digests", "active", [], ["mind:digest:"]),
      settings("mind_goals", "active", [], ["mind:goal:", "mind:plan:"]),
    ],
    { modules: ["self", "mind"] },
  ),
  // @miyoria/memory/learning `DOC_PREFIX`: her self-organized documents, whatever their shape.
  category("knowledge", [settings("knowledge_docs", "active", [], ["knowledge:doc:"])], {
    modules: ["knowledge"],
  }),
  // @miyoria/memory/learning `LESSON_PREFIX`, `RUN_PREFIX`, `REFLECT_STATE_KEY`, `FEEDBACK_PREFIX`
  category(
    "learning",
    [
      settings("lessons", "active", [], ["reflect:lesson:"]),
      settings("reflections", "active", ["reflect:state"], ["reflect:run:"]),
      settings("feedback", "active", [], ["feedback:day:"]),
    ],
    { modules: ["reflect"], confirm: "simple" },
  ),
  // @miyoria/memory/learning `STATE_PREFIX`: her running notes on each conversation (from the log).
  category(
    "conversation",
    [settings("conversation_states", "active", [], ["conversation:state:"])],
    {
      modules: ["conversation"],
      confirm: "simple",
    },
  ),
  // The saved mood of the removed `mood` module (`@miyoria/heart/self` `migrate.ts` reads it).
  category("mood", [settings("mood", "active", ["mood:last"])], {
    modules: ["mood"],
    confirm: "simple",
  }),
  category(
    "messages",
    [
      // The chat lines of the event log, exported in the old `message_log` columns (`v_messages`)
      // with their payload. One database is one character, so every line belongs to this profile.
      table(
        "message_log",
        "events",
        "node",
        "at",
        "seq",
        {
          id: "text",
          type: "text",
          platform: "text",
          scope: "text",
          channel: "text",
          kind: "text",
          author_platform: "text",
          author_id: "text",
          author_name: "text",
          text: "text",
          is_self: "bool",
          ts: "ts",
          turn_id: "text",
          session: "text",
          person_id: "text",
          redacted_at: "ts",
          data: "json",
        },
        { where: CHAT_LINES, exportFrom: "v_messages" },
      ),
      // @miyoria/memory/memory `WATERMARK_PREFIX`: only ever together with the log.
      settings("memory_watermarks", "active", [], ["memory_watermark:"]),
    ],
    // Her conversation notes are made from the log, and the EventLog repeats what people said:
    // they go with it.
    { requires: ["conversation", "event_log"], modules: ["memory", "agent"] },
  ),
  category(
    "decisions",
    [
      // Her decisions and how each turn ended, on the event log, exported in the old tables'
      // columns (`v_decisions`, and `v_turns`: the latest outcome of each turn) with their place.
      // One database is one character, so every row belongs to this profile. Counted and deleted
      // as events: a turn whose outcome was written twice counts twice.
      table(
        "decision_log",
        "events",
        "node",
        "at",
        "ts, id",
        { id: "text", ts: "ts", trace: "json", turn: "text", session: "text" },
        { where: DECISIONS, exportFrom: "v_decisions" },
      ),
      table(
        "turn_outcomes",
        "events",
        "node",
        "at",
        "ts, id",
        { id: "text", ts: "ts", outcome: "text", record: "json", session: "text" },
        { where: OUTCOMES, exportFrom: "v_turns" },
      ),
    ],
    { confirm: "simple" },
  ),
  // The owner's rules. Deleting them lifts every rule at once, so the profile id has to be typed.
  category(
    "directives",
    [
      table("directives", "directives", "profile", "created_at", "created_at, id", {
        id: "text",
        issuer: "json",
        authority: "text",
        scope: "json",
        effect: "text",
        text: "text",
        expires: "ts",
        source_event: "text",
        created_at: "ts",
        revoked_at: "ts",
        revoked_by: "text",
      }),
    ],
    { modules: ["directive"] },
  ),
  // The event log (`events`): what she perceived, decided and said, and the counts of what
  // compaction removed. One database is one character, so every row belongs to this profile. The
  // chat lines are `messages`, her decisions and turn outcomes `decisions`, the audit entries and
  // configuration changes `audit` and the LLM calls `llm_usage`, not here.
  category(
    "event_log",
    [
      table(
        "events",
        "events",
        "node",
        "at",
        "seq",
        {
          seq: "num",
          id: "text",
          at: "ts",
          type: "text",
          v: "num",
          source: "text",
          parent: "text",
          turn: "text",
          session: "text",
          space_id: "text",
          room_id: "text",
          person_id: "text",
          account_id: "text",
          scope: "text",
          tier: "text",
          key: "text",
          data: "json",
          redacted_at: "ts",
        },
        {
          where: `NOT (${CHAT_LINES} OR ${DECISIONS} OR ${OUTCOMES} OR ${AUDIT} OR ${LLM_CALLS} OR ${CONFIG_CHANGES})`,
        },
      ),
      table("event_rollups", "event_rollups", "node", "last_at", "day, type, source", {
        day: "ts",
        type: "text",
        source: "text",
        count: "num",
        first_at: "ts",
        last_at: "ts",
      }),
    ],
    { modules: ["facts"], confirm: "simple" },
  ),
  // @miyoria/brain/arbiter `STATE_KEY` under `STATE_PROFILE` (her ledger: counters, backoff, topics,
  // greetings), and the old @miyoria/initiative state it replaced
  category(
    "initiative",
    [settings("initiative", "global", ["arbiter:state", "initiative:state"])],
    {
      modules: ["arbiter"],
      confirm: "simple",
    },
  ),
  // The files she makes (`artifacts/`): their records, their share tokens (never the token's hash)
  // and their blobs' rows, dependents first. Deleting them leaves the bytes on disk to the sweep,
  // which removes a blob file without a row once it is older than its grace. The inventory's
  // breakdown is the live artifacts by kind, and `bytes`, the size of every stored blob.
  category("artifacts", [
    table("artifact_shares", "artifact_shares", "node", "created_at", "created_at, id", {
      id: "text",
      artifact_id: "text",
      audience: "text",
      person_id: "text",
      space_id: "text",
      mode: "text",
      event_id: "text",
      created_at: "ts",
      expires_at: "ts",
      revoked_at: "ts",
      uses: "num",
      max_uses: "num",
      last_used_at: "ts",
    }),
    table("artifacts", "artifact_items", "node", "created_at", "created_at, id", {
      id: "text",
      sha256: "text",
      size: "num",
      mime: "text",
      kind: "text",
      filename: "text",
      source: "text",
      plugin: "text",
      derived_from: "text",
      turn: "text",
      event_id: "text",
      made_for: "text",
      origin_session: "text",
      space_id: "text",
      room_id: "text",
      scope: "text",
      downloadable: "bool",
      review: "text",
      created_at: "ts",
      expires_at: "ts",
      kept_by: "text",
      deleted_at: "ts",
    }),
    table("artifact_blobs", "artifact_blobs", "node", "stored_at", "stored_at, sha256", {
      sha256: "text",
      size: "num",
      location: "text",
      stored_at: "ts",
    }),
  ]),
  category(
    "people",
    // The `identity` tables (docs/design/v5-data.md §4), dependents first: places name persons
    // and accounts. Handles are `persons.handle`.
    [
      table("link_codes", "link_codes", "node", null, "code_hash", {
        code_hash: "text",
        account_id: "text",
        expires_at: "ts",
      }),
      table("space_members", "space_members", "node", "last_seen", "space_id, account_id", {
        space_id: "text",
        account_id: "text",
        nick: "text",
        roles: "json",
        joined_at: "ts",
        left_at: "ts",
        last_seen: "ts",
      }),
      table("sessions", "sessions", "node", "last_at", "key", {
        key: "text",
        space_id: "text",
        room_id: "text",
        person_id: "text",
        lane: "text",
        created_at: "ts",
        last_at: "ts",
      }),
      table("rooms", "rooms", "node", "created_at", "created_at, id", {
        id: "text",
        platform: "text",
        external_id: "text",
        space_id: "text",
        parent_id: "text",
        kind: "text",
        name: "text",
        caps: "json",
        dm_person: "text",
        created_at: "ts",
        archived_at: "ts",
      }),
      table("spaces", "spaces", "node", "joined_at", "joined_at, id", {
        id: "text",
        platform: "text",
        external_id: "text",
        name: "text",
        joined_at: "ts",
        left_at: "ts",
      }),
      table("accounts", "accounts", "node", "last_seen", "person_id, platform, external_id", {
        id: "text",
        platform: "text",
        external_id: "text",
        person_id: "text",
        display_name: "text",
        is_self: "bool",
        first_seen: "ts",
        last_seen: "ts",
        linked_at: "ts",
        linked_by: "text",
      }),
      table("people", "persons", "node", "created_at", "created_at, id", {
        id: "text",
        name: "text",
        handle: "text",
        prefs: "json",
        created_at: "ts",
        merged_into: "text",
        legacy: "json",
      }),
      // V4 kept handles in settings (`handle:<platform>:<id>` under `_global`); a settings store
      // that is not this database's (tests, fallbacks) still does.
      settings("handles", "global", [], ["handle:"]),
    ],
    {
      // Relationships, feelings, documents, lessons and feedback are keyed by person; artifacts
      // name the person they were made for and the place they were made in.
      requires: ["relationships", "call_names", "inner", "knowledge", "learning", "artifacts"],
      modules: ["social", "agent", "world", "memory"],
      shared: true,
    },
  ),
  category(
    "channels",
    // @miyoria/brain/agent `MODE_PREFIX`, `ACTIVENESS_PREFIX`
    [
      settings("channel_modes", "active", [], ["channel_mode:"]),
      settings("channel_activeness", "active", [], ["activeness:"]),
    ],
    { confirm: "simple" },
  ),
  // @miyoria/voice/voice `consentKey` under `CONSENT_PROFILE`, and @miyoria/types
  // `PRIVACY_PREFIX` under `PRIVACY_PROFILE`: owners still read and write these settings keys,
  // and the store keeps them in `persons.prefs` (`PrefsSettings`). The settings parts claim the
  // keys, so no stray row counts as `other_settings`.
  category(
    "voice_consent",
    [
      prefs("voice_consent", "voice_consent"),
      settings("voice_consent_keys", "global", [], ["voice_consent:"]),
    ],
    { shared: true },
  ),
  category(
    "privacy",
    [prefs("privacy", "privacy"), settings("privacy_keys", "global", [], ["privacy:"])],
    { modules: ["world"], shared: true },
  ),
  // @miyoria/play/queue `STATE_KEY` under `STATE_PROFILE`
  category("queue", [settings("queue", "global", ["queue:state"])], {
    modules: ["queue"],
    shared: true,
    confirm: "simple",
  }),
  category(
    "roles",
    [
      table("roles", "roles", "node", null, "rank DESC, name", {
        name: "text",
        rank: "num",
        grants: "json",
        denies: "json",
        builtin: "bool",
      }),
      table(
        "role_assignments",
        "role_assignments",
        "node",
        "at",
        "at, platform, account_id, role, scope",
        {
          platform: "text",
          account_id: "text",
          role: "text",
          scope: "json",
          granted_by: "text",
          at: "ts",
        },
      ),
      table("role_mappings", "role_mappings", "node", null, "platform, guild, platform_role", {
        platform: "text",
        guild: "text",
        platform_role: "text",
        role: "text",
      }),
      table("node_overrides", "node_overrides", "node", null, "scope, role, node", {
        scope: "json",
        role: "text",
        node: "text",
        allow: "bool",
      }),
    ],
    { shared: true },
  ),
  category("persona", [
    table(
      "persona_overrides",
      "persona_overrides",
      "profile",
      "edited_at",
      "section_key, version",
      {
        section_key: "text",
        version: "num",
        body: "text",
        edited_by: "text",
        edited_at: "ts",
      },
    ),
  ]),
  // @miyoria/workspace/sandbox `TOOL_KEY_PREFIX`
  category("proposed_tools", [settings("proposed_tools", "active", [], ["sandbox:tool:"])], {
    modules: ["sandbox"],
  }),
  // @miyoria/plugin-host/ext-host `storageKey`
  category("extensions", [settings("extension_storage", "active", [], ["ext:"])]),
  // Module on/off, remembered across restarts: the `enabled` flags of the current config revision.
  category("module_state", [{ kind: "module_flags", id: "module_state" }], {
    shared: true,
    confirm: "simple",
  }),
  category("other_settings", [{ kind: "other_settings", id: "other_settings" }]),
  category(
    "audit",
    [
      // The `audit.*` events, exported in the old `audit_log` columns (`v_audit`).
      table(
        "audit_log",
        "events",
        "node",
        "at",
        "at, id",
        {
          id: "text",
          at: "ts",
          actor: "text",
          action: "text",
          target: "text",
          detail: "json",
          ok: "bool",
        },
        { where: AUDIT, exportFrom: "v_audit" },
      ),
      // Who changed the configuration: a new config revision, a per-place setting.
      table(
        "config_changes",
        "events",
        "node",
        "at",
        "seq",
        { id: "text", at: "ts", type: "text", data: "json" },
        { where: CONFIG_CHANGES },
      ),
    ],
    { shared: true, kept: true },
  ),
  // Spending, checked against the budget: the `llm.call` events (metadata and cost of each call,
  // never the prompt or the response), exported in columns (`v_llm_calls`) with their payload.
  category(
    "llm_usage",
    [
      table(
        "llm_calls",
        "events",
        "node",
        "at",
        "seq",
        {
          id: "text",
          at: "ts",
          call_id: "text",
          log_day: "text",
          purpose: "text",
          module: "text",
          model: "text",
          provider: "text",
          status: "text",
          error_kind: "text",
          prompt_tokens: "num",
          completion_tokens: "num",
          cached_prompt_tokens: "num",
          reasoning_tokens: "num",
          cost_usd: "num",
          duration_ms: "num",
          turn: "text",
          data: "json",
        },
        { where: LLM_CALLS, exportFrom: "v_llm_calls" },
      ),
    ],
    { shared: true, kept: true },
  ),
  // @miyoria/api `STORE_PREFIX` under `STORE_PROFILE`: hashes of login tokens.
  category("panel_sessions", [settings("panel_sessions", "global", [], ["panel_session:"])], {
    shared: true,
    kept: true,
    exportable: false,
  }),
];

const BY_ID = new Map(DATA_CATEGORIES.map((c) => [c.id, c]));

export function isDataCategoryId(id: string): id is DataCategoryId {
  return BY_ID.has(id as DataCategoryId);
}

export function dataCategory(id: DataCategoryId): DataCategory {
  const found = BY_ID.get(id);
  if (!found) throw new StoreError(`unknown data category \`${id}\``);
  return found;
}

/** Every category a factory reset deletes (everything but the kept ones). */
export const RESET_CATEGORIES: readonly DataCategoryId[] = DATA_CATEGORIES.filter(
  (c) => !c.kept,
).map((c) => c.id);

/**
 * `ids` plus what they require (transitively), in registry order. Kept categories are refused.
 */
export function resolveCategories(ids: Iterable<DataCategoryId>): DataCategoryId[] {
  const want = new Set<DataCategoryId>();
  const add = (id: DataCategoryId) => {
    if (want.has(id)) return;
    const c = dataCategory(id);
    if (c.kept) throw new StoreError(`data category \`${id}\` is kept and cannot be deleted`);
    want.add(id);
    for (const r of c.requires) add(r);
  };
  for (const id of ids) add(id);
  return DATA_CATEGORIES.filter((c) => want.has(c.id)).map((c) => c.id);
}

/** Modules to stop around deleting `ids`, in registry order, without duplicates. */
export function categoryModules(ids: Iterable<DataCategoryId>): string[] {
  const set = new Set(ids);
  const out: string[] = [];
  for (const c of DATA_CATEGORIES) {
    if (!set.has(c.id)) continue;
    for (const m of c.modules) if (!out.includes(m)) out.push(m);
  }
  return out;
}

// ---- results ------------------------------------------------------------------------------

export interface PartInventory {
  id: string;
  count: number;
  updated_at: Timestamp | null;
}

export interface CategoryInventory {
  id: DataCategoryId;
  count: number;
  updated_at: Timestamp | null;
  parts: PartInventory[];
  /** Counts by a sub-kind (memories by `kind`). */
  breakdown: Record<string, number> | null;
}

export interface DataInventory {
  profile: ProfileId;
  at: Timestamp;
  categories: CategoryInventory[];
}

/**
 * A backup: the rows of each part, as plain JSON. Settings rows are `{profile_id, key, value,
 * updated_at}`, `profile_id` the profile the backup was made for.
 */
export interface DataExport {
  format: typeof DATA_EXPORT_FORMAT;
  version: 1;
  profile: ProfileId;
  exported_at: Timestamp;
  categories: DataCategoryId[];
  /** Rows per part. */
  parts: Record<string, JsonObject[]>;
}

export const DATA_EXPORT_FORMAT = "miyoria.data";

/** Rows removed (or, for `call_names`, cleared) per part. */
export type WipeCounts = Record<string, number>;

export interface WipeOptions {
  /** Written after the `roles` tables are cleared, in the same transaction. */
  seedRoles?: readonly RoleDefinition[];
}

// ---- SQL ----------------------------------------------------------------------------------

/** SQL fragments the statement builders below use. SQL uses `$1`-style placeholders. */
export interface SqlDialect {
  /** `column` starts with the text parameter `param` (case-sensitive, `%` / `_` literal). */
  startsWith(column: string, param: string): string;
  /** A JSON column as JSON text. */
  jsonText(column: string): string;
  /** `ORDER BY` of settings keys (byte order). */
  keyOrder: string;
  /** A `grants` / `denies` value. */
  list(values: readonly string[]): unknown;
  bool(value: boolean): unknown;
}

export interface Stmt {
  sql: string;
  params: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Settings rows matching keys / prefixes. */
function selectorSql(
  d: SqlDialect,
  p: Params,
  keys: readonly string[],
  prefixes: readonly string[],
): string {
  const terms = [
    ...keys.map((k) => `key = ${p.add(k)}`),
    ...prefixes.map((x) => d.startsWith("key", p.add(x))),
  ];
  return terms.length === 0 ? "FALSE" : `(${terms.join(" OR ")})`;
}

/** The settings rows of `plugin_state` (`config/state.ts` `SETTINGS_PLUGIN`). */
const SETTINGS_ROWS = "plugin = 'settings'";

function settingsPartWhere(d: SqlDialect, p: Params, part: SettingsPart) {
  return `${SETTINGS_ROWS} AND ${selectorSql(d, p, part.keys, part.prefixes)}`;
}

/** Settings rows no settings part claims. */
function otherSettingsWhere(d: SqlDialect, p: Params): string {
  const parts = DATA_CATEGORIES.flatMap((c) => c.parts).filter(
    (x): x is SettingsPart => x.kind === "settings",
  );
  const known = selectorSql(
    d,
    p,
    parts.flatMap((x) => x.keys),
    parts.flatMap((x) => x.prefixes),
  );
  return `${SETTINGS_ROWS} AND NOT ${known}`;
}

function tableWhere(p: Params, part: TablePart, profile: ProfileId): string {
  const terms = [
    ...(part.rows === "profile" ? [`profile_id = ${p.add(profile)}`] : []),
    ...(part.where === null ? [] : [`(${part.where})`]),
  ];
  return terms.length === 0 ? "" : `WHERE ${terms.join(" AND ")}`;
}

/**
 * The modules of the current config revision that carry an `enabled` flag: `FROM ... WHERE ...`
 * with `module_id`, `enabled` and the revision's `created_at`.
 */
const MODULE_FLAGS =
  "FROM (SELECT key AS module_id, json_extract(value, '$.enabled') AS enabled, created_at, " +
  "CASE WHEN type = 'object' THEN json_type(value, '$.enabled') END AS flag " +
  "FROM (SELECT doc, created_at FROM config_revisions ORDER BY version DESC LIMIT 1), " +
  "json_each(doc, '$.modules')) WHERE flag IN ('true', 'false')";

/** `persons` rows that hold entry `key` of `prefs` (a code constant, never input). */
function prefsWhere(part: PrefsPart): string {
  return `json_type(prefs, '$.${part.key}') IS NOT NULL`;
}

/** Count and last update of a part: one row `{ n, at }`. */
export function countStmt(d: SqlDialect, part: DataPart, profile: ProfileId): Stmt {
  const p = new Params();
  switch (part.kind) {
    case "table": {
      const at = part.updated === null ? "NULL" : `MAX(${part.updated})`;
      const sql = `SELECT COUNT(*) AS n, ${at} AS at FROM ${part.table} ${tableWhere(p, part, profile)}`;
      return { sql, params: p.values };
    }
    case "settings":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM plugin_state WHERE ${settingsPartWhere(d, p, part)}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM relationships WHERE profile_id = ${p.add(profile)} AND call_name IS NOT NULL`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM plugin_state WHERE ${otherSettingsWhere(d, p)}`,
        params: p.values,
      };
    case "prefs":
      return {
        sql: `SELECT COUNT(*) AS n, NULL AS at FROM persons WHERE ${prefsWhere(part)}`,
        params: [],
      };
    case "module_flags":
      return { sql: `SELECT COUNT(*) AS n, MAX(created_at) AS at ${MODULE_FLAGS}`, params: [] };
  }
}

/** Memories by kind: rows `{ kind, n }`. */
export function memoryKindsStmt(profile: ProfileId): Stmt {
  return {
    sql: "SELECT kind, COUNT(*) AS n FROM memory_records WHERE profile_id = $1 GROUP BY kind",
    params: [profile],
  };
}

/** Live artifacts by kind (rows `{ kind, n }`), and the bytes of every blob (a row of kind `bytes`). */
export function artifactBreakdownStmt(): Stmt {
  return {
    sql:
      "SELECT kind, COUNT(*) AS n FROM artifact_items WHERE deleted_at IS NULL GROUP BY kind " +
      "UNION ALL SELECT 'bytes' AS kind, COALESCE(SUM(size), 0) AS n FROM artifact_blobs",
    params: [],
  };
}

const SETTINGS_COLUMNS: Record<string, ExportColumn> = {
  profile_id: "text",
  key: "text",
  value: "json",
  updated_at: "ts",
};

/** Columns of a part's exported rows. */
export function exportSpec(part: DataPart): Readonly<Record<string, ExportColumn>> {
  switch (part.kind) {
    case "table":
      return part.columns;
    case "call_names":
      return { person_id: "text", call_name: "text" };
    case "prefs":
      return { person_id: "text", value: "json" };
    case "module_flags":
      return { module_id: "text", enabled: "bool", updated_at: "ts" };
    case "settings":
    case "other_settings":
      return SETTINGS_COLUMNS;
  }
}

/** The rows of a part, with `exportSpec(part)` columns. */
export function exportStmt(d: SqlDialect, part: DataPart, profile: ProfileId): Stmt {
  const p = new Params();
  // One database is one character: every settings row is exported as the profile's.
  const settingsSelect = () =>
    `SELECT ${p.add(profile)} AS profile_id, key, ${d.jsonText("value")} AS value, updated_at FROM plugin_state`;
  switch (part.kind) {
    case "table": {
      const cols = Object.keys(part.columns)
        .map((c) => (part.columns[c] === "json" ? `${d.jsonText(c)} AS ${c}` : c))
        .join(", ");
      const from = part.exportFrom ?? part.table;
      const sql = `SELECT ${cols} FROM ${from} ${tableWhere(p, part, profile)} ORDER BY ${part.order}`;
      return { sql, params: p.values };
    }
    case "settings":
      return {
        sql: `${settingsSelect()} WHERE ${settingsPartWhere(d, p, part)} ORDER BY ${d.keyOrder}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `SELECT person_id, call_name FROM relationships WHERE profile_id = ${p.add(profile)} AND call_name IS NOT NULL ORDER BY person_id`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `${settingsSelect()} WHERE ${otherSettingsWhere(d, p)} ORDER BY ${d.keyOrder}`,
        params: p.values,
      };
    case "prefs":
      return {
        sql: `SELECT id AS person_id, prefs -> '$.${part.key}' AS value FROM persons WHERE ${prefsWhere(part)} ORDER BY id`,
        params: [],
      };
    case "module_flags":
      return {
        sql: `SELECT module_id, enabled, created_at AS updated_at ${MODULE_FLAGS} ORDER BY module_id`,
        params: [],
      };
  }
}

/**
 * What deletes (or clears) a part; its row count is the part's count. `null` for the module
 * flags, which the store clears in code (`ModuleFlagsPart`).
 */
export function deleteStmt(d: SqlDialect, part: DataPart, profile: ProfileId): Stmt | null {
  const p = new Params();
  switch (part.kind) {
    case "module_flags":
      return null;
    case "table":
      return { sql: `DELETE FROM ${part.table} ${tableWhere(p, part, profile)}`, params: p.values };
    case "settings":
      return {
        sql: `DELETE FROM plugin_state WHERE ${settingsPartWhere(d, p, part)}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `UPDATE relationships SET call_name = NULL WHERE profile_id = ${p.add(profile)} AND call_name IS NOT NULL`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `DELETE FROM plugin_state WHERE ${otherSettingsWhere(d, p)}`,
        params: p.values,
      };
    case "prefs":
      return {
        sql: `UPDATE persons SET prefs = json_remove(prefs, '$.${part.key}') WHERE ${prefsWhere(part)}`,
        params: [],
      };
  }
}

export function seedRoleStmt(d: SqlDialect, role: RoleDefinition): Stmt {
  return {
    sql: "INSERT INTO roles (name, rank, grants, denies, builtin) VALUES ($1, $2, $3, $4, $5)",
    params: [role.name, role.rank, d.list(role.grants), d.list(role.denies), d.bool(role.builtin)],
  };
}

/**
 * The statements of a wipe, in order, each with the part it counts toward (`null`: not
 * counted). Parts are deleted in reverse registry order, so dependents go first. A `null`
 * statement is the module flags' part, which the store clears in code.
 */
export function wipeStatements(
  d: SqlDialect,
  profile: ProfileId,
  ids: readonly DataCategoryId[],
  options: WipeOptions = {},
  has: PartPresent = everyPart,
): { part: string | null; stmt: Stmt | null }[] {
  const out: { part: string | null; stmt: Stmt | null }[] = [];
  const resolved = resolveCategories(ids);
  const set = new Set(resolved);
  // Clearing categories first (`call_names`, a person's choices): they clear a column of rows
  // another category may delete next (`relationships`, `people`).
  const clearing = (id: DataCategoryId) => dataCategory(id).parts.some(clears);
  const ordered = [...resolved].sort((a, b) => Number(clearing(b)) - Number(clearing(a)));
  for (const id of ordered) {
    for (const part of dataCategory(id).parts) {
      if (has(part)) out.push({ part: part.id, stmt: deleteStmt(d, part, profile) });
    }
  }
  if (set.has("roles") && dataCategory("roles").parts.every(has)) {
    for (const role of options.seedRoles ?? [])
      out.push({ part: null, stmt: seedRoleStmt(d, role) });
  }
  return out;
}

/** One `{ n, at }` row as a part's inventory. */
export function partInventory(id: string, row: Record<string, unknown> | undefined): PartInventory {
  const at = row?.at;
  return {
    id,
    count: Number(row?.n ?? 0),
    updated_at: at === null || at === undefined ? null : (exportValue("ts", at) as Timestamp),
  };
}

/** Sums parts into a category's inventory. */
export function categoryInventory(
  category: DataCategory,
  parts: PartInventory[],
  breakdown: Record<string, number> | null = null,
): CategoryInventory {
  let updated: Timestamp | null = null;
  for (const part of parts) {
    if (part.updated_at !== null && (updated === null || part.updated_at > updated)) {
      updated = part.updated_at;
    }
  }
  return {
    id: category.id,
    count: parts.reduce((n, x) => n + x.count, 0),
    updated_at: updated,
    parts,
    breakdown,
  };
}

/** A row of a part as plain JSON. */
export function exportPartRow(part: DataPart, row: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [column, kind] of Object.entries(exportSpec(part))) {
    out[column] = exportValue(kind, row[column]) as JsonValue;
  }
  return out;
}

/** Exportable categories among `ids` (kept ones included, panel sessions not). */
export function exportCategories(ids: Iterable<DataCategoryId>): DataCategoryId[] {
  const set = new Set(ids);
  return DATA_CATEGORIES.filter((c) => set.has(c.id) && c.exportable).map((c) => c.id);
}

// ---- backend-independent reads --------------------------------------------------------------

export type RunQuery = (stmt: Stmt) => Promise<Record<string, unknown>[]>;

/**
 * Whether a part's tables exist in the database. A plugin that is not installed has no tables:
 * its parts count nothing, export nothing and delete nothing.
 */
export type PartPresent = (part: DataPart) => boolean;

const everyPart: PartPresent = () => true;

/** `PartPresent` over the names of the database's tables and views. */
export function partPresent(names: ReadonlySet<string>): PartPresent {
  return (part) =>
    part.kind !== "table" ||
    (names.has(part.table) && (part.exportFrom === null || names.has(part.exportFrom)));
}

export async function readInventory(
  d: SqlDialect,
  query: RunQuery,
  profile: ProfileId,
  now: Timestamp,
  has: PartPresent = everyPart,
): Promise<DataInventory> {
  const categories: CategoryInventory[] = [];
  for (const c of DATA_CATEGORIES) {
    const parts: PartInventory[] = [];
    for (const part of c.parts) {
      const rows = has(part) ? await query(countStmt(d, part, profile)) : [];
      parts.push(partInventory(part.id, rows[0]));
    }
    let breakdown: Record<string, number> | null = null;
    if (c.id === "memories" || c.id === "artifacts") {
      breakdown = {};
      const stmt = c.id === "memories" ? memoryKindsStmt(profile) : artifactBreakdownStmt();
      for (const row of await query(stmt)) {
        breakdown[String(row.kind)] = Number(row.n);
      }
    }
    categories.push(categoryInventory(c, parts, breakdown));
  }
  return { profile, at: now, categories };
}

export async function readExport(
  d: SqlDialect,
  query: RunQuery,
  profile: ProfileId,
  ids: readonly DataCategoryId[],
  now: Timestamp,
  has: PartPresent = everyPart,
): Promise<DataExport> {
  for (const id of ids) dataCategory(id);
  const categories = exportCategories(ids);
  const parts: Record<string, JsonObject[]> = {};
  for (const id of categories) {
    for (const part of dataCategory(id).parts) {
      const rows = has(part) ? await query(exportStmt(d, part, profile)) : [];
      parts[part.id] = rows.map((row) => exportPartRow(part, row));
    }
  }
  return {
    format: DATA_EXPORT_FORMAT,
    version: 1,
    profile,
    exported_at: now,
    categories,
    parts,
  };
}

/** Adds one statement's row count to its part. */
export function addCount(counts: WipeCounts, part: string | null, n: number): void {
  if (part === null) return;
  counts[part] = (counts[part] ?? 0) + n;
}
