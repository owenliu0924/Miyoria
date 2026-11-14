// Her mind loop and autonomy: what she thought, what waits for an owner, and the emergency stop.
// The changes need the owner-level node `owner.autonomy.approve`.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonValueSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { route } from "./route.js";

/** The owner-level node of an approval and of the emergency stop (the bearer token holds it). */
const NODE_APPROVE = "owner.autonomy.approve";

/** One step of the emergency stop, in the order they run. */
export const EmergencyStepSchema = z
  .object({
    step: z.enum(["pause", "silence", "song", "stream", "voice", "game", "resume"]),
    ok: z.boolean(),
    /** What happened, for whoever pressed the button. */
    detail: z.string(),
  })
  .meta({ id: "ApiEmergencyStep" });
export type EmergencyStep = z.output<typeof EmergencyStepSchema>;

/** How the last press of the emergency stop went, step by step. */
export const EmergencyReportSchema = z
  .object({
    /** She is stopped after this. */
    paused: z.boolean(),
    /** Who pressed it (`panel:<actor>`, `command:discord:1`). */
    by: z.string(),
    at: TimestampSchema,
    steps: z.array(EmergencyStepSchema),
  })
  .meta({ id: "ApiEmergencyReport" });
export type EmergencyReport = z.output<typeof EmergencyReportSchema>;

/** Calls of her mind loop. */
export const MindStatsSchema = z
  .object({
    /** Calls in the last hour. */
    calls_last_hour: z.number(),
    max_calls_per_hour: z.number(),
    calls_total: z.number(),
    tokens_total: z.number(),
    last_at: TimestampSchema.nullable(),
    next_heartbeat_at: TimestampSchema.nullable(),
    /** Why she is not thinking right now (`paused`, `budget exhausted`, ...). */
    idle_reason: z.string().nullable(),
  })
  .meta({ id: "ApiMindStats" });
export type MindStats = z.output<typeof MindStatsSchema>;

/** `GET /api/mind`, and the answer of `POST /api/mind/pause` and `resume`. */
export const MindViewSchema = z
  .object({
    /** The emergency stop is on: she does not reply or speak, only commands and the panel act. */
    paused: z.boolean(),
    /** The `mind` module is running. */
    running: z.boolean(),
    /** Her mind takes triggers right now. */
    accepting: z.boolean(),
    stats: MindStatsSchema.nullable(),
    /** High-risk actions waiting for an owner. */
    pending_approvals: z.number(),
    /** The last press of the emergency stop; `null`: none since the Core started. */
    emergency: EmergencyReportSchema.nullable(),
  })
  .meta({ id: "ApiMindView" });
export type MindView = z.output<typeof MindViewSchema>;

export const ThoughtTriggerKindSchema = z
  .enum(["heartbeat", "salient", "suggestion", "turn", "voice_quiet", "manual"])
  .meta({ id: "ApiThoughtTriggerKind" });
export type ThoughtTriggerKind = z.output<typeof ThoughtTriggerKindSchema>;

/** What woke her. */
export const ThoughtTriggerSchema = z
  .object({
    kind: ThoughtTriggerKindSchema,
    /** A short neutral description (may contain untrusted names). */
    detail: z.string(),
    context: ContextKeySchema.nullable(),
    at: TimestampSchema,
  })
  .meta({ id: "ApiThoughtTrigger" });
export type ThoughtTrigger = z.output<typeof ThoughtTriggerSchema>;

/** A gate decision made for one of her intents (before the action, or a tool call in her turn). */
export const ThoughtDecisionSchema = z
  .object({
    at: TimestampSchema,
    capability: z.string(),
    allowed: z.boolean(),
    stage: z.string(),
    reason: z.string(),
  })
  .meta({ id: "ApiThoughtDecision" });
export type ThoughtDecision = z.output<typeof ThoughtDecisionSchema>;

export const IntentStatusSchema = z
  .enum(["pending", "started", "done", "denied", "dropped", "failed"])
  .meta({ id: "ApiIntentStatus" });
export type IntentStatus = z.output<typeof IntentStatusSchema>;

/** Something she decided to do, and what became of it. */
export const ThoughtIntentSchema = z
  .object({
    id: z.string(),
    capability: z.string(),
    args: JsonValueSchema,
    /** Her reason, in her own words. */
    why: z.string(),
    opening: z.string().nullable(),
    context: ContextKeySchema.nullable(),
    about: AccountRefSchema.nullable(),
    expires_at: TimestampSchema,
    status: IntentStatusSchema,
    detail: z.string().nullable(),
    turn: z.string().nullable(),
    decisions: z.array(ThoughtDecisionSchema),
    /** What she said in the turn she opened. */
    said: z.string().nullable(),
    /** Every status it went through, oldest first (newer journals only). */
    history: z
      .array(
        z.object({
          at: TimestampSchema,
          status: IntentStatusSchema,
          detail: z.string().nullable(),
        }),
      )
      .optional(),
  })
  .meta({ id: "ApiThoughtIntent" });
export type ThoughtIntent = z.output<typeof ThoughtIntentSchema>;

