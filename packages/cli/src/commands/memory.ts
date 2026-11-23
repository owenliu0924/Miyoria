// `miyoria memory rebuild`: writes her memory again from the event log (what the segment pass
// does for a live conversation, run over the lines already logged). Offline, on one database file.
//
// - A dry run (the default) reads the log and prints what a run would do and cost, with no model
//   call. It opens the store, which applies schema migrations the file is still missing.
// - `--apply` runs every segment through the pass with the model of the config. Progress is kept
//   in the database (`event_cursors`, consumer `memory.rebuild`), so a stopped run goes on from
//   the segment it was at. `--max-usd` stops it before the next segment once that much is spent.
// - It writes lines and episodes only. It never deletes or supersedes a record.
// - `--apply` records when the rebuild first began, and when a run has handled every segment
//   (the setting `notes:rebuild`): from the next start of the Core on, her notes are the source
//   of her memory (the live segment pass runs, consolidation stops, recall reads the notes).
// - `--apply` is refused while another process holds the database file open (a Core running on
//   it), unless `--force`. That check is the operating system's view of the file (`heldFiles`),
//   not a lock of the Core's own.
// - With `[memory.embedding]` on, `--apply` ends by giving every line of her documents a vector
//   (`rebuildVectors`), and the pass finds related documents by meaning too; either way the
//   report says how many lines still wait for one (the running Core's backfill does the rest).
//
// The notes package is imported by relative path (and lazily): the CLI has no dependency on
// `@miyoria/memory` yet.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProfile, profileId } from "@miyoria/core/light";
import {
  type ChatProvider,
  type Completer,
  LlmConfigSchema,
  LlmRouter,
  type ModelRef,
  modelRefString,
  OpenAiFactory,
  type Pricing,
  PricingSchema,
  parseModelRef,
} from "@miyoria/llm/llm";
import { type Config, configureLogging, parseSection } from "@miyoria/runtime/kernel";
import { type ReasoningLevel, toTimestamp } from "@miyoria/types";
import { t } from "../i18n/index.js";
import { bold, dim, note, ok, println, section, warn } from "../ui.js";
import { configuredDatabase } from "./db.js";
import { loadConfig } from "./node.js";

export class MemoryCommandError extends Error {
  override readonly name = "MemoryCommandError";
}

/** What a run spends at most when `--max-usd` is not given. */
export const DEFAULT_MAX_USD = 2;
/** The model purpose of the segment pass. */
export const REBUILD_PURPOSE = "summarizer";
/** How long the pass waits for a query's vector in a rebuild. */
const REBUILD_VECTOR_WAIT_MS = 10_000;

/** The model of a run: what answers, and what a token costs (`null`: no price in the config). */
export interface RebuildModel {
  router: Completer;
  price: Pricing | null;
  /** The first model of the chain, as `provider:model`; empty without a chain. */
  label: string;
  /** How deeply the pass's model reasons (its thinking is billed as output); absent: `off`. */
  reasoning?: ReasoningLevel;
}

export interface RebuildCommandOptions {
  /** The database file; default `core.database_url`. */
  file?: string | undefined;
  /** Chat lines before this time are left out (an ISO date or time); default 2026-11-15. */
  since?: string | undefined;
  apply: boolean;
  /** USD; default `DEFAULT_MAX_USD`. */
  maxUsd?: string | undefined;
  force: boolean;
}

