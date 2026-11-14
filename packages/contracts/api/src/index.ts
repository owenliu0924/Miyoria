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
import { agency } from "./agency.js";
import { auth, health } from "./auth.js";
import { channels } from "./channels.js";
import { decisions, llm, modules } from "./core.js";
import { facts } from "./facts.js";
import { fortune } from "./fortune.js";
import { member } from "./member.js";
import { mind } from "./mind.js";
import { people } from "./people.js";
import { persona } from "./persona.js";
import { publicView } from "./public.js";
import { roles } from "./roles.js";
import { wallet } from "./wallet.js";

export {
  type BountyList,
  BountyListSchema,
  type BountyView,
  BountyViewSchema,
  type GoalList,
  GoalListSchema,
  type GoalView,
  GoalViewSchema,
  type PledgeRequest,
  PledgeRequestSchema,
  type PledgeResult,
  PledgeResultSchema,
} from "./agency.js";
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
export {
  type ChannelLevelInfo,
  ChannelLevelInfoSchema,
  type ChannelLevelsView,
  ChannelLevelsViewSchema,
  type ChannelLevelView,
  ChannelLevelViewSchema,
  type SetChannelLevelRequest,
  SetChannelLevelRequestSchema,
} from "./channels.js";
export {
  type BudgetState,
  BudgetStateSchema,
  type CostReport,
  CostReportSchema,
  type DecisionRecord,
  DecisionRecordSchema,
  type DecisionTrace,
  DecisionTraceSchema,
  type ModelUsage,
  ModelUsageSchema,
  type ModuleInfo,
  ModuleInfoSchema,
  type ModuleStateKind,
  ModuleStateKindSchema,
  type PeriodReport,
  PeriodReportSchema,
  type UsageInfo,
  UsageInfoSchema,
  type UsageMap,
  UsageMapSchema,
} from "./core.js";
export { type LogEvent, type LogEventKind, LogEventKindSchema, LogEventSchema } from "./facts.js";
export {
  type FortuneDraw,
  FortuneDrawSchema,
  type FortuneField,
  FortuneFieldSchema,
  type FortuneToday,
  FortuneTodaySchema,
  type IssuedFortune,
  IssuedFortuneSchema,
} from "./fortune.js";
export {
  type CardField,
  CardFieldSchema,
  type CardPoseChoice,
  CardPoseChoiceSchema,
  type CardPrices,
  CardPricesSchema,
  EmptyRequestSchema,
  type ForgetRequest,
  ForgetRequestSchema,
  type IssueCardRequest,
  IssueCardRequestSchema,
  type IssuedCard,
  IssuedCardSchema,
  type MemberCard,
  MemberCardSchema,
  type MemberCards,
  MemberCardsSchema,
  type MemberDay,
  MemberDaySchema,
  type MemberForgetResult,
  MemberForgetResultSchema,
  type MemberMemory,
  MemberMemorySchema,
  type MemberSession,
  MemberSessionSchema,
  type MemberSong,
  MemberSongSchema,
  type MemberView,
  MemberViewSchema,
  type SongAccepted,
  SongAcceptedSchema,
  type SongRequest,
  SongRequestSchema,
} from "./member.js";
export {
  type EmergencyReport,
  EmergencyReportSchema,
  type EmergencyStep,
  EmergencyStepSchema,
  type IntentStatus,
  IntentStatusSchema,
  type MindStats,
  MindStatsSchema,
  type MindSuggestion,
  MindSuggestionSchema,
  type MindView,
  MindViewSchema,
  type PendingApproval,
  PendingApprovalSchema,
  type ThoughtDecision,
  ThoughtDecisionSchema,
  type ThoughtEffects,
  ThoughtEffectsSchema,
  type ThoughtIntent,
  ThoughtIntentSchema,
  type ThoughtSummary,
  ThoughtSummarySchema,
  type ThoughtTrigger,
  type ThoughtTriggerKind,
  ThoughtTriggerKindSchema,
  ThoughtTriggerSchema,
} from "./mind.js";
export {
  type AdjustPersonRequest,
  AdjustPersonRequestSchema,
  type Person,
  type PersonAccount,
  PersonAccountSchema,
  type PersonDetail,
  PersonDetailSchema,
  type PersonPage,
  PersonPageSchema,
  PersonSchema,
  type PersonSummary,
  PersonSummarySchema,
  type PersonWalletView,
  PersonWalletViewSchema,
  type Relationship,
  type RelationshipDelta,
  RelationshipDeltaSchema,
  RelationshipSchema,
  type UpdatePersonRequest,
  UpdatePersonRequestSchema,
  type WalletAdjustRequest,
  WalletAdjustRequestSchema,
  type WalletAdjustResult,
  WalletAdjustResultSchema,
} from "./people.js";
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
  type PublicBoard,
  PublicBoardSchema,
  type PublicDay,
  PublicDaySchema,
  type PublicSong,
  PublicSongSchema,
  type PublicSongs,
  PublicSongsSchema,
  type PublicState,
  PublicStateSchema,
  type PublicStatus,
  PublicStatusSchema,
  type PublicToday,
  PublicTodaySchema,
} from "./public.js";
export {
  type AssignRoleRequest,
  AssignRoleRequestSchema,
  type AuthScope,
  AuthScopeSchema,
  type RemoveMappingRequest,
  RemoveMappingRequestSchema,
  type RoleAssignment,
  RoleAssignmentSchema,
  type RoleDefinition,
  RoleDefinitionSchema,
  type RoleMapping,
  RoleMappingSchema,
  type UpsertRoleRequest,
  UpsertRoleRequestSchema,
} from "./roles.js";
export { type Audience, type RouteMeta, route, routeMeta } from "./route.js";
export { type ContextKeyIn, ContextKeyInSchema } from "./shared.js";
export {
  type BoardChoice,
  BoardChoiceSchema,
  type BoardRequest,
  BoardRequestSchema,
  type CheckinResult,
  CheckinResultSchema,
  type DealView,
  DealViewSchema,
  type EarnLine,
  EarnLineSchema,
  type ExpressionRequest,
  ExpressionRequestSchema,
  type FeedItem,
  FeedItemSchema,
  type FeedRequest,
  FeedRequestSchema,
  type FeedResult,
  FeedResultSchema,
  type FrameRequest,
  FrameRequestSchema,
  type FramesResult,
  FramesResultSchema,
  type GiftExpression,
  GiftExpressionSchema,
  type Hunger,
  HungerSchema,
  type LedgerLine,
  LedgerLineSchema,
  type LetterRequest,
  LetterRequestSchema,
  type ScreenRequest,
  ScreenRequestSchema,
  type ShopItem,
  ShopItemSchema,
  type SpendResult,
  SpendResultSchema,
  type TransferRequest,
  TransferRequestSchema,
  type TransferResult,
  TransferResultSchema,
  type WalletView,
  WalletViewSchema,
} from "./wallet.js";

/** Every route that has moved, by group. A route's path here is its name in the clients. */
export const contract = {
  health,
  auth,
  persona,
  people,
  modules,
  decisions,
  llm,
  channels,
  mind,
  roles,
  facts,
  public: publicView,
  member,
  wallet,
  agency,
  fortune,
};

export type ApiContract = typeof contract;
/** The typed client of the whole table: `api.persona.set({ params: { key }, body })`. */
export type ApiRpc = ContractRouterClient<ApiContract>;
export type ApiInputs = InferContractRouterInputs<ApiContract>;
export type ApiOutputs = InferContractRouterOutputs<ApiContract>;
