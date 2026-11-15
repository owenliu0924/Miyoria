// Wire types shared by the server and the client. Field names and nullability are part of the
// JSON wire format; `apps/panel/src/api/*types.ts` mirror these.

import type {
  IssuedCard,
  IssuedFortune,
  MemberCard,
  MemberMemory,
  MemberSong,
} from "@miyoria/contracts/api";
import type { WalletExport } from "@miyoria/economy";
import type { MemoryKind, MemoryScope } from "@miyoria/store";
import type {
  ContextKey,
  PersonId,
  ProfileId,
  ReasoningLevel,
  Timestamp,
  TurnId,
  TurnOutcome,
} from "@miyoria/types";

// Shapes of the routes on the route table (`@miyoria/contracts/api`), under their old names.
export type {
  ActivitiesView,
  ActivityView,
  AdjustPersonRequest,
  ArbiterDecisionsView,
  ArbiterDecisionView,
  AssignRoleRequest,
  AuthMethods,
  BudgetState,
  CardField,
  CardPoseChoice,
  CardPrices,
  ChannelActivityView,
  ChannelLevelInfo,
  ChannelLevelsView,
  ChannelLevelView,
  ControlResult,
  ConversationNote as ConversationNoteView,
  CostReport,
  CostReport as CostInfo,
  DataCategoryView,
  DataInventoryView,
  DataNote,
  DataWipeResult,
  DayPlanView,
  DecisionRecord,
  E2eSegmentName,
  E2eStats,
  ExtensionInfo,
  FeelingView,
  FortuneField,
  GoalsView,
  HealthInfo,
  IssueCardRequest,
  IssuedCard,
  IssuedFortune,
  KnowledgeDoc as KnowledgeDocView,
  KnowledgeView,
  LatencyStats,
  Lesson as LessonView,
  LifeDayView,
  LifeEntry as LifeEntryView,
  McpServerInfo,
  McpState,
  McpToolInfo,
  MemberCard,
  MemberCards,
  MemberDay,
  MemberForgetResult,
  MemberMemory,
  MemberSession,
  MemberSong,
  MemberView,
  MindView,
  ModelUsage,
  ModuleInfo,
  PendingApproval,
  PeriodReport,
  PersonaOverride,
  PersonaSectionInfo,
  PersonDetail,
  PersonSummary,
  PersonWalletView,
  ProposedToolSummary,
  PublicBoard,
  PublicDay,
  PublicSong,
  PublicSongs,
  PublicState,
  PublicStatus,
  PublicToday,
  QueueAuthor,
  QueueItemInfo,
  QueueState,
  ReflectionView,
  RemindersView,
  ReminderView,
  RemoveMappingRequest,
  ReviewToolRequest,
  SayRequest,
  SayResponse,
  SceneRoleState,
  SceneRolesState,
  SelfView,
  SessionInfo,
  SessionPermissions,
  SessionUser,
  SetChannelLevelRequest,
  SetPersonaRequest,
  SetPersonaResponse,
  SkillSummary,
  SkillView,
  SongAccepted,
  SongsAnswer,
  SongsState,
  SongView,
  StageLinkState,
  StageState,
  StreamAction,
  ThoughtSummary,
  UpdatePersonRequest,
  UpsertRoleRequest,
  UsageInfo,
  UsageMap,
  VoiceE2eLatency,
  VoiceLatency,
  VoiceSession,
  VoiceState,
  WalletAdjustRequest,
  WalletAdjustResult,
  WorkspaceFile as WorkspaceFileView,
  WorkspaceView,
  WorldView,
} from "@miyoria/contracts/api";

/** `GET /api/member/export` (a file). */
export interface MemberExport {
  exported_at: string;
  card: MemberCard;
  memories: (MemberMemory & { derived_from_you: boolean })[];
  /** Memories left out because they hold someone else's name or words, or her own notes. */
  withheld: number;
  songs: MemberSong[];
  /** The cards she gave them, newest first. */
  cards: IssuedCard[];
  /** Their coins: the balance and every line of the ledger, newest first. */
  wallet: WalletExport;
  /** The fortune slips she wrote for them, newest first. */
  fortunes: IssuedFortune[];
}

/** Every error response: `{ "error": "..." }`. */
export interface ErrorBody {
  error: string;
}

/** A page of results. `next_cursor` is opaque; `null` on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ---- memory -----------------------------------------------------------------------------

/** A `MemoryRecord` without its search tokens and embedding vector. */
export interface MemoryRecordView {
  id: string;
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
  superseded_by: string | null;
  has_embedding: boolean;
}

/** `GET /api/memory` items. The scores are present only for a search (`q`). */
export interface MemoryItem {
  record: MemoryRecordView;
  /** The backend's full-text relevance, 0 when only the vector matched. */
  text_score?: number;
  /** `null` for a search that compared no vectors. */
  vector_score?: number | null;
  /**
   * Hybrid recall score (vector, text, recency, importance), present when the search ran through
   * the memory engine; results are ordered by it.
   */
  score?: number;
}

/** Query of `GET /api/memory`. */
export interface MemoryListQuery {
  /**
   * Search text: hybrid recall (vector, text, recency, importance) through the memory module
   * when it runs, full text otherwise. Omitted lists newest first.
   */
  q?: string;
  kind?: MemoryKind;
  subject?: PersonId;
  /** Only records created before this time (pagination when listing). */
  before?: Timestamp;
  include_superseded?: boolean;
  limit?: number;
}

/** Body of `PATCH /api/memory/{id}`; omitted fields are unchanged. */
export interface UpdateMemoryRequest {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  done?: boolean;
}

// ---- what she organized and learned (phase G) -----------------------------------------------

// ---- live controls (`control.ts`) and telemetry (`telemetry.ts`) ----------------------------

/** Process-wide LLM counters at a sample, summed over models and purposes. */
export interface TelemetryLlm {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
  errors: number;
  /** `miyoria_llm_first_token_seconds`: cumulative counts at each finite upper bound. */
  first_token: { count: number; sum_s: number; buckets: { le_s: number; count: number }[] };
}

/** One sample. Counters are totals since the process started; `events` count since the last one. */
export interface TelemetryPoint {
  at: string;
  mood: { valence: number; arousal: number; energy: number } | null;
  boredom: number | null;
  drives: Record<string, number> | null;
  initiative: number | null;
  llm: TelemetryLlm;
  mind: { calls_total: number; tokens_total: number } | null;
  voice_sessions: number;
  speaking: boolean;
  /** `messages`, `turns`, `initiatives`, `utterances`, `actions` since the previous sample. */
  events: Record<string, number>;
}

/** `GET /api/telemetry?minutes=360`: samples, oldest first. */
export interface TelemetryView {
  interval_ms: number;
  points: TelemetryPoint[];
}

// ---- body, arbiter, affect, plan, prompts (docs/design/v2-architecture.md §3) -------------

/** One saved prompt without its blocks and messages (`GET /api/prompts`). */
export interface PromptSummary {
  turn: TurnId;
  context: ContextKey;
  at: Timestamp;
  purpose: string;
  reasoning: ReasoningLevel;
  prompt_tokens: number | null;
  blocks: number;
  messages: number;
  /** Characters of all kept messages. */
  chars: number;
}

/** The outcome kinds of a turn (`TurnOutcome["type"]`). */
export type TurnOutcomeKind = TurnOutcome["type"];
