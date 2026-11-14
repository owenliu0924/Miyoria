import { resolve } from "node:path";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { type JsonValue, REASONING_LEVELS, serviceKey } from "@miyoria/types";
import { z } from "zod";
import {
  CALL_LOG_PRUNE_INTERVAL_MS,
  CallLogConfigSchema,
  type LlmCallSink,
  LlmCallWriter,
} from "./call-writer.js";
import { LlmCallLog, MAX_CALLS } from "./calls.js";
import { BudgetConfigSchema, PricingSchema } from "./cost.js";
import { LlmRouter } from "./router.js";
import { type ChatProvider, LlmError, type ModelRef, ModelRefSchema } from "./types.js";

/**
 * `[llm.providers.<name>]`: `kind` picks the factory; `base_url` and `api_key` are common;
 * every other key is provider-specific (`extra`).
 */
export interface ProviderConfig {
  kind: string;
  base_url: string | null;
  api_key: string | null;
  extra: Record<string, JsonValue>;
}

export const ProviderConfigSchema = z
  .looseObject({
    kind: z.string(),
    base_url: z.string().nullable().optional(),
    api_key: z.string().nullable().optional(),
  })
  .transform(
    ({ kind, base_url, api_key, ...extra }): ProviderConfig => ({
      kind,
      base_url: base_url ?? null,
      api_key: api_key ?? null,
      extra: extra as Record<string, JsonValue>,
    }),
  );

/**
 * The top-level `[llm]` section (not `[modules.llm]`).
 *
 * ```toml
 * [llm.providers.deepseek]
 * kind = "deepseek"
 * api_key = "${DEEPSEEK_API_KEY}"
 *
 * [llm.purposes]
 * chat = ["deepseek:deepseek-chat"]
 *
 * [llm.pricing."deepseek:deepseek-chat"]   # USD per million tokens
 * input_per_mtok = 0.27
 * cached_input_per_mtok = 0.07
 * output_per_mtok = 1.10
 *
 * [llm.budget]
 * daily_usd = 2.0
 *
 * [llm.reasoning]  # off | low | medium | high, per reasoning purpose (defaults: §3.10)
 * chat_text = "off"
 * plan = "medium"
 *
 * [llm.thinking]   # legacy on / off per purpose, for purposes [llm.reasoning] does not list
 * mind = true
 *
 * [llm.image_input]   # which models take images; unlisted: yes
 * "ollama" = false
 *
 * [llm.call_log]      # every routed call, one JSONL line, <dir>/<UTC day>.jsonl
 * enabled = true
 * dir = "data/llm-calls"
 * keep_days = 14
 * max_mb_per_day = 512
 * bodies = true
 * ```
 */
export const LlmConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  purposes: z.record(z.string(), z.array(ModelRefSchema)).default({}),
  /** Prices keyed by `provider:model`; unpriced models cost 0. */
  pricing: z.record(z.string(), PricingSchema).default({}),
  budget: BudgetConfigSchema.prefault({}),
  /**
   * Whether reasoning models think before answering, per purpose. Unlisted purposes do not:
   * thinking adds seconds before the first word, which matters more for her than depth.
   */
  thinking: z.record(z.string(), z.boolean()).default({}),
  /**
   * How deeply reasoning models think, per reasoning purpose (`chat_voice`, `chat_text`,
   * `chat_intent`, `fast`, `appraise`, `plan`, `plan_daily`, `reflect`, `review`,
   * `summarizer`, or any model purpose). Unlisted ones use `[llm.thinking]`, then the defaults
   * (`DEFAULT_REASONING`: chat off, `chat_intent` / `appraise` low, `plan` / `review` medium,
   * `plan_daily` / `reflect` high).
   */
  reasoning: z.record(z.string(), z.enum(REASONING_LEVELS)).default({}),
  /**
   * Whether a model takes image parts, keyed by `provider:model` or `provider` (the model entry
   * wins). Unlisted models do; a model that refuses them gets text from then on anyway.
   */
  image_input: z.record(z.string(), z.boolean()).default({}),
  /**
   * Every routed call written to `<dir>/<UTC day>.jsonl` (relative to the config file's
   * directory), with the request and response unless `bodies = false` or the day passed
   * `max_mb_per_day`. Holds what people said, so it stays on this machine; `keep_days` of files
   * are kept.
   */
  call_log: CallLogConfigSchema.prefault({}),
});
export type LlmConfig = z.output<typeof LlmConfigSchema>;

/** Builds providers of some `kind`s. Provider packages export one; the app passes them in. */
export interface ProviderFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings (the module then fails to start). */
  build(name: string, config: ProviderConfig): ChatProvider;
}

