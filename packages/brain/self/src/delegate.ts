// The sub-agent jobs: what `delegate` starts, what runs them, what they cost and how they end.
//
// Each job is one run of `SelfRunner` on the `subagent` profile, with a transcript session of its
// own (`delegate:<id>`: it can be read afterwards and is never mixed with a conversation), the
// tools of its kind (`subagents.ts`), the real guard behind the helper's own, and no outlet. At
// most `maxRunning` run at once and `maxQueued` wait; a start past that is refused with a text she
// can read.
//
// Money. Every call a job makes is charged in USD (a model with no price at the quota's fallback
// rate) to the job's own budget (the size of the task, hers to pick within the kind's maximum), to
// the person who asked (their AI quota: a job acts for them; none when she started it herself),
// and to the job's row. A person at their quota cannot start a job; a running job that takes them
// past it stops at its next step and writes what it has. The router's daily budget holds over all.
//
// Rows. A job's row (who asked, where, state, usage, plan, summary) is kept in a `JobStore` while
// it lives and after it ends, and saved after every step.
//
// Restarts. A job that was running when the process stopped goes on from its transcript on the
// next start, with what is left of its rounds, time (the time it ran before counts, the gap does
// not) and budget; one whose allowance is used up only writes what it has. A queued one starts as
// if new. A job that a restart cut twice after resuming, or whose resumed run failed twice, ends as
// failed with the reason.

import { withLlmTag } from "@miyoria/llm/llm";
import type { TranscriptStore } from "@miyoria/memory/transcript";
import { errorMessage, type Logger } from "@miyoria/runtime/kernel";
import { type AccountRef, type Clock, type ContextKey, dataBlock, newId } from "@miyoria/types";
import { roughWait } from "../../agent/src/index.js";
import {
  DELEGATE_BLOCK,
  DELEGATE_REFUSALS,
  listLine,
  NO_RESULT_NOTE,
  PLAN_HEAD,
  RESTART_NOTE,
  RESUME_AUTHOR,
  RESUME_FAILED_NOTE,
  RESUME_SPENT_NOTE,
  receipt,
  resultText,
  resumeNote,
  SHUTDOWN_NOTE,
  spentText,
  WAKE_TOOL,
} from "./delegate-texts.js";
import { composeGuards } from "./guard.js";
import {
  currentStep,
  PLAN_TOOL,
  type PlanStep,
  planCount,
  planLines,
  planOf,
  planTool,
} from "./plan.js";
import type { LimitName } from "./profiles.js";
import { capMinutes, chargeOf, type Payer, type PersonQuota, QUOTA_DEFAULTS } from "./quota.js";
import { SelfRunner } from "./run.js";
import {
  type CallableKind,
  defaultKindLimits,
  fixedTools,
  goalLine,
  helperGuard,
  helperPrompt,
  helperSystem,
  isolatedTranscript,
  isSubagentKind,
  type JobRegistry,
  jobBudget,
  jobTools,
  KINDS,
  type KindLimits,
  noMouth,
  profileOf,
  type RunAllowance,
  type SubagentKind,
} from "./subagents.js";
import type { Guard, PromptInput, RunEvent, RunModel, Wake, WakeAuthor } from "./types.js";

/** Characters of a goal. */
export const MAX_GOAL_CHARS = 600;

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled" | "out_of_budget";

export const ENDED_STATES: readonly JobState[] = ["done", "failed", "cancelled", "out_of_budget"];

export function isEnded(state: JobState): boolean {
  return ENDED_STATES.includes(state);
}

export interface JobUsage {
  /** Model calls made. */
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  reasoning_tokens: number;
  /** What the calls of a priced model cost. */
  cost_usd: number;
  /** Tokens of calls whose model has no price (they are counted in tokens). */
  unpriced_tokens: number;
}

export function noUsage(): JobUsage {
  return {
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_prompt_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    unpriced_tokens: 0,
  };
}

/** A job as it is kept (JSON: it is written to the settings store as it is). */
export interface JobRow {
  /** What she sees and gives to the tools (a short id). */
  id: string;
  kind: SubagentKind;
  goal: string;
  /** Where it was asked: the result is told there. `null`: nowhere (the nightly run). */
  context: ContextKey | null;
  /** Who asked, when someone did: the job acts for them. */
  from: WakeAuthor | null;
  state: JobState;
  /** What this job may spend (USD). */
  budget_usd: number;
  /** Model steps taken. */
  rounds: number;
  usage: JobUsage;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  /** What it wrote at the end: whole. `null`: nothing (yet). */
  summary: string | null;
  /** Why it ended the way it did, when that is more than the state says. */
  note: string | null;
  /** Its transcript session. */
  session: string;
  /** Whether the place that asked is told when it ends. */
  told: boolean;
  /** Its steps as the helper last set them (`plan`); empty: none yet. */
  plan: PlanStep[];
  /** What it did last (a call, a plan step), for her progress section. */
  last_step: string | null;
  /** Wall time it ran, every run of it together (ms): a restart's gap is not counted. */
  ran_ms: number;
  /** Times it went on after a restart or a failed run. */
  resumes: number;
}

