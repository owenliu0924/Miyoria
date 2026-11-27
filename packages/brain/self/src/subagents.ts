// The kinds of sub-agent (docs/design/v5-brain.md 「子代理」, v5-architecture.md §7.3, §14,
// v6-agent.md 第一批), each a row of one typed table: who it is (its system text), the tools it
// starts with, what its tools may do to the world, and its default limits and budget (the config
// `[modules.agent.delegate.kinds.<kind>]` replaces them, but for the fixed calls per step and the
// token ceiling). A sub-agent runs on the same turn runner
// as she does, on the `subagent` profile, and differs from her only here:
//
// - its tools are its kind's list, plus `plan`; a `worker` may load more with its own `find_tools`,
//   and finds only what its kind may call;
// - nothing with effect `say` or `spend` is ever offered to it, and a call of one is refused even
//   if the model makes it. `research` may only read; `curator` reads and writes the notebook; a
//   `worker` has a list of tools by name (`WORKER_TOOLS`): the web, her memory search, reading the
//   notebook, the workspace and the sandbox, plus the MCP and plugin tools the owner names in
//   `[modules.agent.delegate.kinds.worker] extra_tools`. It never acts on Discord, her voice, games,
//   coins or her schedule, never loads tools into her session, and never rewrites what she keeps
//   about people: what it reads on the web may be written by anyone;
// - it has no way out: a line it writes is a result, never said to anyone.

import {
  FIND_TOOLS,
  findTools,
  type Tool,
  type ToolEntry,
  ToolRegistry,
  toolSession,
} from "@miyoria/llm/tools";
import type { TranscriptStore } from "@miyoria/memory/transcript";
import {
  CURATOR_SYSTEM,
  GOAL_AUTHOR,
  goalEntry,
  HELPER_REFUSALS,
  jobNow,
  REFLECT_SYSTEM,
  RESEARCH_SYSTEM,
  WORKER_BROWSE,
  WORKER_CODE,
  WORKER_IMAGE,
  WORKER_NO_CODE,
  WORKER_SHELL,
  WORKER_SYSTEM,
} from "./delegate-texts.js";
import { PLAN_TOOL } from "./plan.js";
import { CALLS_PER_ROUND, PROFILES, type RunProfile, withLimits } from "./profiles.js";
import {
  ALLOW,
  type Delivery,
  type Guard,
  type GuardCall,
  type GuardContext,
  type GuardVerdict,
  type Outlet,
  type PromptSource,
  type RunTools,
  refuse,
} from "./types.js";

export type SubagentKind = "research" | "curator" | "worker" | "reflect";

export const SUBAGENT_KINDS: readonly SubagentKind[] = ["research", "curator", "worker", "reflect"];

/** What one job of a kind may use: `[modules.agent.delegate.kinds.<kind>]`. */
export interface KindLimits {
  /** Model steps that may call tools. */
  rounds: number;
  /** Wall time of the whole job, a restart's gap not counted (ms). */
  wallMs: number;
  /** One tool call may take this long (ms). */
  toolMs: number;
  /** Prompt and completion tokens of the job: a fixed safety ceiling, not a setting. */
  tokens: number;
  /** USD a job may spend when she does not say: the size of one task, hers to pick. */
  defaultUsd: number;
  /** USD a job may spend at most, whatever she asks for. */
  maxUsd: number;
  /** A worker's MCP and plugin tools besides its list (`extra_tools`). */
  extraTools?: readonly string[];
}

export interface KindSpec {
  kind: SubagentKind;
  /** She may start it. `false`: it is the program's own (the nightly reflection). */
  callable: boolean;
  /** Who it is: block 1 of its prompt (the runner adds its rules after it). */
  system: string;
  /** Its tools at the start; the ones not registered are left out. */
  tools: readonly string[];
  /** It may load more tools with `find_tools` (its own, over what `allows` lets through). */
  finds: boolean;
  /** Whether it may call `entry` at all: what the tool does to the world, by effect and group. */
  allows(entry: Pick<ToolEntry, "name" | "effect" | "group">): boolean;
  /** Its limits when the config says nothing. */
  limits: KindLimits;
}

/** The kinds she may start. */
export type CallableKind = Exclude<SubagentKind, "reflect">;

/** The sandbox's tools: a worker has them when they are registered. */
export const CODE_TOOLS: readonly string[] = [
  "code_run",
  "shell_run",
  "code_session",
  "workspace_run",
];

