// What she wants to do, read-only: `GET /api/mind/goals` (her structured agenda, soonest trigger
// first) and `GET /api/mind/plan` (today's plan in her words). They join the `mind` group.

import { z } from "zod";
import { ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { FlagQuery } from "./shared.js";

/** When a goal should be acted on. */
export const GoalTriggerSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("at"), time: TimestampSchema }),
    z.object({ kind: z.literal("when_online"), person: z.string() }),
    /** An activity type, optionally with its target (`game:minecraft`). */
    z.object({ kind: z.literal("after_activity"), activity: z.string() }),
    /** Any time it fits. */
    z.object({ kind: z.literal("whenever") }),
  ])
  .meta({ id: "ApiGoalTrigger" });
export type GoalTrigger = z.output<typeof GoalTriggerSchema>;

export const GoalStatusSchema = z
  .enum(["pending", "active", "done", "dropped"])
  .meta({ id: "ApiGoalStatus" });
export type GoalStatus = z.output<typeof GoalStatusSchema>;

/** One of her goals: what, why, when it should happen and when it stops mattering. */
export const GoalSchema = z
  .object({
    id: z.string(),
    what: z.string(),
    why: z.string(),
    trigger: GoalTriggerSchema,
    /** Coarse steps; empty: none. */
    steps: z.array(z.string()),
    status: GoalStatusSchema,
    /** Past it the goal is dropped automatically. */
    expires: TimestampSchema,
    /** Who it is about (a handle), when someone. */
    person: z.string().nullable(),
    /** Where it should happen, when somewhere specific. */
    context: ContextKeySchema.nullable(),
    source: z.enum(["plan", "plan_daily", "reflect", "panel"]),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    /** When it was done or dropped. */
    closed_at: TimestampSchema.nullable(),
    /** Why it was dropped (expired, she changed her mind, a step failed). */
    close_reason: z.string().nullable(),
  })
  .meta({ id: "ApiGoal" });
export type Goal = z.output<typeof GoalSchema>;

/** `GET /api/mind/goals`. */
export const GoalsViewSchema = z
  .object({
    /** Pending and active goals, soonest trigger first, then (with `closed=true`) closed ones. */
    goals: z.array(GoalSchema),
    /** The closed goals were asked for and the agenda can list them. */
    closed_included: z.boolean(),
  })
  .meta({ id: "ApiGoalsView" });
export type GoalsView = z.output<typeof GoalsViewSchema>;

/** `GET /api/mind/plan`: today's plan in her words (`null`: not written yet). */
export const DayPlanViewSchema = z
  .object({ day_plan: z.string().nullable() })
  .meta({ id: "ApiDayPlanView" });
export type DayPlanView = z.output<typeof DayPlanViewSchema>;

/** Joins the `mind` group. */
export const mindPlan = {
  /** `closed=true` adds the goals that are done or dropped, when the agenda keeps them. */
  goals: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/mind/goals" })
    .input(z.object({ query: z.object({ closed: FlagQuery.optional() }) }))
    .output(GoalsViewSchema),
  plan: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/mind/plan" })
    .output(DayPlanViewSchema),
};