/** What makes vectors for the end of a run (`Embedder` of the memory package). */
export interface RebuildEmbedder {
  readonly name: string;
  readonly enabled: boolean;
  readonly embeddingModel?: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  embedQuery?(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  close?(): Promise<void>;
}

/** What tests replace: the model, the check for a process holding the file, the embedder. */
export interface RebuildSeams {
  model?: (config: Config, apply: boolean) => Promise<RebuildModel>;
  held?: (files: readonly string[]) => string[];
  embedder?: (config: Config) => Promise<RebuildEmbedder>;
}

/** Silences the store's migration log lines in the middle of the report. */
function quietLogs(): void {
  if (!process.env.MIYORIA_LOG_LEVEL) configureLogging({ level: "warn" });
}

const loadNotes = async () => ({
  ...(await import("../../../memory/notes/src/rebuild.js")),
  ...(await import("../../../memory/notes/src/store.js")),
  ...(await import("../../../memory/notes/src/vectors.js")),
  ...(await import("../../../memory/notes/src/rank.js")),
});

/** The embedder `[memory.embedding]` names (nothing is loaded until it embeds). */
async function embedderOfConfig(config: Config): Promise<RebuildEmbedder> {
  const { EmbeddingConfigSchema } = await import("../../../memory/memory/src/config.js");
  const { buildEmbedder } = await import("../../../memory/memory/src/embed.js");
  return buildEmbedder(config.get("memory.embedding", EmbeddingConfigSchema));
}

/** `[modules.memory]`, for how the pass ranks related documents by meaning. */
async function memoryConfigOf(config: Config) {
  const { MemoryConfigSchema } = await import("../../../memory/memory/src/config.js");
  return parseSection(MemoryConfigSchema, config.module("memory").config ?? {}, "modules.memory");
}

/**
 * The router of the config, as the Core builds it (the profile's `[llm.purposes]` over the global
 * ones); providers only when `withProviders`, so a dry run needs no keys.
 */
export async function modelOfConfig(
  config: Config,
  withProviders: boolean,
  purpose = REBUILD_PURPOSE,
): Promise<RebuildModel> {
  const llm = config.get("llm", LlmConfigSchema);
  const providers = new Map<string, ChatProvider>();
  if (withProviders) {
    const factory = new OpenAiFactory();
    for (const [name, cfg] of Object.entries(llm.providers)) {
      if (!factory.kinds.includes(cfg.kind)) {
        throw new MemoryCommandError(t.memory.unknownKind(name, cfg.kind));
      }
      providers.set(name, factory.build(name, cfg));
    }
  }
  const pricing = new Map(Object.entries(llm.pricing));
  const router = new LlmRouter(providers, new Map(Object.entries(llm.purposes)), {
    pricing,
    reasoning: new Map(Object.entries(llm.reasoning)),
    imageInput: new Map(Object.entries(llm.image_input)),
  });
  const profile = await loadProfile(config);
  router.setPurposes(
    new Map<string, ModelRef[]>(
      Object.entries(profile.manifest.llm.purposes).map(([name, chain]) => [
        name,
        chain.map(parseModelRef),
      ]),
    ),
  );
  const first = router.chain(purpose)[0];
  const label = first === undefined ? "" : modelRefString(first);
  const price = pricing.get(label);
  return {
    router,
    price: price === undefined ? null : PricingSchema.parse(price),
    label,
    reasoning: router.reasoningFor(purpose, { messages: [] }),
  };
}

function parseSince(text: string | undefined, fallback: ReturnType<typeof toTimestamp>) {
  if (text === undefined) return fallback;
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new MemoryCommandError(t.memory.badSince(text));
  return toTimestamp(at);
}

function parseMaxUsd(text: string | undefined): number {
  if (text === undefined) return DEFAULT_MAX_USD;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    throw new MemoryCommandError(t.memory.badMaxUsd(text));
  }
  return n;
}

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const count = (n: number) => t.common.int(n);

