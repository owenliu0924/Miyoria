// One function per Admin API route (`packages/api/src`) that is not on the route table yet. The
// routes on the table (`@miyoria/contracts/api`) are called through `rpc` and `q` (`orpc.ts`);
// a group that moves there loses its functions here.

import { type ApiClient, seg } from "./http";
import { createQueries, createRpc } from "./orpc";
import type {
  ContextKey,
  DataCategoryId,
  DataInventory,
  DataWipeResult,
  AddDirectiveRequest,
  CauseChain,
  Delivery,
  DirectiveChange,
  DirectivesView,
  ExtensionInfo,
  FactEventsQuery,
  LogEvent,
  McpServerInfo,
  MemoryItem,
  MemoryQuery,
  MemoryRecordView,
  Page,
  QueueState,
  SayRequest,
  SceneRolesState,
  StageState,
  StreamAction,
  UpdateMemoryRequest,
  VoiceState,
  SelfView,
  WorldView,
  Thought,
  ThoughtDigest,
  KnowledgeView,
  ConversationNote,
  ReflectionView,

  ControlResult,
  GameStartRequest,
  SongsState,
  TelemetryView,
  LlmCallDetail,
  LlmCallRecord,
  LlmCallsPage,
  LlmThinkingPage,
  LlmThinkingQuery,
  LlmCallsQuery,
  LlmCallStats,
  ActivitySnapshot,
  ActivityTask,
  AffectSnapshot,
  ArbiterDecisionsView,
  ArbiterVerdict,
  DayPlanView,
  GoalsView,
  LedgerView,
  PersonCard,
  PromptSummary,
  SavedPrompt,
  TurnMetrics,
  TurnOutcomeKind,
  TurnOutcomeRecord,
  ActivitiesView,
  CommissionView,
  EconomyHealth,
  LifeDayView,
  NotebookEntry,
  NotebookPage,
  PartySnapshot,
  PredictionView,
  QuestsView,
  ReachedGoal,
  RecentView,
  RemindersView,
  RoomItem,
  SkillSummary,
  SkillView,
  WorkspaceView,
} from "./types";

type Opts = { signal?: AbortSignal };