/**
 * What a worker may call, by name (besides its `plan` and its own `find_tools`). A group or an
 * effect says too little: `read` tools include her job list and her loading of skills, and the
 * notebook's writes would let a web page rewrite what she keeps about people.
 */
export const WORKER_TOOLS: readonly string[] = [
  "web_search",
  "web_read",
  "web_image",
  "recall",
  "notebook_read",
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "workspace_edit",
  "workspace_grep",
  "workspace_delete",
  "workspace_export",
  "image_make",
  "browse_open",
  "browse_act",
  "browse_read",
  "browse_shot",
  ...CODE_TOOLS,
];

/** The groups `extra_tools` may name tools of: MCP servers, plugins and declared HTTP tools. */
export const WORKER_EXTRA_GROUPS: ReadonlySet<string> = new Set(["mcp", "extension", "http"]);

/**
 * The MCP and plugin tools a worker may call besides its list, by exact name
 * (`[modules.agent.delegate.kinds.worker] extra_tools`): set when the config is read
 * (`kindLimitsOf("worker", …)`), for the process, as there is one config.
 */
let workerExtras: ReadonlySet<string> = new Set();

/** Sets the worker's extra tools (the config's `extra_tools`). */
export function setWorkerExtraTools(names: readonly string[]): void {
  workerExtras = new Set(names.map((n) => n.trim()).filter((n) => n !== ""));
}

/** The worker's extra tools as set. */
export function workerExtraTools(): string[] {
  return [...workerExtras];
}

const never = (e: Pick<ToolEntry, "effect">): boolean => e.effect === "say" || e.effect === "spend";

/** Whether a worker may call `e`: its list by name, or an extra MCP or plugin tool. */
export function workerAllows(
  e: Pick<ToolEntry, "name" | "effect" | "group">,
  extras: ReadonlySet<string> = workerExtras,
): boolean {
  if (e.name === PLAN_TOOL || e.name === FIND_TOOLS) return true;
  if (never(e)) return false;
  if (WORKER_TOOLS.includes(e.name)) return true;
  return extras.has(e.name) && WORKER_EXTRA_GROUPS.has(e.group);
}

/**
 * Tools of a helper by name, never by the registry's core flag: a helper has what its row says.
 * `recall` is her memory search, `notebook_*` her notebook; the web tools only read.
 */
export const KINDS: Readonly<Record<SubagentKind, KindSpec>> = {
  research: {
    kind: "research",
    callable: true,
    system: RESEARCH_SYSTEM,
    tools: ["web_search", "web_read", "web_image", "recall", "notebook_read"],
    finds: false,
    allows: (e) => e.name === PLAN_TOOL || e.effect === "read",
    limits: {
      rounds: 16,
      wallMs: 8 * 60_000,
      toolMs: 45_000,
      tokens: 500_000,
      defaultUsd: 0.25,
      maxUsd: 1,
    },
  },
  curator: {
    kind: "curator",
    callable: true,
    system: CURATOR_SYSTEM,
    tools: ["notebook_read", "notebook_write", "notebook_delete", "recall"],
    finds: false,
    allows: (e) => e.name === PLAN_TOOL || e.effect === "read" || e.effect === "act",
    limits: {
      rounds: 20,
      wallMs: 8 * 60_000,
      toolMs: 30_000,
      tokens: 500_000,
      defaultUsd: 0.25,
      maxUsd: 0.75,
    },
  },
  worker: {
    kind: "worker",
    callable: true,
    system: WORKER_SYSTEM,
    tools: WORKER_TOOLS,
    finds: true,
    allows: (e) => workerAllows(e),
    limits: {
      rounds: 60,
      wallMs: 30 * 60_000,
      toolMs: 180_000,
      tokens: 4_000_000,
      defaultUsd: 1,
      maxUsd: 3,
      extraTools: [],
    },
  },
  reflect: {
    kind: "reflect",
    callable: false,
    system: REFLECT_SYSTEM,
    tools: [],
    finds: false,
    allows: (e) => e.effect === "read",
    limits: {
      rounds: PROFILES.reflect.limits.rounds,
      wallMs: PROFILES.reflect.limits.wallMs,
      toolMs: PROFILES.reflect.limits.toolMs,
      tokens: PROFILES.reflect.limits.tokens,
      defaultUsd: 0.5,
      maxUsd: 0.5,
    },
  },
};

export function isSubagentKind(value: string): value is SubagentKind {
  return (SUBAGENT_KINDS as readonly string[]).includes(value);
}

/** The kinds she may start, in the table's order. */
export const CALLABLE_KINDS: readonly CallableKind[] = SUBAGENT_KINDS.filter(
  (k): k is CallableKind => KINDS[k].callable,
);

