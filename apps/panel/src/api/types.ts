// Wire types of the Admin API, field for field as `packages/api/src/types.ts` and
// `packages/types` serialize them. Timestamps are RFC 3339 strings, ids are ULID strings.
// Keep this file in sync when the API changes.

import type {
  DecisionTrace,
  E2eSegmentName,
  LlmCallKind,
  LlmCallStatus,
  LogEventKind,
  LogEvent as ContractLogEvent,
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

/** A bus event: `{ type, data }`, adjacently tagged. */
export type BusEvent =
  | { type: "platform_ready"; data: { platform: PlatformId; self_account: AccountRef } }
  | { type: "platform_message_created"; data: IncomingMessage }
  | { type: "platform_typing"; data: { context: ContextKey; account: AccountRef } }
  | { type: "agent_turn_started"; data: { turn: TurnId; context: ContextKey } }
  | { type: "agent_decision"; data: DecisionTrace }
  | { type: "agent_turn_completed"; data: { turn: TurnId; context: ContextKey; text: string } }
  | {
      type: "action_completed";
      data: {
        action: ActionId;
        turn: TurnId | null;
        ok: boolean;
        error: string | null;
        message?: MessageRef | null;
      };
    }
  | { type: "voice_joined"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_left"; data: { context: ContextKey; reason: string | null } }
  | { type: "voice_participants"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_speaking"; data: { context: ContextKey; account: AccountRef; speaking: boolean } }
  | { type: "voice_utterance"; data: VoiceUtterance }
  | {
      type: "voice_playback";
      data: { context: ContextKey; turn: TurnId | null; state: PlaybackState; text: string };
    }
  | {
      type: "agent_initiative";
      data: { context: ContextKey; reason: string; hint: string; about: AccountRef[] };
    }
  | {
      type: "module_state_changed";
      data: { module: ModuleId; state: ModuleStateKind; reason: string | null };
    }
  | { type: "custom"; data: { topic: string; payload: unknown } };

export type BusEventType = BusEvent["type"];

/** Every event on the bus, as streamed by `GET /api/events`. */
export interface Envelope {
  id: EventId;
  ts: Timestamp;
  source: ModuleId;
  causation: EventId | null;
  correlation: TurnId | null;
  event: BusEvent;
}

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
// Memory (`MemoryRecord`, `MemoryHit`, `MemoryScope`)

export type MemoryKind = "episode" | "fact" | "self_note" | "followup";

export type MemoryScope =
  | { type: "global" }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "channel"; context: ContextKey }
  | { type: "dm"; account: AccountRef }
  | { type: "person"; person: PersonId };

/** A memory record without its embedding vector. */
export interface MemoryRecordView {
  id: Ulid;
  profile: ProfileId;
  kind: MemoryKind;
  scope: MemoryScope;
  subjects: PersonId[];
  content: string;
  importance: number;
  confidence: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_accessed: Timestamp | null;
  access_count: number;
  source_context: ContextKey | null;
  due: Timestamp | null;
  done: boolean;
  superseded_by: Ulid | null;
  has_embedding: boolean;
}

export interface MemoryItem {
  record: MemoryRecordView;
  /** Present when `q` was given: full-text relevance. */
  text_score?: number;
  /** Present when `q` was given and vectors were compared. */
  vector_score?: number | null;
}

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

/** `PATCH /api/memory/{id}`. */
export interface UpdateMemoryRequest {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  done?: boolean;
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

export type DriveName = "social" | "play" | "attention" | "rest" | "curiosity";

export interface Mood {
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  /** 0..1 */
  energy: number;
}

export interface Talkativeness {
  level: number;
  until: Timestamp | null;
  why: string;
  set_at: Timestamp;
}

export interface SelfPolicy {
  /** By scope: `*`, `voice`, `text`, `discord:<guild>`, or a context string. */
  talkativeness: Record<string, Talkativeness>;
  initiative: number;
  initiative_why: string;
}

export type AgendaStatus = "open" | "done" | "expired" | "dropped";

export interface AgendaItem {
  id: string;
  text: string;
  why: string;
  person: PersonId | null;
  context: ContextKey | null;
  created_at: Timestamp;
  due: Timestamp | null;
  expires_at: Timestamp | null;
  status: AgendaStatus;
  closed_at: Timestamp | null;
}

export interface FeelingView {
  person: PersonId;
  display_name: string | null;
  text: string;
  updated_at: Timestamp;
  by: string;
}

/** `GET /api/self`. */
export interface SelfView {
  at: Timestamp;
  mood: Mood | null;
  boredom: number;
  drives: Record<DriveName, number>;
  policy: SelfPolicy;
  /** Open items first, then recently closed ones. */
  agenda: AgendaItem[];
  /** Newest first. */
  feelings: FeelingView[];
}

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export interface PresenceActivity {
  type: "playing" | "streaming" | "listening" | "watching" | "competing" | "custom";
  name: string;
  details: string | null;
  state: string | null;
  started_at: Timestamp | null;
  url: string | null;
}

export interface VoiceSpot {
  platform: PlatformId;
  guild: string;
  channel: string;
  channel_name: string | null;
}

export interface PersonPresence {
  account: AccountRef;
  person: PersonId | null;
  display_name: string;
  status: PresenceStatus | null;
  activities: PresenceActivity[];
  voice: VoiceSpot | null;
  online_since: Timestamp | null;
  updated_at: Timestamp;
}

export interface VoiceMember {
  account: AccountRef;
  person: PersonId | null;
  display_name: string;
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  streaming: boolean;
  since: Timestamp;
}

export interface VoiceChannelState {
  platform: PlatformId;
  guild: string;
  channel: string;
  name: string | null;
  members: VoiceMember[];
}

export interface ChannelActivity {
  context: ContextKey;
  label: string | null;
  recent_messages: number;
  per_minute: number;
  last_at: Timestamp | null;
  recent_authors: string[];
  topic: string[];
  lively: boolean;
  her_last_at: Timestamp | null;
}

export interface HerStatus {
  voice: ContextKey | null;
  voice_name: string | null;
  golive: string | null;
  streaming: boolean;
  scene: string | null;
  game: string | null;
  /** The song she is singing. Absent on a Core from before the ActivityManager. */
  singing?: string | null;
}

export interface TimeContext {
  local: string;
  weekday: number;
  weekend: boolean;
  part_of_day: string;
  utc_offset_minutes: number;
}

/** `GET /api/world`. */
export interface WorldView {
  at: Timestamp;
  time: TimeContext;
  her: HerStatus;
  people: PersonPresence[];
  voice_channels: VoiceChannelState[];
  channels: ChannelActivity[];
}

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

export interface TelemetryLlm {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
  errors: number;
  /** Cumulative counts at each finite upper bound (seconds). */
  first_token: { count: number; sum_s: number; buckets: { le_s: number; count: number }[] };
}

/** One minute's sample. Counters are process totals; `events` count since the previous sample. */
export interface TelemetryPoint {
  at: Timestamp;
  mood: Mood | null;
  boredom: number | null;
  drives: Record<DriveName, number> | null;
  initiative: number | null;
  llm: TelemetryLlm;
  mind: { calls_total: number; tokens_total: number } | null;
  voice_sessions: number;
  speaking: boolean;
  /** `messages`, `turns`, `initiatives`, `utterances`, `actions`. */
  events: Record<string, number>;
}

/** `GET /api/telemetry?minutes=`. */
export interface TelemetryView {
  interval_ms: number;
  points: TelemetryPoint[];
}

// ---------------------------------------------------------------------------
// body, arbiter, affect, plan, prompts (`packages/api/src/{body,affect,plan,prompts}.ts`)

export type TaskId = string;
export type Handle = string;

export type EmotionName =
  | "joy"
  | "anger"
  | "sorrow"
  | "fear"
  | "surprise"
  | "disgust"
  | "shy"
  | "pride"
  | "jealousy"
  | "lonely"
  | "missing"
  | "gratitude"
  | "guilt"
  | "frustration";

export type AffectDriveName = DriveName | "esteem" | "hunger" | "longing";

export interface EmotionReading {
  name: EmotionName;
  intensity: number;
  cause: string;
  at: Timestamp;
  person: PersonId | null;
}

export interface ShownEmotion {
  from: EmotionName;
  tag: string;
  style: string;
  masked: boolean;
}

export interface AffectBiases {
  talkativeness: number;
  initiative: number;
  wants: { want: string; weight: number; person: Handle | null; why: string }[];
}

/** `GET /api/affect`. */
export interface AffectSnapshot {
  at: Timestamp;
  drives: Partial<Record<AffectDriveName, number>>;
  boredom: number;
  top: EmotionReading[];
  mood: Mood;
  mood_line: string;
  shown: ShownEmotion | null;
  biases: AffectBiases;
}

export type RelationshipLabel =
  | "很討厭"
  | "討厭"
  | "陌生人"
  | "認識"
  | "朋友"
  | "好朋友"
  | "摯友"
  | "知心"
  | "知己"
  | "至交"
  | "莫逆之交"
  | "心有靈犀"
  | "形影不離"
  | "家人般"
  | "生死之交"
  | "命運相連"
  | "無可取代"
  | "心之所歸"
  | "永恆羈絆";

/** `GET /api/affect/people`, highest attachment first. */
export interface PersonCard {
  person: PersonId;
  handle: Handle;
  call_name: string | null;
  affinity: number;
  trust: number;
  familiarity: number;
  attachment: number;
  emotions: Partial<Record<"missing" | "jealousy" | "gratitude" | "resentment", number>>;
  feeling: string;
  label: RelationshipLabel;
  /** -100..1000, one per affinity point (absent on an older Core). */
  level?: number;
  /** How she acts with them now, one line she wrote in her reflection; `null` or absent: none yet. */
  stance?: string | null;
  /** The `level` the stance was written at; she rewrites it every 5 levels. */
  stance_level?: number | null;
  owner: boolean;
  blocked: boolean;
  last_seen: Timestamp | null;
  last_together: Timestamp | null;
  updated_at: Timestamp;
}

export type GoalTrigger =
  | { kind: "at"; time: Timestamp }
  | { kind: "when_online"; person: Handle }
  | { kind: "after_activity"; activity: string }
  | { kind: "whenever" };

export type GoalStatus = "pending" | "active" | "done" | "dropped";

export interface Goal {
  id: string;
  what: string;
  why: string;
  trigger: GoalTrigger;
  steps: string[];
  status: GoalStatus;
  expires: Timestamp;
  person: Handle | null;
  context: ContextKey | null;
  source: "plan" | "plan_daily" | "reflect" | "panel";
  created_at: Timestamp;
  updated_at: Timestamp;
  closed_at: Timestamp | null;
  close_reason: string | null;
}

/** `GET /api/mind/goals`. */
export interface GoalsView {
  goals: Goal[];
  closed_included: boolean;
}

/** `GET /api/mind/plan`. */
export interface DayPlanView {
  day_plan: string | null;
}

export type ReasoningLevel = string;

export interface CompiledBlock {
  key: string;
  authority: string;
  source: string;
  chars_in: number;
  chars_out: number;
  budget_chars: number;
  fate: "kept" | "summarized" | "truncated" | "dropped";
}

/** `GET /api/prompts/{turn}`. */
export interface SavedPrompt {
  turn: TurnId;
  context: ContextKey;
  at: Timestamp;
  purpose: string;
  reasoning: ReasoningLevel;
  blocks: CompiledBlock[];
  messages: { role: "system" | "user" | "assistant"; text: string }[];
  prompt_tokens: number | null;
}

/** `GET /api/prompts` items. */
export interface PromptSummary {
  turn: TurnId;
  context: ContextKey;
  at: Timestamp;
  purpose: string;
  reasoning: ReasoningLevel;
  prompt_tokens: number | null;
  blocks: number;
  messages: number;
  chars: number;
}

export type TurnReason = "addressed" | "reply_to_her" | "ambient" | "initiative" | "notice";

export type TurnCancelCause = "input" | "barge_in" | "superseded" | "expired" | "floor" | "shutdown";

export type TurnOutcome =
  | { type: "sent"; parts: number }
  | { type: "silence" }
  | { type: "cancelled"; cause: TurnCancelCause; by: Handle | null }
  | { type: "error"; error: string };

export type TurnOutcomeKind = TurnOutcome["type"];

/** `GET /api/turns/outcomes` items, newest first. */
export interface TurnOutcomeRecord {
  turn: TurnId;
  context: ContextKey;
  reason: TurnReason;
  outcome: TurnOutcome;
  addressed_by: Handle[];
  focus: MessageRef[];
  restarts: number;
  reasoning: ReasoningLevel | null;
  latency_ms: number | null;
  at: Timestamp;
}

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

// ---------------------------------------------------------------------------
// the owner's rules (`GET /api/directives`; `packages/types` directive.ts)

export type DirectiveEffect = "deny" | "require_approval" | "prefer" | "avoid";

export type DirectiveAuthority = "owner" | "moderator" | "system" | "viewer";

export interface DirectiveScope {
  /** A capability or tool name, or a pattern (`game.*`, `*`). */
  capability?: string;
  /** A word of what is being done: the game (`minecraft`), a goal, a target. */
  activity?: string;
  context?: ContextKey;
  person?: Handle;
}

/** A stored rule and how it ended, if someone ended it. */
export interface DirectiveRecord {
  id: string;
  issuer: AccountRef;
  authority: DirectiveAuthority;
  scope: DirectiveScope;
  effect: DirectiveEffect;
  text: string;
  /** `until_revoked` never expires. */
  expires: Timestamp | "until_revoked";
  /** An EventLog id, `msg:<id>`, `command:<path>` or `panel:<actor>`. */
  source_event: string;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
}

/** `GET /api/directives`: `healthy` is false while the store cannot be read (everything fails closed). */
export interface DirectivesView {
  healthy: boolean;
  directives: DirectiveRecord[];
}

/** `POST /api/directives`. `minutes` left out: until revoked (a moderator has to say). */
export interface AddDirectiveRequest {
  text: string;
  effect: DirectiveEffect;
  scope?: { capability?: string; activity?: string };
  minutes?: number | null;
}

/** The answer of a change: a `question` means nothing happened and the Core needs more. */
export type DirectiveChange =
  | { status: "added"; directive: DirectiveRecord; note: string | null }
  | { status: "removed"; directive: DirectiveRecord }
  | { status: "question"; question: string };

// ---- turn metrics (`GET /api/turns/metrics`, mirrors packages/api/src/metrics-turns.ts) -------

/** `sent / total`; `rate` is `null` with no samples, never 0. */
export interface MetricRatio {
  sent: number;
  total: number;
  rate: number | null;
}

export interface FollowupStopReasons {
  anti_spam: number;
  low_score: number;
  lost_roll: number;
  floor: number;
  passed_silent: number;
  other: number;
}

export interface TurnMetricsBucket {
  turns: number;
  followup: MetricRatio;
  ambient: MetricRatio;
  addressed: MetricRatio;
  voice_latency: { p50_ms: number | null; p90_ms: number | null; samples: number };
  voice_origin: { self_started: number; answering: number };
  outcomes: { sent: number; silence: number; cancelled: number; error: number };
  followup_stopped: FollowupStopReasons;
}

export interface TurnMetricsDay extends TurnMetricsBucket {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
}

export interface TurnMetrics {
  days: number;
  from: string;
  /** The read cap was hit inside the window: its oldest day may be partial. */
  truncated: boolean;
  overall: TurnMetricsBucket;
  daily: TurnMetricsDay[];
}

// --- the admin routes V4 added: her life, economy, workspace, party games, notebook ---
// (Timestamps are ISO strings.)
// --- her life ---------------------------------------------------------------------

// --- economy 2.0 ----------------------------------------------------------------------

// --- her workspace and skills ----------------------------------------------------------

// --- memory -----------------------------------------------------------------------------

export interface NotebookEntry {
  path: string;
  chars: number;
  updated_at: Timestamp;
  about: string | null;
}

export interface NotebookPage extends NotebookEntry {
  body: string;
  created_at: Timestamp;
}

export type JustNowKind = "song" | "game" | "voice" | "stream" | "notice" | "talk" | "asked";

export interface JustNowEntry {
  at: Timestamp;
  kind: JustNowKind;
  place: { kind: "here" | "voice" | "text" | "dm"; label: string; context: ContextKey | null };
  text: string;
  private: boolean;
}

/** `GET /api/recent?context=`. */
export interface RecentView {
  entries: JustNowEntry[];
  /** Lines left out because they came from a DM. */
  private_hidden: number;
}

// --- party games -------------------------------------------------------------------------

export interface PartyPlayerView {
  name: string;
  her: boolean;
  score: number;
  present: boolean;
  active: boolean;
}

export interface PartySessionView {
  id: string;
  game: string;
  title: string;
  context: ContextKey;
  state: "running";
  started_at: Timestamp;
  scored: boolean;
  players: PartyPlayerView[];
}

export interface PartyResultView {
  id: string;
  game: string;
  title: string;
  context: ContextKey;
  /** `done`, `host`, `stop`, `idle`, `empty`, `left`, `away`. */
  reason: string;
  started_at: Timestamp;
  ended_at: Timestamp;
  scored: boolean;
  players: PartyPlayerView[];
}

/** `GET /api/party` (503 when the party module is off). */
export interface PartySnapshot {
  sessions: PartySessionView[];
  recent: PartyResultView[];
}
