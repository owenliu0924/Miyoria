// Prompt section 「進行中的工作」: the helpers' jobs that are running or waiting, so she knows what
// she handed out, for whom, how far each is and what it did last. Only the jobs asked for in the
// place she answers, by the people the run answers (or by nobody: hers), are shown in full; the
// others are a count, so a job asked for in a DM never shows its goal in a public channel, and one
// person's goal and plan are never put in front of another in the same channel. The goals are hers
// and the plans the helpers': the agent puts the section in a data block.

import {
  type AccountRef,
  type ContextKey,
  contextKeyEquals,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  sameAccount,
} from "@miyoria/types";
import type { Delegator, JobRow } from "./delegate.js";
import {
  ELSEWHERE,
  JOBS_FOOT,
  JOBS_TITLE,
  jobLine,
  LATEST_STEP,
  MORE_HERE,
  NO_PLAN,
  OTHERS_HERE,
  PLAN_HEAD,
} from "./delegate-texts.js";
import { planCount, planLines } from "./plan.js";

export const JOBS_PROMPT_KEY = "delegate_jobs";
/** Jobs shown in full, at most. */
const MAX_JOBS = 6;
/** After the set list (46) and around what she is doing. */
const ORDER = 47;

const going = (job: JobRow): boolean =>
  job.kind !== "reflect" && (job.state === "running" || job.state === "queued");

/**
 * The section's body for a run at `context` answering `speakers`; `null` when nothing is going
 * on. In full: the jobs asked for here by one of `speakers`, and her own; the rest are counts.
 */
export function jobsBody(
  delegator: Delegator,
  context: ContextKey,
  speakers: readonly AccountRef[] = [],
): string | null {
  const live = delegator.jobs().filter(going);
  if (live.length === 0) return null;
  const inPlace = live.filter((j) => j.context !== null && contextKeyEquals(j.context, context));
  const theirs = ({ from }: JobRow) =>
    from === null || speakers.some((s) => sameAccount(s, from.account));
  const here = inPlace.filter(theirs);
  const lines: string[] = [];
  for (const job of here.slice(0, MAX_JOBS)) {
    lines.push(
      jobLine({
        id: job.id,
        kind: job.kind,
        state: job.state === "queued" ? "queued" : "running",
        minutes: Math.floor(delegator.elapsedMs(job) / 60_000),
        asker: job.from?.name ?? null,
        goal: job.goal,
      }),
    );
    if (job.plan.length === 0) {
      if (job.state === "running") lines.push(NO_PLAN);
    } else {
      lines.push(`  ${PLAN_HEAD(planCount(job.plan))}`, ...planLines(job.plan, "  "));
    }
    if (job.last_step !== null) lines.push(LATEST_STEP(job.last_step));
  }
  if (here.length > MAX_JOBS) lines.push(MORE_HERE(here.length - MAX_JOBS));
  const others = inPlace.length - here.length;
  if (others > 0) lines.push(OTHERS_HERE(others));
  const elsewhere = live.length - inPlace.length;
  if (elsewhere > 0) lines.push(ELSEWHERE(elsewhere));
  if (here.length > 0) lines.push(JOBS_FOOT);
  return lines.join("\n");
}

export class JobsPrompt implements PromptContributor {
  readonly key = JOBS_PROMPT_KEY;

  constructor(private readonly delegator: Delegator) {}

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    const body = jobsBody(this.delegator, request.context, request.speakers);
    return body === null ? [] : [{ key: JOBS_PROMPT_KEY, title: JOBS_TITLE, body, order: ORDER }];
  }
}