export const LlmRouterKey = serviceKey<LlmRouter>("LlmRouter");

/** How often unsaved usage totals are written to the store. */
export const USAGE_FLUSH_INTERVAL_MS = 5_000;

export interface LlmModuleOptions {
  /** Purpose overrides from the active profile (`profile.toml` `[llm.purposes]`). */
  purposeOverrides?: ReadonlyMap<string, ModelRef[]>;
  /** Base directory of a relative `[llm.call_log] dir` (the config file's directory). */
  baseDir?: string;
}

/** Module `llm`: builds providers from `[llm]` and provides the `LlmRouter`. */
export class LlmModule implements Module {
  static readonly ID = "llm";
  readonly manifest = defineManifest(LlmModule.ID, "LLM", {
    description: "Model providers and purpose-based routing",
  });
  readonly #config: LlmConfig;
  readonly #factories: readonly ProviderFactory[];
  readonly #overrides: ReadonlyMap<string, ModelRef[]>;
  /** Router of the running module, flushed on stop. */
  #router: LlmRouter | undefined;
  /** The call inspector's log; outlives restarts of the module. */
  readonly #calls = new LlmCallLog();
  readonly #baseDir: string;
  /** The on-disk call log of the running module, closed on stop. */
  #writer: LlmCallWriter | undefined;
  /** Today's calls from before this process were loaded into `#calls` (once per process). */
  #preloaded = false;

  constructor(
    config: LlmConfig,
    factories: readonly ProviderFactory[],
    options: LlmModuleOptions = {},
  ) {
    this.#config = config;
    this.#factories = factories;
    this.#overrides = options.purposeOverrides ?? new Map();
    this.#baseDir = options.baseDir ?? process.cwd();
  }

  /** The router; `sink` receives every finished call (the running module's on-disk log). */
  buildRouter(sink?: LlmCallSink): LlmRouter {
    const providers = new Map<string, ChatProvider>();
    for (const [name, cfg] of Object.entries(this.#config.providers)) {
      const factory = this.#factories.find((f) => f.kinds.includes(cfg.kind));
      if (!factory) throw new LlmError(`provider \`${name}\`: unknown kind \`${cfg.kind}\``);
      providers.set(name, factory.build(name, cfg));
    }
    const router = new LlmRouter(providers, new Map(Object.entries(this.#config.purposes)), {
      pricing: new Map(Object.entries(this.#config.pricing)),
      budget: this.#config.budget,
      thinking: new Map(Object.entries(this.#config.thinking)),
      reasoning: new Map(Object.entries(this.#config.reasoning)),
      imageInput: new Map(Object.entries(this.#config.image_input)),
      calls: this.#calls,
      ...(sink ? { sink } : {}),
    });
    router.setPurposes(this.#overrides);
    return router;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = this.#config.call_log;
    const writer = cfg.enabled
      ? new LlmCallWriter({
          dir: resolve(this.#baseDir, cfg.dir),
          keepDays: cfg.keep_days,
          maxBytesPerDay: cfg.max_mb_per_day * 1024 * 1024,
          bodies: cfg.bodies,
          clock: ctx.clock,
        })
      : undefined;
    const router = this.buildRouter(writer);
    router.setEventSink((event) => ctx.publish(event));
    const store = ctx.services.get(SettingsStoreKey);
    if (store) {
      try {
        await router.attachStore(store);
      } catch (error) {
        ctx.log.warn(
          { err: errorMessage(error) },
          "could not load persisted LLM usage, starting from zero",
        );
      }
      ctx.spawn("usage-flush", async (signal) => {
        for await (const _ of interval(USAGE_FLUSH_INTERVAL_MS, signal)) {
          try {
            await router.flush();
          } catch (error) {
            ctx.log.warn({ err: errorMessage(error) }, "could not persist LLM usage");
          }
        }
      });
    }
    if (writer) {
      this.#writer = writer;
      ctx.spawn("call-log", async (signal) => {
        await writer.prune();
        if (!this.#preloaded) {
          this.#preloaded = true;
          const restored = this.#calls.restore(await writer.recent(MAX_CALLS));
          if (restored > 0) ctx.log.info({ calls: restored }, "loaded today's LLM calls from disk");
        }
        for await (const _ of interval(CALL_LOG_PRUNE_INTERVAL_MS, signal)) await writer.prune();
      });
    }
    this.#router = router;
    router.announceBudget();
    ctx.provide(LlmRouterKey, router);
  }

  async stop(): Promise<void> {
    const router = this.#router;
    const writer = this.#writer;
    this.#router = undefined;
    this.#writer = undefined;
    try {
      await router?.flush();
    } finally {
      await writer?.close();
    }
  }
}
