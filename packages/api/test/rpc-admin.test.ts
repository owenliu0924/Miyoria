// The admin groups of the route table (people, modules, decisions, LLM usage, channels, mind,
// roles, extensions, MCP, the queue, the stage, voice, songs, game, data): each route says what the old route enforced (method, path, audience, permission node),
// the shell treats it as an admin route, and the schemas of the shapes other packages own agree
// with those packages' types.

import {
  type AuthScope as ContractAuthScope,
  type CostReport as ContractCostReport,
  type DataCategoryId as ContractDataCategoryId,
  type DataCategoryView as ContractDataCategoryView,
  type DataNote as ContractDataNote,
  type DataWipeResult as ContractDataWipeResult,
  type DecisionRecord as ContractDecisionRecord,
  type EmergencyReport as ContractEmergencyReport,
  type ExtensionInfo as ContractExtensionInfo,
  type McpServerInfo as ContractMcpServerInfo,
  type MindStats as ContractMindStats,
  type ModuleInfo as ContractModuleInfo,
  type PendingApproval as ContractPendingApproval,
  type Person as ContractPerson,
  type QueueItemInfo as ContractQueueItemInfo,
  type Relationship as ContractRelationship,
  type RelationshipDelta as ContractRelationshipDelta,
  type RoleAssignment as ContractRoleAssignment,
  type RoleDefinition as ContractRoleDefinition,
  type RoleMapping as ContractRoleMapping,
  type SceneRolesState as ContractSceneRolesState,
  type SongView as ContractSongView,
  type StageState as ContractStageState,
  type ThoughtSummary as ContractThoughtSummary,
  type VoiceSession as ContractVoiceSession,
  contract,
  routeMeta,
} from "@miyoria/contracts/api";
import { NODE_APPROVE, type PendingApproval } from "@miyoria/gate/actions";
import type { CostReport } from "@miyoria/llm/llm";
import type { ItemState } from "@miyoria/play/queue";
import type { ServerStatus } from "@miyoria/plugin-host/mcp";
import type { ModuleStatus } from "@miyoria/runtime/kernel";
import type { SongEntry } from "@miyoria/sing";
import type { SceneRolesView, StageStatus } from "@miyoria/stage";
import type {
  AuthScope,
  CategoryInventory,
  DataCategoryId,
  DecisionRecord,
  Person,
  Relationship,
  RelationshipDelta,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "@miyoria/store";
import type {
  ContextKey,
  EmergencyReport,
  MindStats,
  ModuleStateKind,
  Thought,
  VoiceParticipant,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { NODE_DATA_MANAGE, type TOOLS_WORKSPACE } from "../src/data.js";
import { rpcRoutes } from "../src/rpc.js";

interface Case {
  /** The route's name in the table: `people.list`. */
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The path as the old Hono table spelled it. */
  path: string;
  /** The node the old route's handler checked (`null`: none). */
  permission?: string;
  /** What the old route said to a session without the node, when not the usual. */
  refusal?: string;
}

const MANAGE = "owner.data.manage";
const MANAGE_REFUSAL = "managing her data needs `owner.data.manage`";

const CASES: Case[] = [
  { name: "people.list", method: "GET", path: "/api/people" },
  { name: "people.get", method: "GET", path: "/api/people/:id" },
  { name: "people.update", method: "PATCH", path: "/api/people/:id" },
  { name: "people.adjust", method: "POST", path: "/api/people/:id/adjust" },
  { name: "people.wallet", method: "GET", path: "/api/people/:id/wallet" },
  {
    name: "people.adjustWallet",
    method: "POST",
    path: "/api/people/:id/wallet/adjust",
    permission: "admin.economy.adjust",
  },
  { name: "modules.list", method: "GET", path: "/api/modules" },
  { name: "modules.action", method: "POST", path: "/api/modules/:id/:action" },
  { name: "decisions", method: "GET", path: "/api/decisions" },
  { name: "llm.usage", method: "GET", path: "/api/llm/usage" },
  { name: "llm.cost", method: "GET", path: "/api/llm/cost" },
  { name: "channels.levels", method: "GET", path: "/api/channels/levels" },
  {
    name: "channels.setLevel",
    method: "PUT",
    path: "/api/channels/level",
    permission: "admin.channel.mode",
  },
  { name: "mind.status", method: "GET", path: "/api/mind" },
  { name: "mind.thoughts", method: "GET", path: "/api/mind/thoughts" },
  { name: "mind.approvals", method: "GET", path: "/api/mind/approvals" },
  {
    name: "mind.approve",
    method: "POST",
    path: "/api/mind/approvals/:id/approve",
    permission: "owner.autonomy.approve",
  },
  {
    name: "mind.deny",
    method: "POST",
    path: "/api/mind/approvals/:id/deny",
    permission: "owner.autonomy.approve",
  },
  {
    name: "mind.pause",
    method: "POST",
    path: "/api/mind/pause",
    permission: "owner.autonomy.approve",
  },
  {
    name: "mind.resume",
    method: "POST",
    path: "/api/mind/resume",
    permission: "owner.autonomy.approve",
  },
  { name: "roles.list", method: "GET", path: "/api/auth/roles" },
  { name: "roles.get", method: "GET", path: "/api/auth/roles/:name" },
  { name: "roles.upsert", method: "PUT", path: "/api/auth/roles/:name" },
  { name: "roles.remove", method: "DELETE", path: "/api/auth/roles/:name" },
  { name: "roles.assignments", method: "GET", path: "/api/auth/assignments" },
  { name: "roles.assign", method: "POST", path: "/api/auth/assignments" },
  { name: "roles.revoke", method: "DELETE", path: "/api/auth/assignments" },
  { name: "roles.mappings", method: "GET", path: "/api/auth/mappings" },
  { name: "roles.setMapping", method: "PUT", path: "/api/auth/mappings" },
  { name: "roles.removeMapping", method: "DELETE", path: "/api/auth/mappings" },
  { name: "extensions.list", method: "GET", path: "/api/extensions" },
  { name: "extensions.action", method: "POST", path: "/api/extensions/:id/:action" },
  { name: "mcp.list", method: "GET", path: "/api/mcp" },
  { name: "mcp.action", method: "POST", path: "/api/mcp/:name/:action" },
  { name: "queue.list", method: "GET", path: "/api/queue" },
  { name: "queue.pause", method: "POST", path: "/api/queue/pause" },
  { name: "queue.resume", method: "POST", path: "/api/queue/resume" },
  // The old table had one `/api/queue/:id/:action` for both; each action is a route of its own now.
  { name: "queue.skip", method: "POST", path: "/api/queue/:id/skip" },
  { name: "queue.move", method: "POST", path: "/api/queue/:id/move" },
  { name: "stage.status", method: "GET", path: "/api/stage" },
  { name: "stage.scene", method: "POST", path: "/api/stage/scene" },
  { name: "stage.scenes", method: "GET", path: "/api/stage/scenes" },
  { name: "stage.setSceneRole", method: "PUT", path: "/api/stage/scenes" },
  { name: "stage.classify", method: "POST", path: "/api/stage/scenes/classify" },
  { name: "stage.expression", method: "POST", path: "/api/stage/expression" },
  { name: "stage.stream", method: "POST", path: "/api/stage/stream" },
  { name: "stage.say", method: "POST", path: "/api/stage/say" },
  { name: "voice.state", method: "GET", path: "/api/voice" },
  { name: "voice.join", method: "POST", path: "/api/voice/join" },
  { name: "voice.leave", method: "POST", path: "/api/voice/leave" },
  { name: "voice.goLive", method: "POST", path: "/api/voice/golive" },
  { name: "songs.list", method: "GET", path: "/api/songs" },
  { name: "songs.request", method: "POST", path: "/api/songs" },
  { name: "songs.play", method: "POST", path: "/api/songs/play" },
  { name: "songs.stop", method: "POST", path: "/api/songs/stop" },
  { name: "game.start", method: "POST", path: "/api/game/start" },
  { name: "game.stop", method: "POST", path: "/api/game/stop" },
  { name: "game.goal", method: "POST", path: "/api/game/goal" },
  { name: "data.inventory", method: "GET", path: "/api/data" },
  {
    name: "data.wipe",
    method: "POST",
    path: "/api/data/wipe",
    permission: MANAGE,
    refusal: MANAGE_REFUSAL,
  },
  {
    name: "data.reset",
    method: "POST",
    path: "/api/data/reset",
    permission: MANAGE,
    refusal: MANAGE_REFUSAL,
  },
];

describe("the admin routes of the table", () => {
  it.each(CASES)("$name is an admin route: $method $path", (c) => {
    expect(routeMeta(contract, c.name.split("."))).toEqual({
      audience: "admin",
      permission: c.permission ?? null,
      ...(c.refusal === undefined ? {} : { refusal: c.refusal }),
    });
  });

  it("holds the shell's flags the old routes had: neither public nor member", () => {
    const state = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const routes = rpcRoutes(state as never);
    for (const c of CASES) {
      const found = routes.filter((r) => r.method === c.method && r.path === c.path);
      expect(found, c.name).toHaveLength(1);
      expect(Boolean(found[0]?.public), `${c.name} public`).toBe(false);
      expect(Boolean(found[0]?.member), `${c.name} member`).toBe(false);
    }
  });
});

/** Both ways assignable: the schema's type and the owning package's type are one shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the schemas agree with the types of the packages that own the shapes", () => {
  it("people", () => {
    const person: Same<ContractPerson, Person> = true;
    const relationship: Same<ContractRelationship, Relationship> = true;
    const delta: Same<ContractRelationshipDelta, RelationshipDelta> = true;
    expect([person, relationship, delta]).toEqual([true, true, true]);
  });

  it("modules, decisions and the cost report", () => {
    const module: Same<ContractModuleInfo, ModuleStatus> = true;
    const decision: Same<ContractDecisionRecord, DecisionRecord> = true;
    const cost: Same<ContractCostReport, CostReport> = true;
    expect([module, decision, cost]).toEqual([true, true, true]);
  });

  it("the mind view, a thought in the journal and an approval", () => {
    // The list leaves out what each thought saw and its reasoning, and says whether it has them.
    type Listed = Omit<Thought, "input" | "reasoning"> & {
      has_input: boolean;
      has_reasoning: boolean;
    };
    const thought: Same<ContractThoughtSummary, Listed> = true;
    const stats: Same<ContractMindStats, MindStats> = true;
    const emergency: Same<ContractEmergencyReport, EmergencyReport> = true;
    const approval: Same<ContractPendingApproval, PendingApproval> = true;
    expect([thought, stats, emergency, approval]).toEqual([true, true, true, true]);
  });

  it("roles, assignments and mappings", () => {
    const role: Same<ContractRoleDefinition, RoleDefinition> = true;
    const assignment: Same<ContractRoleAssignment, RoleAssignment> = true;
    const mapping: Same<ContractRoleMapping, RoleMapping> = true;
    const scope: Same<ContractAuthScope, AuthScope> = true;
    expect([role, assignment, mapping, scope]).toEqual([true, true, true, true]);
  });

  it("extensions, MCP servers, the queue, the stage and the voice monitor", () => {
    const extension: Same<ContractExtensionInfo["state"], ModuleStateKind> = true;
    // The server reports the transport as a string (`stdio` or `http`).
    const transport: Same<ContractMcpServerInfo["transport"], ServerStatus["transport"]> = true;
    const item: Same<ContractQueueItemInfo["state"], ItemState> = true;
    const scenes: Same<ContractSceneRolesState, SceneRolesView> = true;
    const stage: Same<ContractStageState["overlay_url"], StageStatus["overlay_url"]> = true;
    const participant: Same<ContractVoiceSession["participants"][number], VoiceParticipant> = true;
    const context: Same<ContractVoiceSession["context"], ContextKey> = true;
    expect([extension, transport, item, scenes, stage, participant, context]).toEqual(
      Array(7).fill(true),
    );
  });

  it("songs and data", () => {
    const song: Same<ContractSongView["state"], SongEntry["state"]> = true;
    const category: Same<ContractDataCategoryId, DataCategoryId | typeof TOOLS_WORKSPACE> = true;
    // The inventory is the store's category with what the category table says of it.
    type Category = Omit<CategoryInventory, "id"> & {
      id: DataCategoryId | typeof TOOLS_WORKSPACE;
      shared: boolean;
      kept: boolean;
      exportable: boolean;
      confirm: "typed" | "simple";
      requires: (DataCategoryId | typeof TOOLS_WORKSPACE)[];
    };
    const view: Same<ContractDataCategoryView, Category> = true;
    const note: Same<ContractDataNote, "restart_core" | "consent_cache"> = true;
    const wiped: Same<
      ContractDataWipeResult,
      {
        deleted: (DataCategoryId | typeof TOOLS_WORKSPACE)[];
        counts: Record<string, number>;
        failed_modules: string[];
        notes: ("restart_core" | "consent_cache")[];
      }
    > = true;
    expect([song, category, view, note, wiped]).toEqual(Array(5).fill(true));
  });

  it("the data node and its refusal are the ones the data routes had", () => {
    for (const name of ["wipe", "reset"]) {
      expect(routeMeta(contract, ["data", name])).toMatchObject({
        permission: NODE_DATA_MANAGE,
        refusal: `managing her data needs \`${NODE_DATA_MANAGE}\``,
      });
    }
  });

  it("the owner node is the one the gate's commands use", () => {
    expect(routeMeta(contract, ["mind", "approve"])?.permission).toBe(NODE_APPROVE);
  });
});
