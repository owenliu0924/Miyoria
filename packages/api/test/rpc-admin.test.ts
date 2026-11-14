// The admin groups of the route table (people, modules, decisions, LLM usage, channels, mind,
// roles): each route says what the old route enforced (method, path, audience, permission node),
// the shell treats it as an admin route, and the schemas of the shapes other packages own agree
// with those packages' types.

import {
  type CostReport as ContractCostReport,
  type DecisionRecord as ContractDecisionRecord,
  type ModuleInfo as ContractModuleInfo,
  type Person as ContractPerson,
  type Relationship as ContractRelationship,
  type RelationshipDelta as ContractRelationshipDelta,
  contract,
  routeMeta,
} from "@miyoria/contracts/api";
import type { CostReport } from "@miyoria/llm/llm";
import type { ModuleStatus } from "@miyoria/runtime/kernel";
import type { DecisionRecord, Person, Relationship, RelationshipDelta } from "@miyoria/store";
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
});
