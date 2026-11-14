// The Core's own state: its modules, why she did or did not reply, and what the LLM calls cost.

import { z } from "zod";
import { ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { UsizeQuery } from "./shared.js";

export const ModuleStateKindSchema = z
  .enum(["disabled", "starting", "running", "degraded", "stopping", "stopped", "failed"])
  .meta({ id: "ApiModuleStateKind" });
export type ModuleStateKind = z.output<typeof ModuleStateKindSchema>;

/** One module as the supervisor reports it. */
export const ModuleInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    state: ModuleStateKindSchema,
    /** Why it is not running, when it is not. */
    reason: z.string().nullable(),
    /** Restarts in the recent window. */
    recent_restarts: z.number(),
  })
  .meta({ id: "ApiModuleInfo" });
export type ModuleInfo = z.output<typeof ModuleInfoSchema>;

/** One attention decision: why she did or did not reply. */
export const DecisionTraceSchema = z
  .object({
    turn: z.string(),
    context: ContextKeySchema,
    respond: z.boolean(),
    score: z.number(),
    reasons: z.array(z.string()),
  })
  .meta({ id: "ApiDecisionTrace" });
export type DecisionTrace = z.output<typeof DecisionTraceSchema>;

export const DecisionRecordSchema = z
  .object({
    id: z.string(),
    profile: z.string(),
    ts: TimestampSchema,
    trace: DecisionTraceSchema,
  })
  .meta({ id: "ApiDecisionRecord" });
export type DecisionRecord = z.output<typeof DecisionRecordSchema>;

/** Token usage of one `provider:model` since the Core started. */
export const UsageInfoSchema = z
  .object({
    calls: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cached_prompt_tokens: z.number(),
  })
  .meta({ id: "ApiUsageInfo" });
export type UsageInfo = z.output<typeof UsageInfoSchema>;

/** `GET /api/llm/usage`: by `provider:model`, keys ascending. */
export const UsageMapSchema = z.record(z.string(), UsageInfoSchema).meta({ id: "ApiUsageMap" });
export type UsageMap = z.output<typeof UsageMapSchema>;

export const BudgetStateSchema = z.enum(["ok", "degraded", "exhausted"]).meta({
  id: "ApiBudgetState",
});
export type BudgetState = z.output<typeof BudgetStateSchema>;

/** Usage and cost of one model within one period. */
export const ModelUsageSchema = z
  .object({
    calls: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cached_prompt_tokens: z.number(),
    cost_usd: z.number(),
  })
  .meta({ id: "ApiModelUsage" });
export type ModelUsage = z.output<typeof ModelUsageSchema>;

export const PeriodReportSchema = z
  .object({
    /** `2026-11-01` for a day, `2026-11` for a month. */
    period: z.string(),
    total_usd: z.number(),
    calls: z.number(),
    /** Per `provider:model`, in key order. */
    models: z.record(z.string(), ModelUsageSchema),
  })
  .meta({ id: "ApiPeriodReport" });
export type PeriodReport = z.output<typeof PeriodReportSchema>;

/** `GET /api/llm/cost`: spend today and this month, and the budget's state. */
export const CostReportSchema = z
  .object({
    state: BudgetStateSchema,
    /** The daily budget in USD; `null`: none. */
    daily_usd: z.number().nullable(),
    monthly_usd: z.number().nullable(),
    /** The fraction of a budget at which the router degrades, e.g. `0.8`. */
    degrade_at: z.number(),
    today: PeriodReportSchema,
    month: PeriodReportSchema,
  })
  .meta({ id: "ApiCostReport" });
export type CostReport = z.output<typeof CostReportSchema>;

export const modules = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/modules" })
    .output(z.array(ModuleInfoSchema)),
  /**
   * Enables, disables or restarts a module and answers its status afterwards. `action` is a string
   * here and the server checks it (`enable`, `disable` or `restart`; another is a 404). `409`
   * when the module cannot be stopped, or is the API itself.
   */
  action: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/modules/{id}/{action}" })
    .input(z.object({ params: z.object({ id: z.string(), action: z.string() }) }))
    .output(ModuleInfoSchema),
};

/**
 * `GET /api/decisions`: the newest attention decisions, newest first. `limit` defaults to 50 and is
 * capped at 1000; `context` is a JSON-encoded context key (`{"platform":...}`) that the server
 * decodes (not JSON: 400).
 */
export const decisions = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/decisions" })
  .input(
    z.object({ query: z.object({ limit: UsizeQuery.optional(), context: z.string().optional() }) }),
  )
  .output(z.array(DecisionRecordSchema));

export const llm = {
  usage: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/usage" })
    .output(UsageMapSchema),
  cost: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/cost" })
    .output(CostReportSchema),
};