/** A reason to think, offered by another module. */
export const MindSuggestionSchema = z
  .object({
    /** The module, e.g. `initiative`. */
    source: z.string(),
    /** `idle_channel`, `greeting`, `voice_join`, `followup`, ... */
    reason: z.string(),
    context: ContextKeySchema.nullable(),
    /** What it is about (may quote other people). */
    hint: z.string(),
    about: z.array(AccountRefSchema),
  })
  .meta({ id: "ApiMindSuggestion" });
export type MindSuggestion = z.output<typeof MindSuggestionSchema>;

/** What one thought changed, item by item (`changes` says it in words). */
export const ThoughtEffectsSchema = z
  .object({
    drives: z.record(z.string(), z.number()),
    /** Emotion changes (name: change). */
    emotions: z.record(z.string(), z.number()).optional(),
    talkativeness: z.array(
      z.object({ scope: z.string(), level: z.number(), minutes: z.number(), why: z.string() }),
    ),
    initiative: z.object({ level: z.number(), why: z.string() }).nullable(),
    feelings: z.array(
      z.object({
        person: z.string(),
        name: z.string(),
        note: z.string().nullable(),
        hint: z.enum(["+", "-"]).nullable(),
      }),
    ),
    agenda_added: z.array(z.object({ text: z.string(), why: z.string() })),
    agenda_done: z.array(z.string()),
    agenda_dropped: z.array(z.string()),
    documents: z.array(
      z.object({
        type: z.string(),
        title: z.string().nullable(),
        ok: z.boolean(),
        error: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: "ApiThoughtEffects" });
export type ThoughtEffects = z.output<typeof ThoughtEffectsSchema>;

/**
 * One entry of her thought journal as the list gives it: without what she saw (`input`) and her
 * reasoning, which are large (the entry's own route has them); `has_input` and `has_reasoning` say
 * whether it does.
 */
export const ThoughtSummarySchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    triggers: z.array(ThoughtTriggerSchema),
    /** Her inner monologue (first person, in her voice). */
    thought: z.string(),
    /** What she changed in her inner state, in words. */
    changes: z.array(z.string()),
    intents: z.array(ThoughtIntentSchema),
    /** Prompt and completion tokens of the call, when reported. */
    tokens: z.number().nullable(),
    /** The call or the reply failed; `thought` is empty then. */
    error: z.string().nullable(),
    /** Latency of the call. */
    ms: z.number(),
    /** The suggestions that woke her (newer journals only). */
    suggestions: z.array(MindSuggestionSchema).optional(),
    effects: ThoughtEffectsSchema.nullable().optional(),
    /** Ids of her LLM calls for this thought. */
    calls: z.array(z.string()).optional(),
    /** Cost of those calls in USD. */
    cost_usd: z.number().nullable().optional(),
    /** Calls made (2 = one repair). */
    attempts: z.number().optional(),
    /** Thoughts in a row that did nothing before this one, and for how long. */
    idle: z.object({ thoughts: z.number(), minutes: z.number() }).nullable().optional(),
    has_input: z.boolean(),
    has_reasoning: z.boolean(),
  })
  .meta({ id: "ApiThoughtSummary" });
export type ThoughtSummary = z.output<typeof ThoughtSummarySchema>;

/** A high-risk action waiting for an owner. */
export const PendingApprovalSchema = z
  .object({
    id: z.string(),
    capability: z.string(),
    summary: z.string(),
    /** The audit actor of the principal (`self`, `user:discord:1`, ...). */
    principal: z.string(),
    args: JsonValueSchema,
    why: z.string().nullable(),
    /** The self-review's reason for being uncertain. */
    review: z.string(),
    requested_at: TimestampSchema,
    expires_at: TimestampSchema,
  })
  .meta({ id: "ApiPendingApproval" });
export type PendingApproval = z.output<typeof PendingApprovalSchema>;

const ApprovalParams = z.object({ params: z.object({ id: z.string() }) });

export const mind = {
  status: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/mind" })
    .output(MindViewSchema),
  /**
   * Her thought journal, newest first. `limit` defaults to 50 and is held to 1..300; one that is
   * not a number is the default.
   */
  thoughts: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/mind/thoughts" })
    .input(z.object({ query: z.object({ limit: z.union([z.string(), z.number()]).optional() }) }))
    .output(z.array(ThoughtSummarySchema)),
  approvals: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/mind/approvals" })
    .output(z.array(PendingApprovalSchema)),
  /** Answers the approval and gives the ones still waiting. `404` when it was answered or expired. */
  approve: route
    .meta({ audience: "admin", permission: NODE_APPROVE })
    .route({ method: "POST", path: "/api/mind/approvals/{id}/approve" })
    .input(ApprovalParams)
    .output(z.array(PendingApprovalSchema)),
  deny: route
    .meta({ audience: "admin", permission: NODE_APPROVE })
    .route({ method: "POST", path: "/api/mind/approvals/{id}/deny" })
    .input(ApprovalParams)
    .output(z.array(PendingApprovalSchema)),
  /** The emergency stop. */
  pause: route
    .meta({ audience: "admin", permission: NODE_APPROVE })
    .route({ method: "POST", path: "/api/mind/pause" })
    .output(MindViewSchema),
  resume: route
    .meta({ audience: "admin", permission: NODE_APPROVE })
    .route({ method: "POST", path: "/api/mind/resume" })
    .output(MindViewSchema),
};