/** `miyoria memory rebuild [file]`. */
export async function rebuildCommand(
  configPath: string,
  options: RebuildCommandOptions,
  seams: RebuildSeams = {},
): Promise<void> {
  quietLogs();
  const config = await loadConfig(configPath);
  const path =
    options.file !== undefined
      ? resolve(options.file)
      : await configuredDatabase(config, configPath);
  if (!existsSync(path)) throw new MemoryCommandError(t.memory.noDatabase(path));
  const maxUsd = parseMaxUsd(options.maxUsd);
  const profile = profileId(config);
  const notes = await loadNotes();
  const since = parseSince(options.since, notes.REBUILD_SINCE);

  if (options.apply && !options.force) {
    const held = seams.held ?? (await import("@miyoria/store")).heldFiles;
    const open = held([path, `${path}-wal`, `${path}-shm`]);
    if (open.length > 0) {
      throw new MemoryCommandError(t.memory.held);
    }
  }

  const model = await (seams.model ?? ((c, apply) => modelOfConfig(c, apply)))(
    config,
    options.apply,
  );
  const { SqliteStore } = await import("@miyoria/store");
  const { memoryTables } = await import("../../../memory/memory/src/tables.js");
  const store = await SqliteStore.open(path, { plugins: [notes.notesTables, memoryTables] });
  const embedder = await (seams.embedder ?? embedderOfConfig)(config);
  try {
    const store_ = store.plugin(notes.notesTables);
    const vectorModel = embedder.enabled ? notes.modelOf(embedder) : null;
    /** How many lines wait for a vector, as one line of the report. */
    const waitingLine = () => {
      if (vectorModel === null) {
        return t.memory.vectorsOff;
      }
      const c = store_.vectorCounts(vectorModel);
      return (
        t.memory.vectorsWaiting(count(c.waiting), count(c.lines)) + dim(t.memory.aside(vectorModel))
      );
    };
    const cursors = store_.cursors();
    if (cursors === null) throw new MemoryCommandError(t.memory.noEvents);
    const plan = await notes.planRebuild(store.events, cursors, { since });
    const reasoning = model.reasoning ?? "off";
    const estimate = notes.estimateRebuild(plan, model.price, reasoning);

    section(t.memory.section(path));
    note(t.memory.scope(plan.since, options.apply));
    println(t.memory.sessions(count(plan.sessions.length)));
    println(t.memory.lines(count(plan.lines)));
    println(
      t.memory.segments(
        count(estimate.segments),
        count(plan.sessions.reduce((n, s) => n + s.done, 0)),
      ),
    );
    const skipped = plan.sessions.filter((s) => s.unplaced);
    if (skipped.length > 0) println(dim(t.memory.unplaced(skipped.length)));
    println(
      t.memory.estimate(count(estimate.prompt_tokens), count(estimate.completion_tokens)) +
        (reasoning === "off" ? "" : dim(t.memory.withReasoning(reasoning))),
    );
    println(
      t.memory.cost(estimate.usd === null ? null : usd(estimate.usd)) +
        (model.label === "" ? "" : dim(t.memory.aside(model.label))),
    );
    println(waitingLine());
    if (!options.apply) {
      println();
      println(dim(t.memory.applyHint(usd(DEFAULT_MAX_USD))));
      return;
    }
    if (model.price === null) {
      throw new MemoryCommandError(t.memory.noPrice(model.label === "" ? null : model.label));
    }
    if (estimate.usd !== null && estimate.usd > maxUsd) {
      warn(t.memory.overBudget(usd(estimate.usd), usd(maxUsd)));
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    const index = embedder.enabled ? new notes.NotesIndex({ notes: store_, embedder }) : null;
    try {
      const memory = await memoryConfigOf(config);
      const search = new notes.NotesSearch({
        notes: store_,
        index,
        ranking: () => notes.rankingOf(memory),
        // Nobody waits on a rebuild: the first query also waits for the model to load.
        wait: () => ({ text: REBUILD_VECTOR_WAIT_MS, voice: REBUILD_VECTOR_WAIT_MS }),
      });
      const report = await notes.applyRebuild(plan, {
        router: model.router,
        notes: store_,
        search,
        episodes: notes.rebuildEpisodeSink(store, profile, store_.resolver(), plan),
        cursor: cursors,
        price: model.price,
        maxUsd,
        purpose: REBUILD_PURPOSE,
        signal: controller.signal,
        marker: { settings: store.settings, profile },
        onSegment: (done, of) => {
          if (done % 10 === 0 || done === of) println(dim(`  ${done} / ${of}`));
        },
      });
      println();
      println(
        t.memory.result(
          bold(t.memory.resultLabel),
          report.status,
          report.segments,
          report.total,
          report.empty,
          report.abandoned,
        ),
      );
      println(t.memory.written(report.written, report.dropped, report.episodes));
      println(
        t.memory.usage(
          report.usage.calls,
          count(report.usage.prompt_tokens),
          count(report.usage.completion_tokens),
          usd(report.usd),
        ),
      );
      if (index !== null && (report.status === "done" || report.status === "budget")) {
        const v = await notes.rebuildVectors(index, {
          signal: controller.signal,
          onBatch: (done, waiting) => println(dim(t.memory.vectorBatch(done, waiting))),
        });
        const why =
          v.status === "off"
            ? t.memory.whyOff
            : v.status === "stalled"
              ? t.memory.whyStalled
              : v.status === "aborted"
                ? t.memory.whyAborted
                : null;
        println(t.memory.vectorsAdded(count(v.done), v.waiting > 0 ? count(v.waiting) : null, why));
      } else {
        println(waitingLine());
      }
      if (report.status === "done") {
        ok(t.memory.done);
        note(t.memory.doneNote);
      } else if (report.status === "budget") warn(t.memory.budgetStop);
      else if (report.status === "aborted") warn(t.memory.aborted);
      else {
        throw new MemoryCommandError(t.memory.modelError(report.error ?? null));
      }
    } finally {
      process.off("SIGINT", stop);
      index?.close();
    }
  } finally {
    await embedder.close?.();
    store.close();
  }
}
