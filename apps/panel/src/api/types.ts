// Wire types of the Admin API, field for field as `packages/api/src/types.ts` and
// `packages/types` serialize them. Timestamps are RFC 3339 strings, ids are ULID strings.
// Keep this file in sync when the API changes.

import type {
  DriveName as ContractDriveName,
  E2eSegmentName,
  LlmCallKind,
  LlmCallStatus,
  LogEventKind,
  LogEvent as ContractLogEvent,
  MemoryKind,
  Thought as ContractThought,
  VoiceE2eLatency as ContractVoiceE2eLatency,
  VoiceLatency as ContractVoiceLatency,
  VoiceSession as ContractVoiceSession,
  ModuleStateKind,
  ThoughtIntent,
} from "@miyoria/contracts/api";

/** A ULID, serialized as a 26-character string. */
export type Ulid = string;
/** RFC 3339 timestamp, e.g. `2026-11-01T08:30:00.123Z`. */
export type Timestamp = string;

/**
 * One line of the EventLog. The route says `body` is JSON (`JsonValue`); the panel reads it by
 * narrowing it itself, so it is `unknown` here.
 */
export type LogEvent = Omit<ContractLogEvent, "body"> & { body: unknown };

/**
 * One thought: the list (`GET /api/mind/thoughts`, newest first, without `input` and `reasoning`,
 * with `has_input` and `has_reasoning`) and `GET /api/mind/thoughts/{id}` (with them, for the
 * newest thoughts), in one type.
 */
export type Thought = ContractThought & { has_input?: boolean; has_reasoning?: boolean };

// ---------------------------------------------------------------------------
// ids and platform

export type ModuleId = string;
export type ProfileId = string;
export type PlatformId = string;
export type TurnId = Ulid;
export type EventId = Ulid;
export type ActionId = Ulid;
export type PersonId = Ulid;

export interface AccountRef {
  platform: PlatformId;
  id: string;
}

export type ContextKind = "channel" | "thread" | "dm" | "voice";

export interface ContextKey {
  platform: PlatformId;
  /** Guild / server id. `null` for DMs. */
  scope: string | null;
  channel: string;
  kind: ContextKind;
}

export interface MessageRef {
  context: ContextKey;
  id: string;
}

export interface Author {
  account: AccountRef;
  display_name: string;
  is_bot: boolean;
}

export interface Attachment {
  url: string;
  filename: string;
  content_type: string | null;
}

export interface IncomingMessage {
  id: MessageRef;
  author: Author;
  text: string;
  mentions_self: boolean;
  reply_to_self: boolean;
  attachments: Attachment[];
  ts: Timestamp;
}

// ---------------------------------------------------------------------------
// voice