/** A row as kept by an older version (no plan, no resumes) made whole. */
export function normaliseRow(row: JobRow): JobRow {
  const r = row as Partial<JobRow> & JobRow;
  row.plan = planOf(r.plan);
  row.last_step = typeof r.last_step === "string" ? r.last_step : null;
  row.ran_ms = typeof r.ran_ms === "number" && r.ran_ms >= 0 ? r.ran_ms : 0;
  row.resumes = typeof r.resumes === "number" && r.resumes >= 0 ? r.resumes : 0;
  return row;
}

/** A job goes on after a restart at most this many times. */
export const MAX_RESUMES = 2;

/** What the nightly reflection's pool has taken in. */
export interface DayState {
  date: string;
  /** USD, the calls without a price at the fallback rate. */
  usd: number;
  /** Tokens of every call, priced or not. */
  tokens: number;
  /** Tokens of the calls that had no price. */
  unpriced_tokens: number;
}

export type DelegateEvent =
  | { type: "started"; job: JobRow }
  | { type: "progress"; job: JobRow; detail: string }
  | { type: "ended"; job: JobRow };

/** Where jobs and the reflection's day are kept. Writes are fire-and-forget; the store orders them. */
export interface JobStore {
  load(): Promise<{ jobs: JobRow[]; reflectDay: DayState | null }>;
  saveJob(row: JobRow): void;
  removeJob(id: string): void;
  saveDay(pool: "reflect", day: DayState): void;
}

/** A store that keeps nothing past the process (tests, and a run without a settings store). */
export class MemoryJobStore implements JobStore {
  readonly jobs = new Map<string, JobRow>();
  readonly days = new Map<string, DayState>();

  async load() {
    return {
      jobs: [...this.jobs.values()].map((j) => structuredClone(j)),
      reflectDay: this.days.get("reflect") ?? null,
    };
  }

  saveJob(row: JobRow): void {
    this.jobs.set(row.id, structuredClone(row));
  }

  removeJob(id: string): void {
    this.jobs.delete(id);
  }

  saveDay(pool: "reflect", day: DayState): void {
    this.days.set(pool, { ...day });
  }
}

// ---- the money ---------------------------------------------------------------------------------

/** What the nightly reflection may spend in a day (USD). */
export class DayPool {
  #state: DayState = { date: "", usd: 0, tokens: 0, unpriced_tokens: 0 };

  constructor(
    readonly cap: { usd: number },
    readonly dayKey: (now: number) => string,
  ) {}

  #roll(now: number): void {
    const date = this.dayKey(now);
    if (this.#state.date !== date) this.#state = { date, usd: 0, tokens: 0, unpriced_tokens: 0 };
  }

  /** `usd`: what the call was charged; `priced`: whether its model had a price. */
  add(now: number, usd: number, tokens: number, priced: boolean): void {
    this.#roll(now);
    this.#state.tokens += tokens;
    if (!priced) this.#state.unpriced_tokens += tokens;
    this.#state.usd += usd;
  }

  over(now: number): boolean {
    this.#roll(now);
    return this.#state.usd >= this.cap.usd;
  }

