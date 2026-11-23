// A helper's plan: one short list of steps, each pending, in progress or done. The helper sets
// the whole list with `plan` (never one step at a time, so the list it sees is the list that is
// kept); the job keeps it, she sees it in 「進行中的工作」 and in `delegate_list` / `delegate_read`.

import { defineTool, type Tool } from "@miyoria/llm/tools";
import { neutralize } from "@miyoria/types";
import { z } from "zod";
import { PLAN_TEXTS } from "./delegate-texts.js";

export const PLAN_TOOL = "plan";

export type StepState = "pending" | "in_progress" | "done";
export const STEP_STATES: readonly StepState[] = ["pending", "in_progress", "done"];

export interface PlanStep {
  text: string;
  state: StepState;
}

/** Steps of a plan, at most. */
export const MAX_PLAN_STEPS = 12;
/** Characters of a step, at most. */
export const MAX_STEP_CHARS = 80;

const Args = z.object({
  steps: z
    .array(
      z.object({
        text: z.string().describe(PLAN_TEXTS.stepText),
        state: z.enum(STEP_STATES as [StepState, ...StepState[]]).describe(PLAN_TEXTS.stepState),
      }),
    )
    .describe(PLAN_TEXTS.steps),
});

/** The steps `raw` names, or why they are not a plan. */
export function parsePlan(
  raw: unknown,
): { ok: true; steps: PlanStep[] } | { ok: false; why: string } {
  const args = Args.safeParse(raw);
  if (!args.success) return { ok: false, why: PLAN_TEXTS.bad };
  const steps = args.data.steps.map((s) => ({
    text: neutralize(s.text).replace(/\s+/g, " ").trim(),
    state: s.state,
  }));
  if (steps.length === 0) return { ok: false, why: PLAN_TEXTS.empty };
  if (steps.length > MAX_PLAN_STEPS) return { ok: false, why: PLAN_TEXTS.tooMany(MAX_PLAN_STEPS) };
  if (steps.some((s) => s.text === "")) return { ok: false, why: PLAN_TEXTS.blank };
  if (steps.some((s) => [...s.text].length > MAX_STEP_CHARS)) {
    return { ok: false, why: PLAN_TEXTS.tooLong(MAX_STEP_CHARS) };
  }
  return { ok: true, steps };
}

/** A plan kept on a job, as read back (a row from before plans has none). */
export function planOf(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s): PlanStep[] => {
    if (typeof s !== "object" || s === null) return [];
    const { text, state } = s as Record<string, unknown>;
    if (typeof text !== "string" || !STEP_STATES.includes(state as StepState)) return [];
    return [{ text, state: state as StepState }];
  });
}

/** The plan, one line a step: `1. [進行中] …`. */
export function planLines(plan: readonly PlanStep[], indent = ""): string[] {
  return plan.map((s, i) => `${indent}${i + 1}. [${PLAN_TEXTS.state[s.state]}] ${s.text}`);
}

/** `2/5`: steps done of all. */
export function planCount(plan: readonly PlanStep[]): string {
  return `${plan.filter((s) => s.state === "done").length}/${plan.length}`;
}

/** The step in progress, else the first not done; `null` when every step is done or none. */
export function currentStep(plan: readonly PlanStep[]): PlanStep | null {
  return (
    plan.find((s) => s.state === "in_progress") ?? plan.find((s) => s.state !== "done") ?? null
  );
}

/** `plan` for one job: `set` keeps the whole list on the job. */
export function planTool(set: (steps: PlanStep[]) => void): Tool {
  return defineTool({
    name: PLAN_TOOL,
    description: PLAN_TEXTS.description,
    parameters: Args,
    effect: "act",
    speed: "instant",
    risk: "low",
    group: "work",
    core: true,
    next: true,
    async call(_ctx, raw) {
      const out = parsePlan(raw);
      if (!out.ok) throw new Error(out.why);
      set(out.steps);
      return `${PLAN_TEXTS.saved(planCount(out.steps))}\n${planLines(out.steps).join("\n")}`;
    },
  });
}
