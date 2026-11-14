// The admin routes that moved to the route table, called the way the CLI's client calls them: the
// bearer token, JSON in and out, a `ClientError` when a call fails. Each function keeps the name
// and the arguments of the `ApiClient` method it replaced, so a test reads as it did.

import type { PendingApproval } from "@miyoria/gate/actions";
import type { DecisionRecord, RoleAssignment, RoleDefinition, RoleMapping } from "@miyoria/store";
import type { ContextKey, PlatformId } from "@miyoria/types";
import type {
  AssignRoleRequest,
  CostInfo,
  MindView,
  ModuleInfo,
  Page,
  PersonDetail,
  PersonSummary,
  RemoveMappingRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  UsageInfo,
} from "../../src/index.js";
import { call } from "./http.js";

type Query = Record<string, string | number | undefined>;

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? path : `${path}?${text}`;
}

const seg = encodeURIComponent;

export function adminCalls(base: string, token: string) {
  const get = <T>(path: string, query?: Query) =>
    call<T>(base, token, "GET", withQuery(path, query));
  const send = <T>(method: string, path: string, json?: unknown) =>
    call<T>(base, token, method, path, json);
  return {
    // ---- people
    people: (query: { q?: string; limit?: number; cursor?: string } = {}) =>
      get<Page<PersonSummary>>("/api/people", query),
    person: (id: string) => get<PersonDetail>(`/api/people/${seg(id)}`),
    updatePerson: (id: string, request: UpdatePersonRequest) =>
      send<PersonSummary>("PATCH", `/api/people/${seg(id)}`, request),
    adjustPerson: (id: string, affinity: number) =>
      send<PersonSummary>("POST", `/api/people/${seg(id)}/adjust`, { affinity }),

    // ---- modules, decisions, LLM usage
    modules: () => get<ModuleInfo[]>("/api/modules"),
    moduleAction: (id: string, action: string) =>
      send<ModuleInfo>("POST", `/api/modules/${seg(id)}/${seg(action)}`),
    decisions: (limit: number) => get<DecisionRecord[]>("/api/decisions", { limit }),
    decisionsIn: (context: ContextKey | null, limit: number) =>
      get<DecisionRecord[]>("/api/decisions", {
        limit,
        context: context ? JSON.stringify(context) : undefined,
      }),
    usage: async () => {
      const raw = await get<Record<string, UsageInfo>>("/api/llm/usage");
      return new Map(
        Object.keys(raw)
          .sort()
          .map((k) => [k, raw[k] as UsageInfo]),
      );
    },

    cost: () => get<CostInfo>("/api/llm/cost"),

    // ---- roles
    roles: () => get<RoleDefinition[]>("/api/auth/roles"),
    role: (name: string) => get<RoleDefinition>(`/api/auth/roles/${seg(name)}`),
    upsertRole: (name: string, request: UpsertRoleRequest) =>
      send<RoleDefinition>("PUT", `/api/auth/roles/${seg(name)}`, request),
    deleteRole: (name: string) => send<void>("DELETE", `/api/auth/roles/${seg(name)}`),
    assignments: () => get<RoleAssignment[]>("/api/auth/assignments"),
    assignRole: (request: AssignRoleRequest) =>
      send<RoleAssignment>("POST", "/api/auth/assignments", request),
    revokeRole: (request: AssignRoleRequest) =>
      send<void>("DELETE", "/api/auth/assignments", request),
    mappings: (platform: PlatformId, guild: string) =>
      get<RoleMapping[]>("/api/auth/mappings", { platform, guild }),
    setMapping: (mapping: RoleMapping) => send<RoleMapping>("PUT", "/api/auth/mappings", mapping),
    removeMapping: (request: RemoveMappingRequest) =>
      send<void>("DELETE", "/api/auth/mappings", request),

    // ---- mind
    mind: () => get<MindView>("/api/mind"),
    thoughts: (limit = 50) => get<unknown[]>("/api/mind/thoughts", { limit }),
    approvals: () => get<PendingApproval[]>("/api/mind/approvals"),
    answerApproval: (id: string, approved: boolean) =>
      send<PendingApproval[]>(
        "POST",
        `/api/mind/approvals/${seg(id)}/${approved ? "approve" : "deny"}`,
      ),
    autonomyPause: (paused: boolean) =>
      send<MindView>("POST", `/api/mind/${paused ? "pause" : "resume"}`),
  };
}
