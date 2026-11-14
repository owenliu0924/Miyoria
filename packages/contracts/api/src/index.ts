// @miyoria/contracts/api: the route table: one declaration per route of the admin, member and
// public API, as an oRPC contract (method, path, input and output schemas, and `RouteMeta`: who may
// call it and which permission it needs). The server implements it (`packages/api`), the panel and
// the CLI call it through a typed client.
//
// A route's input has the "detailed" structure: `{ params, query, body }`, each a zod object. Path
// parameters are written `{name}`. The response schemas are what the server validates its
// answers against (strictly in tests and development; see `packages/api/src/rpc.ts` for
// production).
//
// The routes move here group by group; until a group has moved it stays on the old table in
// `packages/api`, and both are served side by side.

import type {
  ContractRouterClient,
  InferContractRouterInputs,
  InferContractRouterOutputs,
} from "@orpc/contract";
import { auth, health } from "./auth.js";
import { facts } from "./facts.js";
import { persona } from "./persona.js";
import { publicView } from "./public.js";

export {
  type AuthMethods,
  AuthMethodsSchema,
  type HealthInfo,
  HealthInfoSchema,
  type SessionInfo,
  SessionInfoSchema,
  type SessionPermissions,
  SessionPermissionsSchema,
  type SessionUser,
  SessionUserSchema,
} from "./auth.js";
export { type LogEvent, type LogEventKind, LogEventKindSchema, LogEventSchema } from "./facts.js";
export {
  type PersonaOverride,
  PersonaOverrideSchema,
  type PersonaSectionInfo,
  PersonaSectionInfoSchema,
  type SetPersonaRequest,
  SetPersonaRequestSchema,
  type SetPersonaResponse,
  SetPersonaResponseSchema,
} from "./persona.js";
export {
  type PublicDay,
  PublicDaySchema,
  type PublicState,
  PublicStateSchema,
  type PublicStatus,
  PublicStatusSchema,
  type PublicToday,
  PublicTodaySchema,
} from "./public.js";
export { type Audience, type RouteMeta, route, routeMeta } from "./route.js";

/** Every route that has moved, by group. A route's path here is its name in the clients. */
export const contract = {
  health,
  auth,
  persona,
  facts,
  public: publicView,
};

export type ApiContract = typeof contract;
/** The typed client of the whole table: `api.persona.set({ params: { key }, body })`. */
export type ApiRpc = ContractRouterClient<ApiContract>;
export type ApiInputs = InferContractRouterInputs<ApiContract>;
export type ApiOutputs = InferContractRouterOutputs<ApiContract>;
