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
  MemoryItem,
  MemoryRecordView,
  MindView,
  ModelUsage,
  ModuleInfo,
  PartySnapshot,
  PendingApproval,
  PeriodReport,
  PersonaOverride,
  PersonaSectionInfo,
  PersonDetail,
  PersonSummary,
  PersonWalletView,
  PromptSummary,
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
  TelemetryLlm,
  TelemetryPoint,
  TelemetryView,
  ThoughtSummary,
  TurnOutcomeKind,
  UpdateMemoryRequest,
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
