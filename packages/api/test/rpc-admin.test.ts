// The admin groups of the route table (people, modules, decisions, LLM usage, channels, mind,
// roles): each route says what the old route enforced (method, path, audience, permission node),
// the shell treats it as an admin route, and the schemas of the shapes other packages own agree
// with those packages' types.

import {
  type AuthScope as ContractAuthScope,
  type CostReport as ContractCostReport,
  type DecisionRecord as ContractDecisionRecord,
  type EmergencyReport as ContractEmergencyReport,
  type MindStats as ContractMindStats,
  type ModuleInfo as ContractModuleInfo,
  type PendingApproval as ContractPendingApproval,
  type Person as ContractPerson,
  type Relationship as ContractRelationship,
  type RelationshipDelta as ContractRelationshipDelta,
  type RoleAssignment as ContractRoleAssignment,
  type RoleDefinition as ContractRoleDefinition,
  type RoleMapping as ContractRoleMapping,
  type ThoughtSummary as ContractThoughtSummary,
  contract,
  routeMeta,
} from "@miyoria/contracts/api";
import { NODE_APPROVE, type PendingApproval } from "@miyoria/gate/actions";
import type { CostReport } from "@miyoria/llm/llm";
import type { ModuleStatus } from "@miyoria/runtime/kernel";
import type {
  AuthScope,
  DecisionRecord,
  Person,
  Relationship,
  RelationshipDelta,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "@miyoria/store";
import type { EmergencyReport, MindStats, Thought } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { rpcRoutes } from "../src/rpc.js";

interface Case {
  /** The route's name in the table: `people.list`. */
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The path as the old Hono table spelled it. */
  path: string;
  /** The node the old route's handler checked (`null`: none). */
  permission?: string;
}

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
];

describe("the admin routes of the table", () => {
  it.each(CASES)("$name is an admin route: $method $path", (c) => {
    expect(routeMeta(contract, c.name.split("."))).toEqual({
      audience: "admin",
      permission: c.permission ?? null,
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

  it("the owner node is the one the gate's commands use", () => {
    expect(routeMeta(contract, ["mind", "approve"])?.permission).toBe(NODE_APPROVE);
  });
});