export function createApi(client: ApiClient) {
  const rpc = createRpc(client);
  return {
    /** The route table's typed client: `api.rpc.persona.list()`. */
    rpc,
    /** Its TanStack Query helpers: `useQuery(api.q.health.queryOptions())`. */
    q: createQueries(rpc),

    // panel login
    /** Ends the Discord session (clears the cookie); harmless for the token. */
    logout: () => client.post<void>("/api/auth/logout", undefined, { public: true }),
    /** Where the browser goes to start a Discord login; `next` is a local path such as `/people`. */
    discordLoginUrl: (next: string) => client.url("/api/auth/oauth/login", { next }),

    // what anyone may see, and what a logged-in person has of their own: the cookie alone
    memberExportUrl: () => client.url("/api/member/export"),

    memory: (q: MemoryQuery = {}, o?: Opts) =>
      client.get<Page<MemoryItem>>("/api/memory", { ...o, query: { ...q } }),
    updateMemory: (id: string, req: UpdateMemoryRequest) =>
      client.patch<MemoryRecordView>(`/api/memory/${seg(id)}`, req),
    deleteMemory: (id: string) => client.delete<void>(`/api/memory/${seg(id)}`),

    extensions: (o?: Opts) => client.get<ExtensionInfo[]>("/api/extensions", o),
    extensionAction: (id: string, action: "enable" | "disable" | "restart") =>
      client.post<ExtensionInfo>(`/api/extensions/${seg(id)}/${action}`),

    mcpServers: (o?: Opts) => client.get<McpServerInfo[]>("/api/mcp", o),
    /** Only `restart` exists at runtime; servers are turned on and off in `miyoria.toml`. */
    mcpRestart: (name: string) => client.post<McpServerInfo>(`/api/mcp/${seg(name)}/restart`),

    queue: (o?: Opts) => client.get<QueueState>("/api/queue", o),
    queueSkip: (id: string) => client.post<QueueState>(`/api/queue/${seg(id)}/skip`),
    queueMove: (id: string, position: number) =>
      client.post<QueueState>(`/api/queue/${seg(id)}/move`, { position }),
    queuePause: (paused: boolean) =>
      client.post<QueueState>(`/api/queue/${paused ? "pause" : "resume"}`),

    stage: (o?: Opts) => client.get<StageState>("/api/stage", o),
    stageScene: (scene: string) => client.post<StageState>("/api/stage/scene", { scene }),
    stageExpression: (expression: string) =>
      client.post<StageState>("/api/stage/expression", { expression }),
    stageStream: (action: StreamAction) => client.post<StageState>("/api/stage/stream", { action }),
    stageSay: (req: SayRequest) => client.post<{ turn: string | null }>("/api/stage/say", req),
    sceneRoles: (o?: Opts) => client.get<SceneRolesState>("/api/stage/scenes", o),
    setSceneRole: (role: string, scene: string | null) =>
      client.put<SceneRolesState>("/api/stage/scenes", { role, scene }),
    classifyScenes: () => client.post<SceneRolesState>("/api/stage/scenes/classify"),

    voice: (o?: Opts) => client.get<VoiceState>("/api/voice", o),

    self: (o?: Opts) => client.get<SelfView>("/api/self", o),
    world: (o?: Opts) => client.get<WorldView>("/api/world", o),
    // her data
    dataInventory: (o?: Opts) => client.get<DataInventory>("/api/data", o),
    /** A JSON backup of `categories` (all exportable ones without). */
    dataExport: (categories?: DataCategoryId[]) =>
      client.download("GET", "/api/data/export", { query: { categories: categories?.join(",") } }),
    dataWipe: (categories: DataCategoryId[], confirm?: string) =>
      client.post<DataWipeResult>("/api/data/wipe", { categories, confirm }),
    /** The full backup a reset needs; its `x-miyoria-backup-token` header unlocks the reset. */
    dataBackup: () => client.download("POST", "/api/data/backup"),
    dataReset: (confirm: string, backupToken: string) =>
      client.post<DataWipeResult>("/api/data/reset", { confirm, backup_token: backupToken }),
    digests: (limit: number, o?: Opts) => client.get<ThoughtDigest[]>(`/api/mind/digests?limit=${limit}`, o),
    knowledge: (o?: Opts) => client.get<KnowledgeView>("/api/knowledge", o),
    conversationNotes: (o?: Opts) => client.get<ConversationNote[]>("/api/knowledge/conversations", o),
    reflection: (days: number, o?: Opts) => client.get<ReflectionView>(`/api/reflection?days=${days}`, o),

    // live controls (through the actuator gate as the panel)
    voiceJoin: (guild: string, channel: string | null) =>
      client.post<ControlResult>("/api/voice/join", { guild, channel }),
    voiceLeave: (guild?: string) => client.post<ControlResult>("/api/voice/leave", { guild: guild ?? null }),
    goLive: (action: StreamAction, guild?: string) =>
      client.post<ControlResult>("/api/voice/golive", { action, guild: guild ?? null }),
    songs: (o?: Opts) => client.get<SongsState>("/api/songs", o),
    requestSong: (query: string, key?: number) =>
      client.post<SongsState & ControlResult>("/api/songs", { query, key: key ?? null }),
    playSong: (song?: number) => client.post<SongsState & ControlResult>("/api/songs/play", { song: song ?? null }),
    stopSong: (all: boolean) => client.post<SongsState & ControlResult>("/api/songs/stop", { all }),
    gameStart: (req: GameStartRequest) => client.post<ControlResult>("/api/game/start", req),
    gameStop: () => client.post<ControlResult>("/api/game/stop", {}),
    gameGoal: (text: string) => client.post<ControlResult>("/api/game/goal", { text }),

    thought: (id: string, o?: Opts) => client.get<Thought>(`/api/mind/thoughts/${seg(id)}`, o),
    llmCalls: (q: LlmCallsQuery, limit: number, before: string | null, o?: Opts) =>
      client.get<LlmCallsPage>("/api/llm/calls", {
        ...o,
        query: {
          purpose: q.purpose,
          model: q.model,
          module: q.module,
          status: q.status,
          trouble: q.trouble ? "true" : undefined,
          thought: q.thought,
          turn: q.turn,
          since: q.since,
          q: q.q,
          limit,
          before: before ?? undefined,
        },
      }),
    llmCall: (id: string, o?: Opts) =>
      client.get<{ call: LlmCallRecord; detail: LlmCallDetail | null }>(`/api/llm/calls/${seg(id)}`, o),
    llmThinking: (q: LlmThinkingQuery, limit: number, before: string | null, o?: Opts) =>
      client.get<LlmThinkingPage>("/api/llm/thinking", {
        ...o,
        query: {
          kind: q.kind,
          reasoned: q.reasoned ? "true" : undefined,
          since: q.since,
          q: q.q,
          limit,
          before: before ?? undefined,
        },
      }),
    llmStats: (minutes: number | null, o?: Opts) =>
      client.get<LlmCallStats>("/api/llm/stats", { ...o, query: { minutes: minutes ?? undefined } }),

    // body, arbiter, affect, plan, prompts
    activity: (o?: Opts) => client.get<ActivitySnapshot>("/api/activity", o),
    activityTasks: (limit: number, o?: Opts) =>
      client.get<ActivityTask[]>("/api/activity/tasks", { ...o, query: { limit } }),
    ledger: (context: ContextKey | undefined, limit: number, o?: Opts) =>
      client.get<LedgerView>("/api/arbiter/ledger", {
        ...o,
        query: { limit, context: context ? JSON.stringify(context) : undefined },
      }),
    arbiterDecisions: (q: { limit?: number; verdict?: ArbiterVerdict; context?: ContextKey }, o?: Opts) =>
      client.get<ArbiterDecisionsView>("/api/arbiter/decisions", {
        ...o,
        query: { limit: q.limit, verdict: q.verdict, context: q.context ? JSON.stringify(q.context) : undefined },
      }),
    affect: (o?: Opts) => client.get<AffectSnapshot>("/api/affect", o),
    affectPeople: (o?: Opts) => client.get<PersonCard[]>("/api/affect/people", o),
    goals: (closed: boolean, o?: Opts) =>
      client.get<GoalsView>("/api/mind/goals", { ...o, query: { closed: closed ? "true" : undefined } }),
    dayPlan: (o?: Opts) => client.get<DayPlanView>("/api/mind/plan", o),
    prompts: (limit: number, context?: ContextKey, o?: Opts) =>
      client.get<PromptSummary[]>("/api/prompts", {
        ...o,
        query: { limit, context: context ? JSON.stringify(context) : undefined },
      }),
    prompt: (turn: string, o?: Opts) => client.get<SavedPrompt>(`/api/prompts/${seg(turn)}`, o),
    turnOutcomes: (q: { limit?: number; outcome?: TurnOutcomeKind; context?: ContextKey }, o?: Opts) =>
      client.get<TurnOutcomeRecord[]>("/api/turns/outcomes", {
        ...o,
        query: { limit: q.limit, outcome: q.outcome, context: q.context ? JSON.stringify(q.context) : undefined },
      }),

    turnMetrics: (days: number, o?: Opts) => client.get<TurnMetrics>("/api/turns/metrics", { ...o, query: { days } }),

    factEvents: (q: FactEventsQuery, o?: Opts) =>
      client.get<LogEvent[]>("/api/facts/events", {
        ...o,
        query: { kind: q.kind?.join(","), source: q.source?.join(","), turn: q.turn, since: q.since, until: q.until, before: q.before, order: q.order, limit: q.limit },
      }),
    factDeliveries: (limit: number, o?: Opts) => client.get<Delivery[]>("/api/facts/deliveries", { ...o, query: { limit } }),

    directives: (history: boolean, o?: Opts) =>
      client.get<DirectivesView>("/api/directives", { ...o, query: { history: history ? "1" : undefined } }),
    addDirective: (req: AddDirectiveRequest) => client.post<DirectiveChange>("/api/directives", req),
    removeDirective: (id: string) => client.delete<DirectiveChange>(`/api/directives/${seg(id)}`),
    factChain: (id: string, o?: Opts) => client.get<CauseChain>(`/api/facts/events/${seg(id)}/chain`, o),

    telemetry: (minutes: number, o?: Opts) =>
      client.get<TelemetryView>("/api/telemetry", { ...o, query: { minutes } }),

    lifeToday: (o?: Opts) => client.get<LifeDayView>("/api/life/today", o),
    reminders: (o?: Opts) => client.get<RemindersView>("/api/life/reminders", o),
    cancelReminder: (key: string) => client.delete<{ cancelled: true; key: string }>(`/api/life/reminders/${seg(key)}`),
    activities: (o?: Opts) => client.get<ActivitiesView>("/api/life/activities", o),

    economyHealth: (o?: Opts) => client.get<EconomyHealth>("/api/economy/health", o),
    commissions: (o?: Opts) => client.get<{ currency: string; commissions: CommissionView[] }>("/api/economy/commissions", o),
    predictions: (o?: Opts) => client.get<{ currency: string; predictions: PredictionView[] }>("/api/economy/predictions", o),
    room: (o?: Opts) => client.get<{ currency: string; room: RoomItem[] }>("/api/economy/room", o),
    reachedGoals: (o?: Opts) => client.get<{ goals: ReachedGoal[] }>("/api/economy/goals", o),
    fulfillGoal: (id: string) => client.post<{ goal: ReachedGoal }>(`/api/economy/goals/${seg(id)}/fulfill`, {}),
    personQuests: (id: string, o?: Opts) => client.get<QuestsView>(`/api/people/${seg(id)}/quests`, o),

    workspace: (o?: Opts) => client.get<WorkspaceView>("/api/workspace", o),
    skills: (o?: Opts) => client.get<{ skills: SkillSummary[] }>("/api/skills", o),
    skill: (name: string, o?: Opts) => client.get<SkillView>(`/api/skills/${seg(name)}`, o),

    party: (o?: Opts) => client.get<PartySnapshot>("/api/party", o),

    notebook: (o?: Opts) => client.get<{ pages: NotebookEntry[] }>("/api/notebook", o),
    notebookPage: (path: string, o?: Opts) => client.get<NotebookPage>("/api/notebook/page", { ...o, query: { path } }),
    recent: (context: ContextKey, o?: Opts) => client.get<RecentView>("/api/recent", { ...o, query: { context: JSON.stringify(context) } }),
  };
}

export type Api = ReturnType<typeof createApi>;