/** The default limits of every kind she may start. */
export function defaultKindLimits(): Record<CallableKind, KindLimits> {
  return {
    research: { ...KINDS.research.limits },
    curator: { ...KINDS.curator.limits },
    worker: { ...KINDS.worker.limits, extraTools: [] },
  };
}

/** A kind's limits as `[modules.agent.delegate.kinds.<kind>]` writes them. */
export interface KindLimitsConfig {
  rounds: number;
  minutes: number;
  tool_seconds: number;
  usd_default: number;
  usd_max: number;
  /** A worker's only: MCP and plugin tools it may call besides its list. */
  extra_tools?: readonly string[];
}

/**
 * `kind`'s limits from its config; the token ceiling is the kind's own. A worker's `extra_tools`
 * are also set for the process here (`setWorkerExtraTools`), where its guard reads them.
 */
export function kindLimitsOf(kind: CallableKind, c: KindLimitsConfig): KindLimits {
  const limits: KindLimits = {
    rounds: c.rounds,
    wallMs: Math.round(c.minutes * 60_000),
    toolMs: c.tool_seconds * 1000,
    tokens: KINDS[kind].limits.tokens,
    defaultUsd: c.usd_default,
    maxUsd: c.usd_max,
  };
  if (kind !== "worker") return limits;
  const extra = [...(c.extra_tools ?? [])];
  setWorkerExtraTools(extra);
  return { ...limits, extraTools: extra };
}

/** The USD a job may spend: what was asked, within the kind's maximum; the default when unset. */
export function jobBudget(limits: KindLimits, asked: number | null | undefined): number {
  const { defaultUsd, maxUsd } = limits;
  if (asked === null || asked === undefined || !Number.isFinite(asked) || asked <= 0) {
    return Math.min(defaultUsd, maxUsd);
  }
  return Math.min(asked, maxUsd);
}

/** What one run of a job may use; a resumed job's is what is left of its whole. */
export interface RunAllowance {
  rounds: number;
  wallMs: number;
  toolMs: number;
  tokens: number;
  /** Its own budget (USD; 0: none, the asker's quota and the daily budget still hold). */
  usd: number;
  /** Nothing is offered: the run only writes what it has (a job whose allowance is used up). */
  reportOnly?: boolean;
}

/** The profile one run of a job of `kind` runs on. */
export function profileOf(kind: SubagentKind, allowance: RunAllowance): RunProfile {
  const spec = KINDS[kind];
  const base = kind === "reflect" ? PROFILES.reflect : PROFILES.subagent;
  return {
    ...withLimits(base, {
      rounds: allowance.rounds,
      callsPerRound: CALLS_PER_ROUND,
      wallMs: allowance.wallMs,
      toolMs: allowance.toolMs,
      tokens: allowance.tokens,
      usd: allowance.usd,
    }),
    offers: allowance.reportOnly === true ? () => false : (tool) => spec.allows(tool),
  };
}

/**
 * The tools of one job at its start: the row's list (a worker's with its extra tools), as far as
 * each is registered and its kind may call it. A worker's list may grow with its own
 * `find_tools`; the others' never does.
 */
export function jobTools(
  kind: SubagentKind,
  entry: (name: string) => ToolEntry | undefined,
): string[] {
  const spec = KINDS[kind];
  const names = kind === "worker" ? [...new Set([...spec.tools, ...workerExtras])] : spec.tools;
  return names.filter((name) => {
    const e = entry(name);
    return e !== undefined && spec.allows(e);
  });
}

/** Whether a worker with `tools` can run code (the sandbox is there). */
export function canRunCode(tools: readonly string[]): boolean {
  return tools.some((t) => CODE_TOOLS.includes(t));
}

/** What a job's runner calls: the registry, with the job's own tools in front of it. */
export interface JobRegistry {
  entry(name: string): ToolEntry | undefined;
  run: RunTools["run"];
  /** Every registered tool, for a worker's `find_tools`; unset: it finds nothing. */
  entries?(): ToolEntry[];
}

/**
 * What the runner sees of the registry for one job: the job's list, then what its `find_tools`
 * loaded, with `local` (its `plan`) in front. A worker's `find_tools` is its own: it searches only
 * what the kind may call and loads into the job's list, never into hers.
 */