export interface VoiceParticipant {
  account: AccountRef;
  display_name: string;
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceUtterance {
  id: string;
  context: ContextKey;
  speaker: Author;
  text: string;
  language: string | null;
  emotion: string | null;
  audio_events: string[];
  started_at: Timestamp;
  ended_at: Timestamp;
  asr_ms: number;
}

export type PlaybackState = "started" | "finished" | "interrupted" | "failed";

// ---------------------------------------------------------------------------
// events

export const MODULE_STATES: readonly ModuleStateKind[] = [
  "running",
  "degraded",
  "starting",
  "stopping",
  "failed",
  "stopped",
  "disabled",
];

// ---------------------------------------------------------------------------
// core routes

// The routes on the route table: their shapes come from the contract, under their old names.
export type {
  AdjustPersonRequest,
  AssignRoleRequest,
  AuthMethods,
  AuthScope,
  BountyView,
  ActivitiesView,
  ActivityFailure,
  ActivityPhase,
  ActivityRequest,
  ActivityResource,
  ActivitySnapshot,
  ActivityTask,
  ActivityType,
  ActivityView,
  ArbiterDecisionsView,
  ArbiterDecisionView,
  ArbiterReason,
  ArbiterVerdict,
  CauseChain,
  CommissionKind,
  CommissionView,
  ContextBucket,
  ContextEntry,
  ConversationNote,
  Delivery,
  EconomyHealth,
  FeedbackTally,
  FieldSource,
  HealthDay,
  HerActivity,
  HerBroadcast,
  HerPresence,
  KnowledgeDoc,
  KnowledgeSubject,
  KnowledgeVersion,
  KnowledgeView,
  LedgerEntry,
  LedgerKind,
  LedgerLimits,
  LedgerOutcome,
  LedgerView,
  Lesson,
  LifeActivityId,
  LifeDayView,
  LifeEntry,
  LlmCallDetail,
  LlmCallKind,
  LlmCallRecord,
  LlmCallStats,
  LlmCallStatus,
  LlmCallsPage,
  LlmGroupStats,
  LlmHourStats,
  LlmPricing,
  LlmThinking,
  LlmThinkingPage,
  LlmToolCall,
  LogEventKind,
  PredictionView,
  QuestsView,
  RaisedTopic,
  ReachedGoal,
  ReflectionRun,
  ReflectionView,
  ReminderView,
  RemindersView,
  RoomItem,
  SceneOverride,
  SkillFile,
  SkillSummary,
  SkillView,
  SourceKind,
  SpokenLine,
  ThoughtDigest,
  WorkspaceFile,
  WorkspaceView,
  ThoughtInput,
  BudgetState,
  ChannelLevelInfo,
  ChannelLevelsView,
  ChannelLevelView,
  CheckinResult,
  CostReport,
  DecisionRecord,
  DecisionTrace,
  EmergencyReport,
  EmergencyStep,
  IntentStatus,
  MindStats,
  MindSuggestion,
  MindView,
  PendingApproval,
  ThoughtDecision,
  ThoughtEffects,
  ThoughtIntent,
  ThoughtTrigger,
  ThoughtTriggerKind,
  DealView,
  EarnLine,
  FeedItem,
  FeedResult,
  FortuneDraw,
  FortuneField,
  FortuneToday,
  FramesResult,
  GiftExpression,
  GoalView,
  HealthInfo,
  Hunger as Hungry,
  IssuedCard,
  IssuedFortune,
  LedgerLine,
  MemberCard,
  MemberCards,
  MemberDay,
  MemberForgetResult,
  MemberSession,
  MemberSong,
  MemberView,
  ModelUsage,
  ModuleInfo,
  ModuleStateKind,
  PeriodReport,
  Person,
  PersonAccount as Account,
  PersonDetail,
  PersonSummary,
  PersonWalletView,
  PersonaOverride,
  PersonaSectionInfo,
  PledgeResult,
  PublicBoard as BoardView,
  PublicDay,
  PublicSong,
  PublicSongs,
  PublicState,
  PublicStatus,
  PublicToday,
  Relationship,
  RelationshipDelta,
  RemoveMappingRequest,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
  SessionInfo,
  SessionUser,
  SetPersonaRequest,
  SetPersonaResponse,
  ShopItem,
  SpendResult,
  TransferResult,
  UpdatePersonRequest,
  UpsertRoleRequest,
  UsageInfo,
  UsageMap,
  WalletAdjustRequest,
  WalletAdjustResult,
  WalletView,
  ControlResult,
  DataCategoryId,
  DataCategoryView,
  DataInventoryView as DataInventory,
  DataNote,
  DataPartView,
  DataWipeResult,
  E2eSegmentName,
  E2eStats,
  ExtensionInfo,
  GameStartRequest,
  LatencyStats,
  McpServerInfo,
  McpState,
  McpToolInfo,
  QueueItemInfo as QueueItem,
  QueueState,
  SayRequest,
  SceneRoleState,
  SceneRolesState,
  SongsState,
  SongView,
  StageLinkState as StageLink,
  StageState,
  StreamAction,
  VoiceE2eLatency,
} from "@miyoria/contracts/api";

// Her inner state, her world, her mood and her goals: shapes of the route table, under their old
// names. The drives are the eight the server sends (the hand copy had five).
// Her memories, notebook, just-now timeline, the owner's rules and a pat: shapes of the route table.
export type {
  AddDirectiveRequest,
  Directive,
  DirectiveAuthority,
  DirectiveChange,
  DirectiveEffect,
  DirectiveRecord,
  DirectiveScope,
  DirectivesView,
  JustNowEntry,
  JustNowKind,
  MemoryItem,
  MemoryKind,
  MemoryPage,
  MemoryRecordView,
  MemoryScope,
  NotebookEntry,
  NotebookIndex,
  NotebookPage,
  PatRequest,
  PatResult,
  RecentView,
  UpdateMemoryRequest,
} from "@miyoria/contracts/api";

export type {
  AffectBiases,
  AffectSnapshot,
  AgendaItem,
  AgendaStatus,
  ChannelActivityView as ChannelActivity,
  DayPlanView,
  EmotionName,
  CompiledBlock,
  EmotionReading,
  FeelingView,
  Goal,
  GoalsView,
  GoalStatus,
  GoalTrigger,
  FollowupStopReasons,
  HerStatus,
  MetricRatio,
  Mood,
  PartyPlayerView,
  PartyResultView,
  PartySessionView,
  PartySnapshot,
  PersonCard,
  PersonPresence,
  PresenceActivity,
  PresenceStatus,
  PromptSummary,
  ReasoningLevel,
  RelationshipLabel,
  SavedPrompt,
  SelfPolicy,
  SelfView,
  ShownEmotion,
  Talkativeness,
  TelemetryLlm,
  TelemetryPoint,
  TelemetryView,
  TimeContext,
  TurnCancelCause,
  TurnMetrics,
  TurnMetricsBucket,
  TurnMetricsDay,
  TurnOutcome,
  TurnOutcomeKind,
  TurnOutcomeRecord,
  TurnReason,
  VoiceChannelState,
  VoiceMember,
  VoiceSpot,
  WorldView,
} from "@miyoria/contracts/api";

/** Every drive the server sends. */
export type AffectDriveName = ContractDriveName;
/** The five the state page and the trends show; the other three are on the affect page. */
export type DriveName = Exclude<ContractDriveName, "esteem" | "hunger" | "longing">;

export type ModuleAction = "enable" | "disable" | "restart";

/** Every error response. */
export interface ErrorBody {
  error: string;
}

// ---------------------------------------------------------------------------
// store records

export interface DecisionsQuery {
  /** Default 50, capped at 1000 by the server. */
  limit?: number;
  context?: ContextKey;
}

// ---------------------------------------------------------------------------
// public side (`/api/public/*`, `/api/member/*`)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the coin economy (`/api/member/wallet` and the spends): their shapes come from the contract

/** What a ledger line says earned coins: the first five are the Core's wallet's, the others economy 2.0 added. */
export type EarnReason = "checkin" | "talked" | "voice" | "song" | "her_gift" | "quest" | "play" | "achievement";

// ---------------------------------------------------------------------------
// panel routes

/** A page of results. `next_cursor` is opaque; `null` on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// LLM cost (`CostReport`)

// ---------------------------------------------------------------------------
// People & relationships (`Person`, `Account`, `Relationship`, `RelationshipDelta`)

export interface PeopleQuery {
  q?: string;
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Memory: the shapes are the route table's (re-exported below); the query is what the panel asks
// with (numbers and flags; the call turns them into the wire's text).

export interface MemoryQuery {
  /** Search text; omit to list newest first. */
  q?: string;
  kind?: MemoryKind;
  subject?: PersonId;
  /** Only records created before this time (pagination when listing). */
  before?: Timestamp;
  include_superseded?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Roles & permissions (`RoleDefinition`, `RoleAssignment`, `AuthScope`)

/**
 * One voice channel she is in. The server always sends `latency.e2e`; the panel still reads a
 * Core older than the six-segment measurement, which leaves it out.
 */
export type VoiceSession = Omit<ContractVoiceSession, "latency"> & {
  latency: Omit<ContractVoiceLatency, "e2e"> & { e2e?: ContractVoiceE2eLatency };
};

/** `GET /api/voice`. */
export interface VoiceState {
  sessions: VoiceSession[];
}

/** The payload of a `voice.latency` bus event with `stage: "e2e"`: one reply, measured. */
export interface E2eRecord {
  context: ContextKey;
  turn: TurnId | null;
  utterance: string;
  complete: boolean;
  reason: string | null;
  total_ms: number | null;
  segments: Record<E2eSegmentName, number | null>;
  unattributed_ms: number | null;
  prefetched: boolean;
  provider: string | null;
}

// ---------------------------------------------------------------------------
// inner life (`GET /api/self`, `GET /api/world`; `packages/types` self.ts / world.ts)

/** `off` | `mention-only` | `quiet` | `normal` | `lively` | `always`. */
export type ChannelMode = string;

// ---------------------------------------------------------------------------
// mind loop and autonomy (`packages/types/src/mind.ts`, `packages/api/src/mind.ts`)

// ---------------------------------------------------------------------------
// LLM call inspector (`packages/llm/llm/src/calls.ts`, `packages/api/src/llmcalls.ts`)

export interface LlmCallsQuery {
  purpose?: string;
  model?: string;
  module?: string;
  status?: LlmCallStatus;
  trouble?: boolean;
  thought?: string;
  turn?: string;
  since?: string;
  q?: string;
}

export interface LlmThinkingQuery {
  kind?: LlmCallKind;
  reasoned?: boolean;
  since?: string;
  q?: string;
}

// ---------------------------------------------------------------------------
// what she organized and learned (phase G)

// ---------------------------------------------------------------------------
// live controls and telemetry (`packages/api/src/control.ts`, `telemetry.ts`)

// ---------------------------------------------------------------------------
// body, arbiter, affect, plan, prompts (`packages/api/src/{body,affect,plan,prompts}.ts`)

export type TaskId = string;
export type Handle = string;

// ---------------------------------------------------------------------------
// The fact layer (`GET /api/facts/*`; `packages/types` log-event.ts)

/** `body` of a `steer` line: the request (`phase: "request"`) or how it went (`"outcome"`). */
export type SteerBody = SteerRequestBody | SteerOutcomeBody;

export interface SteerRequestBody {
  phase: "request";
  /** The executor's topic prefix. */
  owner: string;
  task: Ulid;
  /** The goal arguments to change. */
  patch: Record<string, unknown>;
  /** Why she steers, in her words. */
  why: string;
  /** The kind of principal that asked (`self`: the main line). */
  by: string;
}

export type SteerOutcome = "applied" | "rejected" | "too_late";

export interface SteerOutcomeBody {
  phase: "outcome";
  task: Ulid;
  steer: Ulid;
  outcome: SteerOutcome;
  detail: string;
}

/** `body` of a `thought` line from the mind (source `mind`). */
export interface MindThoughtBody {
  thought: string;
  changes: string[];
  intents: ThoughtIntent[];
  error: string | null;
}

/** `body` of a `thought` line from the game director (source `game.director`). */
export interface DirectorThoughtBody {
  game: string;
  trigger: string[];
  goal: string | null;
  action: string | null;
  verdict: string | null;
  commentary: string | null;
  busy: boolean | null;
  /** What she saw when she decided (an older Core does not write it). */
  observation?: string;
  /** The goal's success condition: she holds at least `count` of `item`. */
  want?: { item: string; count: number } | null;
  /** Methods and goals on hold at the time, one line each: the ones that failed the same way twice. */
  held?: string[];
}

export type ThoughtBody = MindThoughtBody | DirectorThoughtBody;

/** `GET /api/facts/events` query. */
export interface FactEventsQuery {
  kind?: LogEventKind[];
  /** Comma list on the wire. */
  source?: string[];
  /** One turn's lines and what they caused (a Core before this ignores it). */
  turn?: string;
  since?: Timestamp;
  until?: Timestamp;
  /** Events older than this id (paging newest first). */
  before?: Ulid;
  order?: "asc" | "desc";
  limit?: number;
}

// --- the admin routes V4 added: her life, economy, workspace, party games, notebook ---
// (Timestamps are ISO strings.)
// --- her life ---------------------------------------------------------------------

// --- economy 2.0 ----------------------------------------------------------------------

// --- her workspace and skills ----------------------------------------------------------

// --- memory -----------------------------------------------------------------------------


