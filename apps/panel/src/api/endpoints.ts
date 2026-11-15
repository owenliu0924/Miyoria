// One function per Admin API route (`packages/api/src`) that is not on the route table yet. The
// routes on the table (`@miyoria/contracts/api`) are called through `rpc` and `q` (`orpc.ts`);
// a group that moves there loses its functions here.

import { type ApiClient, seg } from "./http";
import { createQueries, createRpc } from "./orpc";
import type {
  ContextKey,
  DataCategoryId,
  AddDirectiveRequest,
  DirectiveChange,
  DirectivesView,
  MemoryItem,
  MemoryQuery,
  MemoryRecordView,
  Page,
  UpdateMemoryRequest,
  SelfView,
  WorldView,
  ThoughtDigest,
  KnowledgeView,
  ConversationNote,
  ReflectionView,

  TelemetryView,
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
  LifeDayView,
  NotebookEntry,
  NotebookPage,
  PartySnapshot,
  RecentView,
  RemindersView,
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

    self: (o?: Opts) => client.get<SelfView>("/api/self", o),
    world: (o?: Opts) => client.get<WorldView>("/api/world", o),
    // her data: the inventory and the deletes are on the route table, the downloads are not
    /** A JSON backup of `categories` (all exportable ones without). */
    dataExport: (categories?: DataCategoryId[]) =>
      client.download("GET", "/api/data/export", { query: { categories: categories?.join(",") } }),
    /** The full backup a reset needs; its `x-miyoria-backup-token` header unlocks the reset. */
    dataBackup: () => client.download("POST", "/api/data/backup"),
    digests: (limit: number, o?: Opts) => client.get<ThoughtDigest[]>(`/api/mind/digests?limit=${limit}`, o),
    knowledge: (o?: Opts) => client.get<KnowledgeView>("/api/knowledge", o),
    conversationNotes: (o?: Opts) => client.get<ConversationNote[]>("/api/knowledge/conversations", o),
    reflection: (days: number, o?: Opts) => client.get<ReflectionView>(`/api/reflection?days=${days}`, o),

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

    directives: (history: boolean, o?: Opts) =>
      client.get<DirectivesView>("/api/directives", { ...o, query: { history: history ? "1" : undefined } }),
    addDirective: (req: AddDirectiveRequest) => client.post<DirectiveChange>("/api/directives", req),
    removeDirective: (id: string) => client.delete<DirectiveChange>(`/api/directives/${seg(id)}`),
    telemetry: (minutes: number, o?: Opts) =>
      client.get<TelemetryView>("/api/telemetry", { ...o, query: { minutes } }),

    lifeToday: (o?: Opts) => client.get<LifeDayView>("/api/life/today", o),
    reminders: (o?: Opts) => client.get<RemindersView>("/api/life/reminders", o),
    cancelReminder: (key: string) => client.delete<{ cancelled: true; key: string }>(`/api/life/reminders/${seg(key)}`),
    activities: (o?: Opts) => client.get<ActivitiesView>("/api/life/activities", o),

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
