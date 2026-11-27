// `schedule(when, note, where?)` and its two helpers, `schedule_list` and `schedule_cancel`: she
// sets her own later wake-up (docs/design/v5-architecture.md §7.3). Only the new runner offers
// them (`next`); `schedule` is always offered (core), the other two are found with `find_tools`.

import { WORK_DELEGATE } from "@miyoria/gate/actions";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "@miyoria/llm/tools";
import {
  type AccountRef,
  type ContextKey,
  contextKeyString,
  isJsonObject,
  type JsonValue,
  sameAccount,
} from "@miyoria/types";
import { z } from "zod";
import { SCHEDULE_JOB_KINDS } from "./initiative-schema.js";
import type { ScheduleRow } from "./initiative-store.js";
import { SCHEDULE_CANCEL_TOOL, SCHEDULE_LIST_TOOL, SCHEDULE_TOOL } from "./initiative-texts.js";
import { type ScheduleBook, ScheduleError, scheduleKey, scheduleLine } from "./schedule.js";

export const SCHEDULE = "schedule";
export const SCHEDULE_LIST = "schedule_list";
export const SCHEDULE_CANCEL = "schedule_cancel";

export interface ScheduleToolDeps {
  book: ScheduleBook;
  /** The place she named, from where she is; `null`: she knows no such place. */
  resolve(place: string, from: ContextKey): Promise<ContextKey | null>;
  /** A place's name as she would know it, when the platform has one. */
  describe(place: ContextKey): Promise<string | null>;
  /**
   * The Space of a place (identity's id; `null`: none). `schedule_list` in one server shows only
   * that server's schedules and those of no server (docs/design/v5-places.md). Unset: all.
   */
  spaceOf?(place: ContextKey | null): string | null;
}

/** Told after the tool's own description: a schedule may start a job instead of only waking her. */
const JOB_TEXTS = {
  description:
    "也可以帶 job:時間到時不只是叫醒你,而是直接替開口要的人開一份小幫手的工作" +
    "(kind 是 worker 或 research,goal 寫清楚要做什麼),算在那個人的額度和資料夾裡。" +
    "要定時整理檔案、查資料、做報告這類事才用;只是想起一件事不用 job。",
  job: "時間到時要開的工作(可省略)",
  kind: "worker(動手做,要用到檔案和程式)或 research(只查資料)",
  goal: "這份工作要做什麼,寫清楚、一次講完",
  budget: "最多花幾美元(通常省略)",
  noGoal: "job 要有 goal(要做什麼)。",
  longGoal: (max: number) => `job 的 goal 太長了,最多 ${max} 個字。`,
  set: (key: string, at: string, daily: boolean) =>
    `設好了(${key}),還沒到時間:${daily ? `每天 ${at}` : at}會替他開這份工作。`,
} as const;

/** The longest brief a scheduled job carries (the helper's own limit is the same). */
const MAX_JOB_GOAL = 600;

const JobParams = z.object({
  kind: z.enum(SCHEDULE_JOB_KINDS).describe(JOB_TEXTS.kind),
  goal: z.string().describe(JOB_TEXTS.goal),
  budget: z.number().positive().optional().describe(JOB_TEXTS.budget),
});

const SetParams = z.object({
  when: z.string().describe(SCHEDULE_TOOL.when),
  note: z.string().describe(SCHEDULE_TOOL.note),
  where: z.string().optional().describe(SCHEDULE_TOOL.where),
  job: JobParams.optional().describe(JOB_TEXTS.job),
});

/**
 * The node a `schedule` call needs: a scheduled `worker` does real work for the asker later, so
 * it takes the same node `delegate` does (the bond check at the time it is set); anything else
 * needs none.
 */
export function scheduleNode(args: JsonValue): string | null {
  const job = isJsonObject(args) ? args.job : null;
  const kind = isJsonObject(job) && typeof job.kind === "string" ? job.kind : "";
  return kind.trim().toLowerCase() === "worker" ? WORK_DELEGATE : null;
}

const CancelParams = z.object({
  id: z.string().describe(SCHEDULE_CANCEL_TOOL.id),
});

const failed = (text: string): ToolResult => ({ ok: false, code: "failed", stage: null, text });

/**
 * Whether someone asking (`asker`) may see or cancel `row`: only what they asked for; her own
 * calls with nobody behind them, all of them.
 */
function theirs(row: ScheduleRow, asker: AccountRef | null): boolean {
  return asker === null || (row.for_account !== null && sameAccount(row.for_account, asker));
}

/** A tool whose `result` is the call; `call` throws its refusal, as `ToolRegistry` expects. */
function withResult(
  tool: Tool,
  run: (ctx: ToolContext, raw: JsonValue) => Promise<ToolResult>,
): Tool {
  return { ...tool, result: run };
}