export function fixedTools(
  registry: JobRegistry,
  names: readonly string[],
  local: readonly Tool[] = [],
  kind: SubagentKind | null = null,
): RunTools & { listed(name: string, session: string): boolean } {
  const own = new ToolRegistry();
  own.unregister(FIND_TOOLS);
  for (const tool of local) own.register(tool);
  const spec = kind === null ? null : KINDS[kind];
  if (spec?.finds === true) {
    own.register(
      findTools({
        listings: () => (registry.entries?.() ?? []).filter((e) => spec.allows(e)),
        loaded: own.loaded,
      }),
    );
  }
  const entry = (name: string): ToolEntry | undefined => own.entry(name) ?? registry.entry(name);
  const fixed = [...local.map((t) => t.spec.name), ...(spec?.finds ? [FIND_TOOLS] : []), ...names];
  return {
    offered: (session) => {
      const seen = new Set<string>();
      return [...fixed, ...own.loaded.loaded(session)].flatMap((n) => {
        if (seen.has(n)) return [];
        seen.add(n);
        return entry(n) ?? [];
      });
    },
    entry,
    run: (name, ctx, args) =>
      own.entry(name) !== undefined ? own.run(name, ctx, args) : registry.run(name, ctx, args),
    loaded: own.loaded,
    listed: (name, session) => fixed.includes(name) || own.loaded.loaded(session).includes(name),
  };
}

/**
 * The guard of a helper, before the real one: it refuses what a helper never does whatever the
 * model asks (a tool of effect `say` or `spend`, a tool its kind may not call, any tool not in its
 * list) and every line. The refusal is the call's result, so it is in the transcript.
 */
export function helperGuard(
  kind: SubagentKind,
  listed: ReadonlySet<string> | ((name: string, session: string) => boolean),
): Guard {
  const spec = KINDS[kind];
  const has = (name: string, ctx: GuardContext): boolean =>
    typeof listed === "function"
      ? listed(name, toolSession(ctx.session.context))
      : listed.has(name);
  return {
    async checkCall({ entry }: GuardCall, ctx: GuardContext): Promise<GuardVerdict> {
      if (never(entry) || !spec.allows(entry)) {
        return refuse("effect", HELPER_REFUSALS.effect(entry.name));
      }
      if (!has(entry.name, ctx)) return refuse("listed", HELPER_REFUSALS.listed(entry.name));
      return ALLOW;
    },
    async checkLine(): Promise<GuardVerdict> {
      return refuse("no_mouth", HELPER_REFUSALS.mouth);
    },
  };
}

/** No way out: nothing a helper writes reaches anyone. */
export const noMouth: Outlet = {
  async deliver(): Promise<Delivery> {
    return { status: "blocked", reason: HELPER_REFUSALS.mouth };
  },
};

/** Block 1 of a job: its kind's system text, and for a worker whether code can run. */
export function helperSystem(spec: KindSpec, tools: readonly string[]): string {
  if (spec.kind !== "worker") return spec.system;
  const lines = [spec.system, canRunCode(tools) ? WORKER_CODE : WORKER_NO_CODE];
  if (tools.includes("shell_run")) lines.push(WORKER_SHELL);
  if (tools.includes("browse_open")) lines.push(WORKER_BROWSE);
  if (tools.includes("image_make")) lines.push(WORKER_IMAGE);
  return lines.join("\n");
}

/**
 * The blocks of a helper's prompt: its system text, the owner's rules (they bind it as they bind
 * her), and what the job is, with its plan. Nothing of hers: no memory, no people, no mood.
 */
export function helperPrompt(
  spec: KindSpec,
  pinned: (input: Parameters<PromptSource["pinned"]>[0]) => Promise<string | null>,
  options: { system?: string; plan?: () => readonly string[] } = {},
): PromptSource {
  return {
    fixed: async () => options.system ?? spec.system,
    pinned,
    place: async () => null,
    recalled: async () => null,
    now: async () => jobNow(spec.kind, options.plan?.() ?? []),
  };
}

/** The entry that opens a helper's transcript. */
export function goalLine(goal: string, limits: KindLimits): { author: string; content: string } {
  return {
    author: GOAL_AUTHOR,
    content: goalEntry(goal, limits.rounds, Math.round(limits.wallMs / 60_000)),
  };
}

/**
 * `store` for a helper's runner: the same store, but its writes do not name a platform context.
 * `TranscriptStore.sessionFor` finds a place's session by the context last written to it, so a
 * helper's session must never claim her conversation's place.
 */
export function isolatedTranscript(store: TranscriptStore): TranscriptStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "append") {
        return (session: string, entries: Parameters<TranscriptStore["append"]>[1]) =>
          target.append(session, entries);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