  state(now: number): DayState {
    this.#roll(now);
    return { ...this.#state };
  }

  /** What the last run of the process left, when it is of today. */
  restore(day: DayState | null, now: number): void {
    this.#roll(now);
    if (day === null || day.date !== this.#state.date) return;
    this.#state = {
      date: day.date,
      usd: Math.max(this.#state.usd, day.usd),
      tokens: Math.max(this.#state.tokens, day.tokens),
      unpriced_tokens: Math.max(this.#state.unpriced_tokens, day.unpriced_tokens),
    };
  }
}

// ---- the engine --------------------------------------------------------------------------------

export interface DelegateLimits {
  maxRunning: number;
  maxQueued: number;
  /** What the nightly reflection may spend in a day (USD). */
  reflectDailyUsd: number;
  /** Characters of a summary the place that asked is told. */
  resultChars: number;
  /** Characters one `read` gives. */
  readChars: number;
  keepEnded: number;
  /** What one job of each kind may use (`[modules.agent.delegate.kinds.<kind>]`). */
  kinds: Record<CallableKind, KindLimits>;
}

export const DEFAULT_DELEGATE_LIMITS: DelegateLimits = {
  maxRunning: 3,
  maxQueued: 8,
  reflectDailyUsd: 0.5,
  resultChars: 1500,
  readChars: 8000,
  keepEnded: 20,
  kinds: defaultKindLimits(),
};

/** What `DelegatorPorts.limits` may set: any limit, and any field of a kind's. */
export type DelegateLimitsInput = Partial<Omit<DelegateLimits, "kinds">> & {
  kinds?: Partial<Record<CallableKind, Partial<KindLimits>>>;
};

/** `input` over the defaults, each kind's fields over that kind's. */
export function delegateLimits(input: DelegateLimitsInput = {}): DelegateLimits {
  const { kinds, ...rest } = input;
  const base = defaultKindLimits();
  const merged = { ...DEFAULT_DELEGATE_LIMITS, ...rest, kinds: base };
  for (const kind of Object.keys(base) as CallableKind[]) {
    merged.kinds[kind] = { ...base[kind], ...kinds?.[kind] };
  }
  return merged;
}

export interface DelegatorPorts {
  /** The real transcripts (jobs write through an isolated view of it). */
  transcript: TranscriptStore;
  /** The registry; a job sees only its kind's tools of it. */
  tools: JobRegistry;
  model: RunModel;
  /** The real guard, asked after the helper's own. */
  guard: Guard;
  clock: Clock;
  log: Logger;
  store: JobStore;
  limits?: DelegateLimitsInput;
  /** The key of a day (the reflection's pool resets when it changes). Default: the UTC date. */
  dayKey?: (now: number) => string;
  /** Each person's AI quota: whoever asked for a job pays for it. Unset: nobody is capped. */
  quota?: PersonQuota | null;
  /** The person behind whoever asked (`Payer`); `null`: nobody to charge. Unset: nobody. */
  payerOf?: (from: WakeAuthor) => Payer | null;
  /** USD per million tokens of a model without a price; default the quota's rate. */
  unpricedUsdPerMtok?: () => number;
  /** The owner's rules as the helper's block 3 (they bind it as they bind her); `null`: none. */
  rules?: (context: ContextKey) => Promise<string | null> | string | null;
  /** The owner's rule that forbids the goal, if one does. */
  forbids?: (goal: string, context: ContextKey) => string | null;
  /** The router's budget is used up: nothing new starts. */
  llmExhausted?: () => boolean;
  /** Where a finished job is told (the place that asked): the host wakes her. */
  ended?: (job: JobRow) => void;
  onEvent?: (event: DelegateEvent) => void;
  selfAccount?: (platform: string) => AccountRef;
  newId?: () => string;
}

export interface StartSpec {
  /** What she wrote; checked here. */
  kind: string;
  goal: string;
  /** USD she asked for; unset: the kind's default. */
  budget?: number | null;
  context: ContextKey;
  from: WakeAuthor | null;
}

export type StartOutcome =
  | { ok: true; job: JobRow; state: "running" | "queued"; ahead: number; text: string }
  | { ok: false; code: string; text: string };

/** A job that is queued or running. */
interface Live {
  row: JobRow;
  tools: string[];
  controller: AbortController;
  /** Set when someone cancelled it: who. */
  cancelBy: "her" | null;
  /** It goes on from its transcript (it ran before a restart or a failed run). */
  resume: boolean;
  /** When this process began running it, and what `row.ran_ms` was then. */
  since: number;
  ranBefore: number;
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

const LIMIT_NOTES: Record<Exclude<LimitName, "spend">, string> = {
  rounds: "到了輪數上限,這是做到那裡的結果",
  time: "到了時間上限,這是做到那裡的結果",
  tokens: "到了這件工作能用的量,這是做到那裡的結果",
};

/** A job a restart found with its allowance used up: what it wrote at once. */
const SPENT_BEFORE_NOTE = "重啟前就用完了能用的輪數、時間或預算,這是做到那裡的結果";

export class Delegator {
  readonly #p: DelegatorPorts;
  readonly #limits: DelegateLimits;
  readonly #reflectPool: DayPool;
  readonly #isolated: TranscriptStore;
  readonly #live = new Map<string, Live>();
  readonly #queue: Live[] = [];
  /** Ended jobs, newest first. */
  #ended: JobRow[] = [];
  readonly #tasks = new Set<Promise<void>>();
  readonly #newId: () => string;
  #closed = false;

  constructor(ports: DelegatorPorts) {
    this.#p = ports;
    this.#limits = delegateLimits(ports.limits);
    const dayKey = ports.dayKey ?? utcDay;
    this.#reflectPool = new DayPool({ usd: this.#limits.reflectDailyUsd }, dayKey);
    this.#isolated = isolatedTranscript(ports.transcript);
    this.#newId = ports.newId ?? (() => newId().slice(-8).toLowerCase());
  }

  get limits(): DelegateLimits {
    return this.#limits;
  }

  /** What today's reflection has spent so far. */
  reflectSpentToday(): DayState {
    return this.#reflectPool.state(this.#p.clock.now());
  }

  #now(): number {
    return this.#p.clock.now();
  }

  /** USD per million tokens of a model without a price. */
  #rate(): number {
    return (
      this.#p.unpricedUsdPerMtok?.() ??
      this.#p.quota?.rules().unpricedUsdPerMtok ??
      QUOTA_DEFAULTS.unpricedUsdPerMtok
    );
  }

  /** Whom a job's calls are charged to: whoever asked; `null`: she started it herself. */
  payerOf(row: Pick<JobRow, "from">): Payer | null {
    return row.from === null ? null : (this.#p.payerOf?.(row.from) ?? null);
  }

  /** What a job was charged so far (USD, unpriced tokens at the fallback rate). */
  charged(row: JobRow): number {
    return (
      row.usage.cost_usd +
      chargeOf(
        null,
        { prompt_tokens: row.usage.unpriced_tokens, completion_tokens: 0 },
        this.#rate(),
      )
    );
  }

  #emit(event: DelegateEvent): void {
    try {
      this.#p.onEvent?.(event);
    } catch (error) {
      this.#p.log.warn({ err: errorMessage(error) }, "a delegate event listener failed");
    }
  }

  #running(): number {
    let n = 0;
    for (const j of this.#live.values()) if (j.row.state === "running") n += 1;
    return n;
  }

  /** The limits of one job of `kind` (the reflection's are its profile's). */
  kindLimits(kind: SubagentKind): KindLimits {
    return kind === "reflect" ? KINDS.reflect.limits : this.#limits.kinds[kind];
  }

  /** How long a job has run (ms), this run included; a restart's gap is not counted. */
  elapsedMs(row: JobRow): number {
    const live = this.#live.get(row.id);
    if (live === undefined || row.state !== "running") return row.ran_ms;
    return live.ranBefore + Math.max(0, this.#now() - live.since);
  }

  #save(live: Live): void {
    live.row.ran_ms = this.elapsedMs(live.row);
    this.#p.store.saveJob(live.row);
  }

  // ---- starting ---------------------------------------------------------------------------------

  start(spec: StartSpec): StartOutcome {
    const no = (code: string, text: string): StartOutcome => ({ ok: false, code, text });
    if (this.#closed) return no("closed", DELEGATE_REFUSALS.closed);
    const kind = spec.kind.trim().toLowerCase();
    if (kind === "reflect") return no("reflect", DELEGATE_REFUSALS.reflect);
    if (!isSubagentKind(kind) || !KINDS[kind].callable) {
      return no("kind", DELEGATE_REFUSALS.unknownKind(spec.kind));
    }
    const goal = spec.goal.trim();
    if (goal === "") return no("goal", DELEGATE_REFUSALS.emptyGoal);
    if ([...goal].length > MAX_GOAL_CHARS) {
      return no("goal", DELEGATE_REFUSALS.longGoal(MAX_GOAL_CHARS));
    }
    const rule = this.#p.forbids?.(goal, spec.context) ?? null;
    if (rule !== null) return no("directive", DELEGATE_REFUSALS.directive(rule));
    const capped = this.#p.quota?.capped(this.payerOf(spec), this.#now()) ?? null;
    if (capped !== null) {
      const wait = roughWait(capMinutes(capped, this.#now()));
      return no("quota", DELEGATE_REFUSALS.quota(spec.from?.name ?? "", capped.which, wait));
    }
    if (this.#p.llmExhausted?.() === true) return no("llm_budget", DELEGATE_REFUSALS.llmBudget);
    const tools = jobTools(kind, (name) => this.#p.tools.entry(name));
    if (tools.length === 0) return no("tools", DELEGATE_REFUSALS.noTools(kind));
    const running = this.#running();
    if (running >= this.#limits.maxRunning && this.#queue.length >= this.#limits.maxQueued) {
      return no("full", DELEGATE_REFUSALS.full(running, this.#queue.length));
    }
    let id = this.#newId();
    while (this.#live.has(id) || this.#ended.some((j) => j.id === id)) id = this.#newId();
    const row: JobRow = {
      id,
      kind,
      goal,
      context: spec.context,
      from: spec.from,
      state: "queued",
      budget_usd: jobBudget(this.kindLimits(kind), spec.budget),
      rounds: 0,
      usage: noUsage(),
      created_at: this.#now(),
      started_at: null,
      ended_at: null,
      summary: null,
      note: null,
      session: `delegate:${id}`,
      told: true,
      plan: [],
      last_step: null,
      ran_ms: 0,
      resumes: 0,
    };
    const live = this.#liveOf(row, tools, false);
    this.#live.set(id, live);
    this.#p.store.saveJob(row);
    if (running < this.#limits.maxRunning) {
      this.#begin(live);
      return { ok: true, job: row, state: "running", ahead: 0, text: receipt(kind, id, 0) };
    }
    this.#queue.push(live);
    const ahead = this.#queue.length;
    return { ok: true, job: row, state: "queued", ahead, text: receipt(kind, id, ahead) };
  }

  #liveOf(row: JobRow, tools: string[], resume: boolean): Live {
    return {
      row,
      tools,
      controller: new AbortController(),
      cancelBy: null,
      resume,
      since: this.#now(),
      ranBefore: row.ran_ms,
    };
  }

  #pump(): void {
    while (!this.#closed && this.#queue.length > 0 && this.#running() < this.#limits.maxRunning) {
      const next = this.#queue.shift();
      if (next !== undefined) this.#begin(next);
    }
  }

  #begin(live: Live): void {
    const row = live.row;
    row.state = "running";
    row.started_at ??= this.#now();
    live.since = this.#now();
    live.ranBefore = row.ran_ms;
    this.#p.store.saveJob(row);
    this.#emit({ type: "started", job: row });
    // Never inside the call that started it: whoever started it learns its id first.
    const task = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    })
      .then(() => this.#run(live))
      .catch((error: unknown) => {
        this.#p.log.warn({ job: row.id, err: errorMessage(error) }, "a sub-agent job failed");
      })
      .finally(() => {
        this.#tasks.delete(task);
      });
    this.#tasks.add(task);
  }

  // ---- running ----------------------------------------------------------------------------------

  /**
   * What the next run of a job may use: its kind's whole at the start; after a restart or a
   * failed run, what is left of it (`reportOnly` when nothing is: it only writes what it has).
   */
  allowance(row: JobRow, resume: boolean): RunAllowance {
    const k = this.kindLimits(row.kind);
    if (!resume) {
      return {
        rounds: k.rounds,
        wallMs: k.wallMs,
        toolMs: k.toolMs,
        tokens: k.tokens,
        usd: row.budget_usd,
      };
    }
    const used = row.usage.prompt_tokens + row.usage.completion_tokens;
    const left = {
      rounds: k.rounds - row.rounds,
      wallMs: k.wallMs - row.ran_ms,
      tokens: k.tokens - used,
      usd: row.budget_usd - this.charged(row),
    };
    const spent = left.rounds <= 0 || left.wallMs <= 0 || left.tokens <= 0 || left.usd <= 0;
    if (spent) {
      // One step without tools; the asker's quota and the daily budget still hold it.
      return {
        rounds: 1,
        wallMs: 2 * 60_000,
        toolMs: k.toolMs,
        tokens: Math.max(k.tokens, 1),
        usd: 0,
        reportOnly: true,
      };
    }
    return {
      rounds: left.rounds,
      wallMs: left.wallMs,
      toolMs: k.toolMs,
      tokens: left.tokens,
      usd: left.usd,
    };
  }

  /** Sets a job's plan (its `plan` tool). */
  #setPlan(live: Live, steps: PlanStep[]): void {
    const row = live.row;
    row.plan = steps;
    const now = currentStep(steps);
    row.last_step =
      now === null ? `計畫 ${planCount(steps)}` : `計畫 ${planCount(steps)}:${now.text}`;
    this.#save(live);
    this.#emit({ type: "progress", job: row, detail: row.last_step });
  }

  async #run(live: Live): Promise<void> {
    for (;;) {
      const out = await this.#runOnce(live);
      if (this.#closed) return;
      const failed = out.outcome === null || out.outcome.outcome === "failed";
      // A resumed run that failed is tried once more, up to the job's resumes.
      if (failed && live.resume && live.cancelBy === null && live.row.resumes < MAX_RESUMES) {
        live.row.resumes += 1;
        this.#save(live);
        continue;
      }
      this.#settle(live, out.outcome, out.failure, out.reportOnly);
      return;
    }
  }

  async #runOnce(live: Live): Promise<{
    outcome: Awaited<ReturnType<SelfRunner["run"]>> | null;
    failure: string | null;
    reportOnly: boolean;
  }> {
    const row = live.row;
    const kind = row.kind;
    const spec = KINDS[kind];
    const context = row.context as ContextKey;
    const allowance = this.allowance(row, live.resume);
    const profile = profileOf(kind, allowance);
    const wake: Wake =
      row.from === null
        ? { kind: "self", note: null }
        : { kind: "result", tool: WAKE_TOOL, job: row.id, ok: true, text: "", from: row.from };
    const tools = fixedTools(
      this.#p.tools,
      live.tools,
      [planTool((steps) => this.#setPlan(live, steps))],
      kind,
    );
    const runner = new SelfRunner(
      {
        transcript: this.#isolated,
        tools,
        model: this.#p.model,
        prompt: helperPrompt(
          spec,
          async (input: PromptInput) => (await this.#p.rules?.(input.session.context)) ?? null,
          { system: helperSystem(spec, live.tools), plan: () => planLines(row.plan) },
        ),
        guard: composeGuards(helperGuard(kind, tools.listed), this.#p.guard),
        outlet: noMouth,
        clock: { now: () => this.#now() },
        log: this.#p.log,
        onEvent: (event) => this.#onRunEvent(live, event),
        ...(this.#p.selfAccount === undefined ? {} : { selfAccount: this.#p.selfAccount }),
      },
      {
        quota: this.#p.quota ?? null,
        unpricedUsdPerMtok: () => this.#rate(),
        compaction: null,
      },
    );
    let outcome: Awaited<ReturnType<SelfRunner["run"]>> | null = null;
    let failure: string | null = null;
    const reportOnly = allowance.reportOnly === true;
    try {
      if (!live.resume) {
        const goal = goalLine(row.goal, this.kindLimits(kind));
        this.#isolated.append(row.session, [
          { kind: "other", author: goal.author, content: goal.content },
        ]);
      } else {
        const note = reportOnly
          ? RESUME_SPENT_NOTE
          : resumeNote(allowance.rounds, Math.max(1, Math.round(allowance.wallMs / 60_000)));
        this.#isolated.append(row.session, [
          { kind: "other", author: RESUME_AUTHOR, content: note },
        ]);
      }
      // Its own steps are charged by its runner: not to a tool call that may have started it.
      outcome = await withLlmTag({ module: "agent", label: `delegate:${kind}`, onCall: null }, () =>
        runner.run({
          session: { id: row.session, context },
          wake,
          profile,
          signal: live.controller.signal,
          turn: `delegate-${row.id}`,
          payer: this.payerOf(row),
        }),
      );
    } catch (error) {
      failure = errorMessage(error);
      this.#p.log.warn({ job: row.id, err: failure }, "a sub-agent run failed");
    }
    return { outcome, failure, reportOnly };
  }

  #onRunEvent(live: Live, event: RunEvent): void {
    const row = live.row;
    if (event.type === "step") {
      row.rounds += 1;
      row.usage.calls += 1;
      const u = event.usage;
      if (u !== null) {
        row.usage.prompt_tokens += u.prompt_tokens;
        row.usage.completion_tokens += u.completion_tokens;
        row.usage.cached_prompt_tokens += u.cached_prompt_tokens ?? 0;
        row.usage.reasoning_tokens += u.reasoning_tokens ?? 0;
        if (event.cost_usd === null) {
          row.usage.unpriced_tokens += u.prompt_tokens + u.completion_tokens;
        } else {
          row.usage.cost_usd += event.cost_usd;
        }
      }
      // Every step is kept: a restart goes on from what the row says.
      this.#save(live);
    } else if (event.type === "tool_call") {
      const mark = event.ok ? "" : "(沒做成)";
      // Its own plan is a progress event of its own.
      if (event.name === PLAN_TOOL) return;
      row.last_step = `第 ${row.rounds} 輪:${event.name}${mark}`;
      this.#emit({ type: "progress", job: row, detail: row.last_step });
    }
  }

  #settle(
    live: Live,
    outcome: Awaited<ReturnType<SelfRunner["run"]>> | null,
    failure: string | null,
    reportOnly = false,
  ): void {
    const row = live.row;
    const text = outcome?.text.trim() ?? "";
    let state: JobState;
    let note: string | null = null;
    if (live.cancelBy !== null || outcome?.outcome === "cancelled") {
      state = "cancelled";
      row.told = live.cancelBy === null;
      note = live.cancelBy === null ? SHUTDOWN_NOTE : null;
    } else if (outcome === null) {
      state = "failed";
      note = failure === null ? null : `出錯了:${failure}`;
    } else if (outcome.outcome === "over_budget" || outcome.limits.includes("spend")) {
      state = "out_of_budget";
      const capped = this.#p.quota?.capped(this.payerOf(row), this.#now()) ?? null;
      note =
        capped === null
          ? "到了這件工作的預算上限,這是做到那裡的結果"
          : `${capped.which === "day" ? "今天" : "這個小時"}為要這件工作的人花的額度到了,這是做到那裡的結果`;
    } else if (outcome.outcome === "failed") {
      state = "failed";
      note = "模型沒有回答";
    } else if (text === "") {
      state = "failed";
      note = NO_RESULT_NOTE;
    } else {
      state = "done";
      const hit = outcome.limits.find((l): l is Exclude<LimitName, "spend"> => l !== "spend");
      if (hit !== undefined) note = LIMIT_NOTES[hit];
      else if (reportOnly) note = SPENT_BEFORE_NOTE;
    }
    if (state === "failed" && live.resume) note = RESUME_FAILED_NOTE(note ?? NO_RESULT_NOTE);
    row.summary = text === "" ? null : text;
    row.note = note;
    this.#finish(live, state);
  }

  #finish(live: Live, state: JobState): void {
    const row = live.row;
    if (!this.#live.has(row.id)) return;
    row.ran_ms = this.elapsedMs(row);
    this.#live.delete(row.id);
    const at = this.#queue.indexOf(live);
    if (at >= 0) this.#queue.splice(at, 1);
    this.#end(row, state);
    this.#pump();
  }

  /** Keeps `row` as ended in `state`, and tells the place that asked when it is to be told. */
  #end(row: JobRow, state: JobState): void {
    row.state = state;
    row.ended_at = this.#now();
    this.#p.store.saveJob(row);
    this.#remember(row);
    this.#emit({ type: "ended", job: row });
    if (row.told) {
      try {
        this.#p.ended?.(row);
      } catch (error) {
        this.#p.log.warn({ job: row.id, err: errorMessage(error) }, "could not tell of a job");
      }
    }
  }

  #remember(row: JobRow): void {
    this.#ended = [row, ...this.#ended.filter((j) => j.id !== row.id)];
    const keep = Math.max(this.#limits.keepEnded, 1);
    for (const old of this.#ended.slice(keep)) this.#p.store.removeJob(old.id);
    this.#ended = this.#ended.slice(0, keep);
  }

  // ---- cancel -----------------------------------------------------------------------------------

  /** Cancels the job `ref` names (she asked): a queued one goes at once, a running one is cut. */
  cancel(ref: string): { ok: boolean; text: string } {
    const found = this.find(ref);
    if (found === null) return { ok: false, text: DELEGATE_REFUSALS.noJob(ref) };
    if (isEnded(found.state)) {
      return { ok: false, text: DELEGATE_REFUSALS.ended(found.id, found.state) };
    }
    const live = this.#live.get(found.id);
    if (live === undefined) return { ok: false, text: DELEGATE_REFUSALS.noJob(ref) };
    live.cancelBy = "her";
    if (live.row.state === "queued") {
      live.row.told = false;
      live.row.summary = null;
      this.#finish(live, "cancelled");
    } else {
      live.controller.abort(new Error("cancelled"));
    }
    return { ok: true, text: `工作 ${found.id} 取消了。` };
  }

  // ---- what is there ----------------------------------------------------------------------------

  /** The job `ref` names: its id, or the start of one when only one has it. */
  find(ref: string): JobRow | null {
    const r = ref.trim().toLowerCase();
    if (r === "") return null;
    const all = [...[...this.#live.values()].map((l) => l.row), ...this.#ended];
    const exact = all.find((j) => j.id === r);
    if (exact !== undefined) return exact;
    if (r.length < 3) return null;
    const near = all.filter((j) => j.id.startsWith(r));
    return near.length === 1 ? (near[0] as JobRow) : null;
  }

  /** Every job, the ones not ended first (oldest first), then the ended ones, newest first. */
  jobs(): JobRow[] {
    const live = [...this.#live.values()]
      .map((l) => l.row)
      .sort((a, b) => a.created_at - b.created_at);
    return [...live, ...this.#ended];
  }

  /** What a job spent, as a few words. */
  spent(row: JobRow): string {
    const priced = row.usage.unpriced_tokens === 0;
    const tokens = row.usage.prompt_tokens + row.usage.completion_tokens;
    return row.rounds === 0 && tokens === 0
      ? ""
      : spentText(row.rounds, row.usage.cost_usd, tokens, priced);
  }

  /** Lines for `delegate_list`. */
  lines(limit = 10): string[] {
    return this.jobs()
      .slice(0, limit)
      .map((j) =>
        listLine(
          j.id,
          j.state,
          j.kind,
          j.goal,
          this.spent(j),
          j.plan.length === 0 ? "" : planCount(j.plan),
        ),
      );
  }

  /** What she is told when `row` ended: the data of a result wake. */
  resultFor(row: JobRow): string {
    return resultText({
      id: row.id,
      kind: row.kind,
      goal: row.goal,
      asker: row.from?.name ?? null,
      state: row.state,
      spent: this.spent(row) || "沒花什麼",
      note: row.note,
      summary: row.summary ?? "",
      chars: this.#limits.resultChars,
    });
  }

  /**
   * A job's whole summary (`result`), or what it did step by step (`transcript`), from `from`
   * characters on; framed as data. The summary may hold text from web pages.
   */
  read(ref: string, what: "result" | "transcript", from: number): { ok: boolean; text: string } {
    const row = this.find(ref);
    if (row === null) return { ok: false, text: DELEGATE_REFUSALS.noJob(ref) };
    const body = what === "transcript" ? this.#steps(row) : (row.summary ?? "");
    const plan =
      row.plan.length === 0
        ? ""
        : `\n${PLAN_HEAD(planCount(row.plan))}\n${planLines(row.plan).join("\n")}`;
    const head = `${row.kind} ${row.id}(${row.state}):${row.goal}${plan}`;
    if (what === "result" && body === "") {
      return { ok: true, text: dataBlock(DELEGATE_BLOCK, row.id, `${head}\n${NO_RESULT_NOTE}`) };
    }
    const chars = [...body];
    const start = Math.min(Math.max(0, Math.floor(from)), chars.length);
    const part = chars.slice(start, start + this.#limits.readChars).join("");
    const more =
      start + this.#limits.readChars < chars.length
        ? `\n…(還有 ${chars.length - start - this.#limits.readChars} 字,from=${start + this.#limits.readChars} 接著讀)`
        : "";
    return { ok: true, text: dataBlock(DELEGATE_BLOCK, row.id, `${head}\n${part}${more}`) };
  }

  /** One line per call and answer of the job's transcript. */
  #steps(row: JobRow): string {
    const clip = (s: string, n: number): string => {
      const c = [...s.replace(/\s+/g, " ").trim()];
      return c.length > n ? `${c.slice(0, n).join("")}…` : c.join("");
    };
    const out: string[] = [];
    for (const e of this.#p.transcript.tail(row.session).entries) {
      switch (e.kind) {
        case "other":
          out.push(`${e.author === RESUME_AUTHOR ? "重啟" : "任務"}:${clip(e.content, 300)}`);
          break;
        case "tool_calls":
          if (e.content.trim() !== "") out.push(`寫了:${clip(e.content, 200)}`);
          for (const c of e.tool_calls) out.push(`呼叫 ${c.name}(${clip(c.arguments, 120)})`);
          break;
        case "tool_result":
          out.push(`  → ${clip(e.content, 240)}`);
          break;
        case "self":
          out.push(`寫了:${clip(e.content, 400)}`);
          break;
        case "note":
          break;
      }
    }
    return out.join("\n");
  }

  // ---- restart ----------------------------------------------------------------------------------

  /**
   * Reads what the last run left: the reflection's day, the ended jobs (for the lists and `read`),
   * and the jobs that never finished. A running one goes on from its transcript and a queued one
   * waits its turn again; one that cannot (the reflection, a job of no place, one already resumed
   * `MAX_RESUMES` times, one whose tools are gone) ends here as failed and is told once. Returns
   * how many ended so.
   */
  async recover(): Promise<number> {
    const loaded = await this.#p.store.load();
    const now = this.#now();
    this.#reflectPool.restore(loaded.reflectDay, now);
    let cut = 0;
    const again: Live[] = [];
    const rows = [...loaded.jobs].map(normaliseRow).sort((a, b) => b.created_at - a.created_at);
    for (const row of rows) {
      if (this.#live.has(row.id)) continue;
      if (isEnded(row.state)) {
        if (!this.#ended.some((j) => j.id === row.id)) this.#ended.push(row);
        continue;
      }
      const why = this.#cannotResume(row);
      if (why !== null) {
        cut += 1;
        row.note = why;
        row.told = row.kind !== "reflect" && row.context !== null;
        this.#end(row, "failed");
        continue;
      }
      const resume = row.state === "running";
      if (resume) row.resumes += 1;
      // It waits like any job; `#begin` makes it running again.
      row.state = "queued";
      again.push(
        this.#liveOf(
          row,
          jobTools(row.kind, (n) => this.#p.tools.entry(n)),
          resume,
        ),
      );
    }
    this.#ended.sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
    const keep = Math.max(this.#limits.keepEnded, 1);
    for (const old of this.#ended.slice(keep)) this.#p.store.removeJob(old.id);
    this.#ended = this.#ended.slice(0, keep);
    // The ones that were running go first, each group oldest first.
    again.sort(
      (a, b) => Number(b.resume) - Number(a.resume) || a.row.created_at - b.row.created_at,
    );
    for (const live of again) {
      this.#live.set(live.row.id, live);
      this.#queue.push(live);
      this.#p.store.saveJob(live.row);
    }
    if (again.length > 0) {
      this.#p.log.info({ count: again.length }, "sub-agent jobs go on after the restart");
    }
    this.#pump();
    return cut;
  }

  /** Why an unfinished job cannot go on after a restart; `null`: it can. */
  #cannotResume(row: JobRow): string | null {
    if (row.kind === "reflect" || row.context === null || this.#closed) return RESTART_NOTE;
    if (!isSubagentKind(row.kind) || !KINDS[row.kind].callable) return RESTART_NOTE;
    if (row.resumes >= MAX_RESUMES && row.state === "running") {
      return RESUME_FAILED_NOTE(RESTART_NOTE);
    }
    if (jobTools(row.kind, (n) => this.#p.tools.entry(n)).length === 0) {
      return DELEGATE_REFUSALS.noTools(row.kind);
    }
    return null;
  }

  // ---- the nightly reflection -------------------------------------------------------------------

  /**
   * Runs `run` (the reflection as it is today) as a job of kind `reflect`, under the nightly pool:
   * its calls are counted as they end (`withLlmTag`'s `onCall`), and one that takes the pool past
   * its cap cuts the run (its signal aborts). Nothing runs when the pool is already used up. The
   * run is recorded and published like any job; nobody is told when it ends.
   */
  async trackReflect<T>(input: {
    goal: string;
    run: (signal: AbortSignal) => Promise<T>;
    /** The tokens of a finished call (`router.calls.get(id)?.usage`), for a model with no price. */
    usageOf?: (callId: string) => { prompt_tokens: number; completion_tokens: number } | null;
    summarise?: (result: T) => string;
    signal?: AbortSignal;
  }): Promise<{ ran: boolean; result: T | null; job: JobRow | null; why: string | null }> {
    if (this.#closed) return { ran: false, result: null, job: null, why: DELEGATE_REFUSALS.closed };
    if (this.#reflectPool.over(this.#now())) {
      return { ran: false, result: null, job: null, why: "今晚反思能花的額度用完了" };
    }
    const id = this.#newId();
    const row: JobRow = {
      id,
      kind: "reflect",
      goal: input.goal,
      context: null,
      from: null,
      state: "running",
      budget_usd: this.#reflectPool.cap.usd,
      rounds: 0,
      usage: noUsage(),
      created_at: this.#now(),
      started_at: this.#now(),
      ended_at: null,
      summary: null,
      note: null,
      session: `delegate:${id}`,
      told: false,
      plan: [],
      last_step: null,
      ran_ms: 0,
      resumes: 0,
    };
    const controller = new AbortController();
    const signal =
      input.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, input.signal]);
    let budgetHit = false;
    this.#p.store.saveJob(row);
    this.#emit({ type: "started", job: row });
    let result: T | null = null;
    let failure: string | null = null;
    try {
      result = await withLlmTag(
        {
          onCall: (call) => {
            if (call.status === "streaming") return;
            const now = this.#now();
            const tokens = input.usageOf?.(call.id);
            const count =
              tokens === null || tokens === undefined
                ? 0
                : tokens.prompt_tokens + tokens.completion_tokens;
            const usd = chargeOf(
              call.cost_usd,
              { prompt_tokens: count, completion_tokens: 0 },
              this.#rate(),
            );
            this.#reflectPool.add(now, usd, count, call.cost_usd !== null);
            row.rounds += 1;
            row.usage.calls += 1;
            if (call.cost_usd === null) row.usage.unpriced_tokens += count;
            else row.usage.cost_usd += call.cost_usd;
            if (tokens !== null && tokens !== undefined) {
              row.usage.prompt_tokens += tokens.prompt_tokens;
              row.usage.completion_tokens += tokens.completion_tokens;
            }
            this.#p.store.saveDay("reflect", this.#reflectPool.state(now));
            if (this.#reflectPool.over(now) && !signal.aborted) {
              budgetHit = true;
              controller.abort(new Error("budget"));
            }
          },
        },
        () => input.run(signal),
      );
    } catch (error) {
      failure = errorMessage(error);
    }
    row.ended_at = this.#now();
    row.ran_ms = Math.max(0, row.ended_at - (row.started_at ?? row.ended_at));
    if (budgetHit) {
      row.state = "out_of_budget";
      row.note = "今晚反思能花的額度用完了,後面的沒做";
    } else if (failure !== null) {
      row.state = "failed";
      row.note = `出錯了:${failure}`;
    } else {
      row.state = "done";
    }
    row.summary = result === null || input.summarise === undefined ? null : input.summarise(result);
    this.#p.store.saveJob(row);
    this.#remember(row);
    this.#emit({ type: "ended", job: row });
    return { ran: true, result, job: row, why: failure };
  }

  // ---- stopping ---------------------------------------------------------------------------------

  /** Waits until every job that is going has settled (tests). */
  async idle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  /**
   * Stops everything: what runs is cut and what waits is dropped. Their rows stay as they were
   * kept, so the next start goes on with them (`recover`).
   */
  close(): void {
    this.#closed = true;
    this.#queue.splice(0);
    for (const live of this.#live.values()) live.controller.abort(new Error("closed"));
  }
}