export function scheduleTools(deps: ScheduleToolDeps): Tool[] {
  const { book } = deps;

  const set = async (ctx: ToolContext, raw: JsonValue): Promise<ToolResult> => {
    const args = SetParams.safeParse(raw);
    if (!args.success || args.data.when.trim() === "" || args.data.note.trim() === "") {
      return failed(SCHEDULE_TOOL.empty);
    }
    const when = book.when(args.data.when);
    if (when === null) return failed(SCHEDULE_TOOL.unreadable(args.data.when));
    let place: ContextKey | null = ctx.context;
    const where = args.data.where?.trim() ?? "";
    if (where !== "") {
      place = await deps.resolve(where, ctx.context);
      if (place === null) return failed(SCHEDULE_TOOL.unknownPlace(where));
      if (place.kind === "dm" && contextKeyString(place) !== contextKeyString(ctx.context)) {
        return failed(SCHEDULE_TOOL.dmPlace);
      }
    }
    const job = args.data.job;
    if (job !== undefined) {
      const goal = job.goal.trim();
      if (goal === "") return failed(JOB_TEXTS.noGoal);
      if ([...goal].length > MAX_JOB_GOAL) return failed(JOB_TEXTS.longGoal(MAX_JOB_GOAL));
    }
    try {
      // Whoever asked is kept with it: when it comes, the run acts for them, not as her own.
      const row = book.set({
        when,
        note: args.data.note,
        context: place,
        asker: ctx.principal.requester,
        ...(job === undefined
          ? {}
          : { job: { kind: job.kind, goal: job.goal.trim(), budget: job.budget ?? null } }),
      });
      const at = when.daily ?? args.data.when.trim();
      return {
        ok: true,
        text: (job === undefined ? SCHEDULE_TOOL.set : JOB_TEXTS.set)(
          scheduleKey(row),
          at,
          when.daily !== null,
        ),
      };
    } catch (error) {
      if (error instanceof ScheduleError) return failed(error.message);
      throw error;
    }
  };

  const list = async (ctx: ToolContext): Promise<ToolResult> => {
    const space = deps.spaceOf?.(ctx.context) ?? null;
    const asker = ctx.principal.requester;
    const rows = book
      .open()
      .filter((r) => deps.spaceOf === undefined || r.space_id === null || r.space_id === space)
      .filter((r) => theirs(r, asker));
    if (rows.length === 0) return { ok: true, text: SCHEDULE_LIST_TOOL.none };
    const here = contextKeyString(ctx.context);
    const lines: string[] = [];
    for (const row of rows) {
      const where =
        row.context === null
          ? SCHEDULE_LIST_TOOL.home
          : contextKeyString(row.context) === here
            ? SCHEDULE_LIST_TOOL.here
            : ((await deps.describe(row.context)) ?? row.context.channel);
      lines.push(scheduleLine(row, book.offsetMinutes, where));
    }
    return { ok: true, text: lines.join("\n") };
  };

  const cancel = async (ctx: ToolContext, raw: JsonValue): Promise<ToolResult> => {
    const args = CancelParams.safeParse(raw);
    if (!args.success) return failed(SCHEDULE_CANCEL_TOOL.notFound);
    const found = book.find(args.data.id);
    if (found === null || !theirs(found, ctx.principal.requester)) {
      return failed(SCHEDULE_CANCEL_TOOL.notFound);
    }
    const row = book.cancel(found.id);
    if (row === null) return failed(SCHEDULE_CANCEL_TOOL.notFound);
    return { ok: true, text: SCHEDULE_CANCEL_TOOL.cancelled(scheduleKey(row), row.note) };
  };

  const call =
    (run: (ctx: ToolContext, raw: JsonValue) => Promise<ToolResult>) =>
    async (ctx: ToolContext, raw: JsonValue): Promise<string> => {
      const result = await run(ctx, raw);
      if (!result.ok) throw new Error(result.text);
      return result.text;
    };

  return [
    withResult(
      defineTool({
        name: SCHEDULE,
        description: `${SCHEDULE_TOOL.description}${JOB_TEXTS.description}`,
        parameters: SetParams,
        effect: "act",
        speed: "instant",
        risk: "low",
        group: "schedule",
        core: true,
        next: true,
        permissionFor: scheduleNode,
        call: call(set),
      }),
      set,
    ),
    withResult(
      defineTool({
        name: SCHEDULE_LIST,
        description: SCHEDULE_LIST_TOOL.description,
        parameters: z.object({}),
        effect: "read",
        speed: "instant",
        risk: "low",
        group: "schedule",
        next: true,
        readOnly: true,
        call: call(list),
      }),
      list,
    ),
    withResult(
      defineTool({
        name: SCHEDULE_CANCEL,
        description: SCHEDULE_CANCEL_TOOL.description,
        parameters: CancelParams,
        effect: "act",
        speed: "instant",
        risk: "low",
        group: "schedule",
        next: true,
        call: call(cancel),
      }),
      cancel,
    ),
  ];
}
