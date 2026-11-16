// One live run: the chosen suites against one subject, under one meter. The result is one JSON
// file per run and one summary line appended to `history.jsonl` beside it, so runs of different
// subjects and commits can be put next to each other.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Judge } from "./judge.js";
import type { Meter } from "./meter.js";
import type { ModelUsage, Subject } from "./subject.js";
import { SuiteRegistry, type SuiteResult } from "./suite.js";
import { runPersona } from "./suites/persona.js";
import { runRelationship } from "./suites/relationship.js";
import { runTools } from "./suites/tools.js";

/** The live suites. `memory` is a slot: its runner comes from the recall harness. */
export function defaultSuites(): SuiteRegistry {
  return new SuiteRegistry()
    .register("persona", runPersona)
    .register("tools", (ctx) => runTools(ctx))
    .register("relationship", (ctx) => runRelationship(ctx))
    .register("memory", null);
}

/** The suites a run takes when none is named: the ones that have a runner. */
export function runnableSuites(registry: SuiteRegistry): string[] {
  return registry.names().filter((n) => registry.get(n) !== null);
}

export interface LiveRunOptions {
  subject: Subject;
  judge: Judge;
  meter: Meter;
  registry: SuiteRegistry;
  /** Suite names, in the order to run. */
  suites: readonly string[];
  persona: string;
  repeat?: number;
  seed?: string;
  /** The git commit the run is of (`null`: unknown). */
  commit?: string | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LiveRun {
  at: string;
  commit: string | null;
  subject: string;
  seed: string;
  repeat: number;
  suites: SuiteResult[];
  /** Every model call of the run: the subject's and the judge's. */
  usage: ModelUsage;
  models: Record<string, ModelUsage>;
  /** Estimated cost in USD of the calls whose model has a price. */
  usd: number;
  /** Models with no `[llm.pricing]` entry: their cost is unknown and not in `usd`. */
  unpriced: string[];
  duration_ms: number;
  /** The limit was reached: the suites after it did not run, the one in it is partial. */
  stopped?: "budget";
}

export async function runLive(options: LiveRunOptions): Promise<LiveRun> {
  const now = options.now ?? (() => Date.now());
  const start = now();
  const seed = options.seed ?? new Date(start).toISOString();
  const repeat = options.repeat ?? 1;
  const log = options.log ?? (() => undefined);
  const suites: SuiteResult[] = [];
  let stopped = false;
  for (const name of options.suites) {
    const empty = { suite: name, headline: {}, items: [], unsupported: [] };
    if (!options.registry.has(name)) {
      suites.push({ ...empty, skipped: "no suite of this name" });
      continue;
    }
    const runner = options.registry.get(name);
    if (runner === null) {
      suites.push({ ...empty, skipped: "no runner registered for this suite" });
      continue;
    }
    if (stopped || options.meter.spent()) {
      stopped = true;
      suites.push({ ...empty, stopped: "budget" });
      continue;
    }
    const result = await runner({
      subject: options.subject,
      judge: options.judge,
      meter: options.meter,
      persona: options.persona,
      repeat,
      seed,
      log,
    });
    suites.push(result);
    if (result.stopped === "budget") stopped = true;
  }
  return {
    at: new Date(start).toISOString(),
    commit: options.commit ?? null,
    subject: options.subject.name,
    seed,
    repeat,
    suites,
    usage: options.meter.usage(),
    models: options.meter.models(),
    usd: options.meter.usd(),
    unpriced: options.meter.unpriced(),
    duration_ms: Math.max(0, now() - start),
    ...(stopped ? { stopped: "budget" as const } : {}),
  };
}

/** The summary line of a run in `history.jsonl`. */
export interface HistoryLine {
  at: string;
  commit: string | null;
  subject: string;
  /** Headline numbers per suite that ran. */
  suites: Record<string, Record<string, number | null>>;
  tokens: ModelUsage;
  /** `null`: a model that answered has no price, so the cost is unknown. */
  usd: number | null;
  duration_ms: number;
  stopped?: "budget";
}

export function historyLine(run: LiveRun): HistoryLine {
  return {
    at: run.at,
    commit: run.commit,
    subject: run.subject,
    suites: Object.fromEntries(
      run.suites.filter((s) => s.skipped === undefined).map((s) => [s.suite, s.headline]),
    ),
    tokens: run.usage,
    usd: run.unpriced.length > 0 ? null : run.usd,
    duration_ms: run.duration_ms,
    ...(run.stopped ? { stopped: run.stopped } : {}),
  };
}

export const HISTORY_FILE = "history.jsonl";

/** Writes the run's JSON file into `dir` (created on demand) and appends its history line. */
export function writeRun(run: LiveRun, dir: string): { file: string; history: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = run.at.replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "");
  const file = join(dir, `${stamp}-${run.subject}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  const history = join(dir, HISTORY_FILE);
  appendFileSync(history, `${JSON.stringify(historyLine(run))}\n`);
  return { file, history };
}

const pct = (n: number | null): string => (n === null ? "  n/a" : n.toFixed(3));

/** A short table of the run. */
export function formatRun(run: LiveRun): string {
  const lines = [
    `live eval: subject ${run.subject}, commit ${run.commit ?? "unknown"}, repeat ${run.repeat}`,
  ];
  for (const s of run.suites) {
    if (s.skipped !== undefined) {
      lines.push(`  ${s.suite.padEnd(13)} skipped: ${s.skipped}`);
      continue;
    }
    const numbers = Object.entries(s.headline)
      .map(([k, v]) => `${k} ${pct(v)}`)
      .join("  ");
    const notes = [
      `${s.items.length} items`,
      ...(s.unsupported.length > 0
        ? [`unsupported: ${s.unsupported.map((u) => u.id).join(", ")}`]
        : []),
      ...(s.stopped ? ["stopped: budget"] : []),
    ];
    lines.push(`  ${s.suite.padEnd(13)} ${numbers || "-"}  (${notes.join("; ")})`);
  }
  const u = run.usage;
  lines.push(
    `tokens: prompt ${u.prompt_tokens} (cached ${u.cached_prompt_tokens}), completion ${u.completion_tokens} (reasoning ${u.reasoning_tokens}), ${u.calls} model calls`,
  );
  lines.push(
    run.unpriced.length > 0
      ? `cost: unknown (no [llm.pricing] for ${run.unpriced.join(", ")}); priced calls come to $${run.usd.toFixed(4)}`
      : `cost: about $${run.usd.toFixed(4)}`,
  );
  lines.push(`time: ${(run.duration_ms / 1000).toFixed(1)} s`);
  if (run.stopped) lines.push("stopped: budget (the results above are partial)");
  return lines.join("\n");
}
