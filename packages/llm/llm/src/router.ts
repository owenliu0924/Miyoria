import { errorMessage, getLogger, type MetricsRegistry } from "@miyoria/runtime/kernel";
import type { LlmCallStore } from "@miyoria/store";
import {
  type Clock,
  newId,
  type ReasoningLevel,
  reasoningEnabled,
  reasoningFor,
  systemClock,
} from "@miyoria/types";
import type { LlmCallSink, LlmLoggedResponse } from "./call-writer.js";
import { callUsage, LlmCallLog, type LlmCallRecord, type LlmFallback } from "./calls.js";
import {
  type BudgetConfig,
  type BudgetState,
  budgetConfig,
  type CostReport,
  CostTracker,
  type EventSink,
  type Pricing,
} from "./cost.js";
import {
  DEFAULT_KEY_BREAKER,
  type KeyAttempt,
  type KeyBreakerSettings,
  KeyPool,
  type KeyStatus,
  type ProviderKeys,
} from "./keys.js";
import { errorKind, type LlmMetrics, llmMetrics } from "./metrics.js";
import { collectRetries, currentLlmTag, type LlmCallTag } from "./trace.js";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  collectResponse,
  hasImages,
  type KeyChooser,
  LlmError,
  type ModelRef,
  modelRefString,
  NoImageModelError,
  ProviderCoolingError,
  ProviderHttpError,
  type StreamEvent,
  type ToolCall,
  textOnlyRequest,
  tryParseModelRef,
  type Usage,
} from "./types.js";

const log = getLogger("llm.router");

/** Calls and tokens per `provider:model` since startup. */
export interface UsageRecord {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

export interface LlmRouterOptions {
  /** Prices keyed by `provider:model`; unpriced models cost 0. */
  pricing?: ReadonlyMap<string, Pricing>;
  budget?: BudgetConfig;
  /** Replaces the cost tracker (tests with a fake clock). */
  tracker?: CostTracker;
  /** Where call, token, cost, latency and error metrics go. Default: the process-wide one. */
  metrics?: MetricsRegistry;
  /** Clock of the first-token latency. Default: the system clock. */
  clock?: Clock;
  /** `[llm.reasoning]`: the reasoning level per (reasoning) purpose. */
  reasoning?: ReadonlyMap<string, ReasoningLevel>;
  /**
   * `[llm.image_input]`: whether a model takes image parts, keyed by `provider:model` or by
   * `provider` (the model entry wins). Unlisted models do.
   */
  imageInput?: ReadonlyMap<string, boolean>;
  /** Where calls are recorded for the inspector (kept across module restarts by the module). */
  calls?: LlmCallLog;
  /** Where every finished call also goes (the on-disk call log). */
  sink?: LlmCallSink;
  /** Breaker settings per provider name (`[llm.providers.<name>]`); default `DEFAULT_KEY_BREAKER`. */
  breakers?: ReadonlyMap<string, KeyBreakerSettings>;
}

/** HTTP statuses with which a provider may refuse image parts it does not support. */
const IMAGE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

function rejectsImages(error: unknown): error is ProviderHttpError {
  return error instanceof ProviderHttpError && IMAGE_REJECTION_STATUSES.has(error.status);
}

/** One routed call while it streams. */
interface Call {
  key: string;
  purpose: string;
  /** When `LlmRouter.stream` was called (before any fallback). */
  requestedAt: number;
  /** When the request to the answering model was sent. */
  sentAt: number;
  firstTokenAt: number | null;
  /** Its entry in the call log. */
  record: LlmCallRecord;
  /** The request as sent to the answering model. */
  request: ChatRequest;
  tag: LlmCallTag | undefined;
  /** Not the model the purpose normally gets: see `RoutedStream.fallback`. */
  fallback: boolean;
}

/**
 * The stream `LlmRouter.stream` returns: a `ChatStream` that also tells which model answered
 * and how long the first token took.
 */
export class RoutedStream implements AsyncIterable<StreamEvent> {
  readonly #call: Call;
  readonly #events: AsyncGenerator<StreamEvent>;

  /** @internal Created by `LlmRouter.stream`. */
  constructor(call: Call, events: AsyncGenerator<StreamEvent>) {
    this.#call = call;
    this.#events = events;
  }

  /** `provider:model` that is answering. */
  get model(): string {
    return this.#call.key;
  }

  /**
   * A fallback model is answering: one earlier in the chain failed, or the budget replaced the
   * chain (`[llm.budget.fallback]`). What it writes passed none of the checks the first choice
   * was tried against, so the output review treats it as its own path.
   */
  get fallback(): boolean {
    return this.#call.fallback;
  }

  /**
   * Milliseconds from the `stream` call to the first text or reasoning delta, including time
   * spent on models that failed before it; `null` until one arrives.
   */
  get firstTokenMs(): number | null {
    const at = this.#call.firstTokenAt;
    return at === null ? null : Math.max(0, at - this.#call.requestedAt);
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this.#events;
  }
}

/**
 * Routes requests by purpose (`chat`, `fast`, `summarizer`, `game`, `vision`, ...) to a chain
 * of models, falling back to the next model if one fails before producing any output.
 * Provided as the `LlmRouterKey` service by the `llm` module.
 */
export class LlmRouter {
  readonly #providers: ReadonlyMap<string, ChatProvider>;
  readonly #purposes: Map<string, ModelRef[]>;
  readonly #usage = new Map<string, UsageRecord>();
  readonly #cost: CostTracker;
  readonly #metrics: LlmMetrics;
  readonly #clock: Clock;
  readonly #reasoning: ReadonlyMap<string, ReasoningLevel>;
  readonly #imageInput: ReadonlyMap<string, boolean>;
  /** Models that refused image parts in this run (`provider:model`); they get text from now on. */
  readonly #refusedImages = new Set<string>();
  readonly #calls: LlmCallLog;
  readonly #sink: LlmCallSink | undefined;
  /** Each provider's keys and their breakers, on this router's clock. */
  readonly #pools = new Map<string, KeyPool>();

  constructor(
    providers: ReadonlyMap<string, ChatProvider>,
    purposes: ReadonlyMap<string, ModelRef[]>,
    options: LlmRouterOptions = {},
  ) {
    this.#providers = providers;
    this.#purposes = new Map(purposes);
    this.#cost =
      options.tracker ?? new CostTracker(options.pricing, options.budget ?? budgetConfig());
    this.#metrics = llmMetrics(options.metrics);
    this.#clock = options.clock ?? systemClock;
    this.#reasoning = options.reasoning ?? new Map();
    this.#imageInput = options.imageInput ?? new Map();
    this.#calls = options.calls ?? new LlmCallLog();
    this.#sink = options.sink;
    for (const [name, provider] of providers) {
      const settings = options.breakers?.get(name) ?? DEFAULT_KEY_BREAKER;
      this.#pools.set(name, new KeyPool(name, provider.keyCount ?? 0, settings, this.#clock));
    }
  }

  /**
   * Each provider's keys by position: `ok`, `cooling` (until when) or `bad` (refused), and the
   * last failure. A provider without keys has one entry standing for itself.
   */
  providerKeys(): ProviderKeys[] {
    return [...this.#pools.values()].map((p) => p.status());
  }

  /** Names of the providers, in config order. */
  providerNames(): string[] {
    return [...this.#providers.keys()];
  }

  /** Whether provider `name` can change its keys without a restart. */
  takesKeys(name: string): boolean {
    return typeof this.#providers.get(name)?.setKeys === "function";
  }

  /** Whether provider `name` can test a key (`ChatProvider.check`). */
  testsKeys(name: string): boolean {
    return typeof this.#providers.get(name)?.check === "function";
  }

  /** The breaker state of key `id` of provider `name` while it is in rotation, else `null`. */
  keyStatus(name: string, id: string): KeyStatus | null {
    return this.#pools.get(name)?.statusOf(id) ?? null;
  }

  /**
   * Provider `name` sends with `keys` (in this order) from its next request on, and its pool is
   * rebuilt in place: a key that stays (same `id`) keeps its breaker state. Throws `LlmError` for
   * an unknown provider or one that cannot change keys while running.
   */
  setProviderKeys(name: string, keys: readonly { id: string; value: string }[]): void {
    const provider = this.#providers.get(name);
    const pool = this.#pools.get(name);
    if (!provider || !pool) throw new LlmError(`unknown provider \`${name}\``);
    if (typeof provider.setKeys !== "function") {
      throw new LlmError(`provider \`${name}\` cannot change its keys while running`);
    }
    // Both in the same turn: no request starts between them.
    provider.setKeys(keys.map((k) => k.value));
    pool.reshape(keys.map((k) => k.id));
  }

  /** The model a key of provider `name` is tested on: its first in the purposes' chains. */
  testModel(name: string): string | null {
    for (const chain of this.#purposes.values()) {
      const model = chain.find((m) => m.provider === name);
      if (model) return model.model;
    }
    return null;
  }

  /**
   * Whether `key` works with provider `name` (`ChatProvider.check` on `testModel`). Throws
   * `LlmError` when the provider cannot test keys or no purpose uses it; else rejects with what
   * the request failed with.
   */
  async checkKey(
    name: string,
    key: string,
    signal?: AbortSignal,
    label?: string,
  ): Promise<{ model: string }> {
    const provider = this.#providers.get(name);
    if (!provider) throw new LlmError(`unknown provider \`${name}\``);
    if (typeof provider.check !== "function") {
      throw new LlmError(`provider \`${name}\` cannot test a key`);
    }
    const model = this.testModel(name);
    if (model === null) throw new LlmError(`no purpose uses provider \`${name}\``);
    await provider.check(key, model, signal, label);
    return { model };
  }

  /**
   * Whether `model` takes image parts: not after it refused them in this run, else
   * `[llm.image_input]` for the model, then for its provider; unlisted models do.
   */
  modelTakesImages(model: ModelRef): boolean {
    const key = modelRefString(model);
    if (this.#refusedImages.has(key)) return false;
    return this.#imageInput.get(key) ?? this.#imageInput.get(model.provider) ?? true;
  }

  /**
   * Whether a request for `purpose` would reach a model that looks at images (the first model
   * of the chain in use), so callers can skip preparing images nobody sees.
   */
  takesImages(purpose: string): boolean {
    const first = this.#chainForState(purpose, this.#cost.state())[0];
    return first !== undefined && this.modelTakesImages(first);
  }

  /**
   * The reasoning level of a request for `purpose`: `request.reasoning` when set; an explicit
   * `request.thinking` (older callers: `false` = `off`, `true` = the configured level, at least
   * `medium`); else for its reasoning purpose (`request.reasoning_purpose`, default `purpose`)
   * `[llm.reasoning]`, then the §3.10 defaults; purposes nobody lists do not reason.
   */
  reasoningFor(purpose: string, request: ChatRequest): ReasoningLevel {
    if (request.reasoning != null) return request.reasoning;
    const key = request.reasoning_purpose ?? purpose;
    const configured = this.#configuredLevel(key);
    if (request.thinking === false) return "off";
    if (request.thinking === true) return configured === "off" ? "medium" : configured;
    return configured;
  }

  #configuredLevel(key: string): ReasoningLevel {
    const set = this.#reasoning.get(key);
    if (set !== undefined) return set;
    return reasoningFor(key);
  }

  /** Overrides purposes, e.g. with the active profile's `[llm.purposes]`. */
  setPurposes(overrides: ReadonlyMap<string, ModelRef[]>): void {
    for (const [purpose, chain] of overrides) this.#purposes.set(purpose, chain);
  }

  /** The chain of `purpose`, or of `chat` when the purpose is not configured. */
  chain(purpose: string): ModelRef[] {
    return [...(this.#purposes.get(purpose) ?? this.#purposes.get("chat") ?? [])];
  }

  hasPurpose(purpose: string): boolean {
    return this.chain(purpose).length > 0;
  }

  /** Whether `purpose` has a chain of its own (not just the `chat` fallback). */
  configures(purpose: string): boolean {
    return (this.#purposes.get(purpose)?.length ?? 0) > 0;
  }

  /** The purpose whose chain a request for `purpose` uses (`chat` if unconfigured). */
  #effectivePurpose(purpose: string): string {
    return this.#purposes.has(purpose) ? purpose : "chat";
  }

  /** The configured fallback while degraded or exhausted, else the normal chain. */
  #chainForState(purpose: string, state: BudgetState): ModelRef[] {
    if (state !== "ok") {
      const fallback = this.#cost.fallbackChain(this.#effectivePurpose(purpose));
      if (fallback && fallback.length > 0) return [...fallback];
    }
    return this.chain(purpose);
  }

  /** Usage per `provider:model` since startup. */
  usage(): Map<string, UsageRecord> {
    return new Map([...this.#usage].map(([k, v]) => [k, { ...v }]));
  }

  /** Spend so far today and this month, per model, plus the budget state. */
  costReport(): CostReport {
    return this.#cost.report();
  }

  /** Current budget state (re-evaluated, so day rollovers are applied). */
  budgetState(): BudgetState {
    return this.#cost.state();
  }

  /** Publishes the current budget state as an `llm.budget` event. */
  announceBudget(): void {
    this.#cost.announce();
  }

  /** Where budget events (`llm.budget`) are published. */
  setEventSink(sink: EventSink): void {
    this.#cost.setSink(sink);
  }

  /**
   * Adds the spending of the current day and month that the event log holds (`llm.call` events
   * of earlier runs). Call once, after `setEventSink` and before the first call.
   */
  restoreUsage(calls: LlmCallStore): Promise<void> {
    return this.#cost.restore(calls);
  }

  /**
   * Streams a response for `purpose` (falls back to `chat` if the purpose is not configured).
   * `request.model` is overwritten.
   *
   * Rejects with `BudgetExhaustedError` when the budget is used up and `on_exhausted = "stop"`
   * (unless the purpose is exempt). While degraded or exhausted the `[llm.budget.fallback]`
   * chain replaces the normal one.
   *
   * With `request.requires_images` images are never stripped: models known not to take them are
   * skipped, and `NoImageModelError` is thrown when none of the chain does.
   */
  async stream(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<RoutedStream> {
    const requestedAt = this.#clock.now();
    const tag = currentLlmTag();
    const level = this.reasoningFor(purpose, request);
    const record = this.#calls.open(
      newId(),
      new Date(requestedAt).toISOString(),
      purpose,
      this.#effectivePurpose(purpose),
      request,
      reasoningEnabled(level),
      tag,
      level,
    );
    tag?.onCall?.({ id: record.id, cost_usd: null, status: record.status });
    /** The request last sent (or about to be). */
    let sent = request;
    const fail = (error: unknown): never => {
      record.status = signal?.aborted ? "aborted" : "error";
      record.error = errorMessage(error);
      record.error_kind = errorKind(error);
      record.total_ms = Math.max(0, this.#clock.now() - requestedAt);
      this.#finish(record, sent, null);
      tag?.onCall?.({ id: record.id, cost_usd: null, status: record.status });
      throw error;
    };
    let state: BudgetState;
    try {
      state = this.#cost.gate(purpose);
    } catch (error) {
      return fail(error);
    }
    const chain = this.#chainForState(purpose, state);
    const budgetChain =
      state !== "ok" &&
      (this.#cost.fallbackChain(this.#effectivePurpose(purpose))?.length ?? 0) > 0;
    if (chain.length === 0) {
      return fail(
        new LlmError(`no model configured for purpose \`${purpose}\` (and no \`chat\` fallback)`),
      );
    }
    const required = request.requires_images === true;
    /** Models of the chain that cannot take this request's images. */
    let blind = 0;
    let refusedWith: number | null = null;
    let lastError: unknown;
    /** The fallback entry of `lastError`. */
    let lastEntry: LlmFallback | undefined;
    /** The first model skipped because every key of its provider was cooling. */
    let cooled: ModelRef | null = null;
    /** Providers this call sent a request to. */
    const asked = new Set<string>();
    // The chain, then, when nothing in it answered, the cooled model once as a last resort.
    const plan = function* (): Generator<{ model: ModelRef; lastResort: boolean }> {
      for (const model of chain) yield { model, lastResort: false };
      const resort = cooled as ModelRef | null;
      if (resort !== null && !signal?.aborted) yield { model: resort, lastResort: true };
    };
    for (const { model, lastResort } of plan()) {
      const key = modelRefString(model);
      record.model = key;
      record.provider = model.provider;
      const provider = this.#providers.get(model.provider);
      if (!provider) {
        log.warn({ model: key }, "unknown provider in model chain");
        lastError = new LlmError(`unknown provider \`${model.provider}\``);
        lastEntry = { model: key, error: errorMessage(lastError), kind: "error" };
        record.fallbacks.push(lastEntry);
        continue;
      }
      if (required && !this.modelTakesImages(model)) {
        blind++;
        record.fallbacks.push({ model: key, error: "does not take images", kind: "error" });
        continue;
      }
      const pool = this.#pools.get(model.provider) as KeyPool;
      if (!lastResort && !pool.usable()) {
        // Its keys failed just now: straight to the next model, without waiting on it again.
        const error = new ProviderCoolingError(model.provider, pool.reopensAt());
        const entry: LlmFallback = { model: key, error: errorMessage(error), kind: "cooling" };
        record.fallbacks.push(entry);
        if (pool.keyed) {
          for (const k of pool.status().keys) {
            record.keys.push({
              provider: model.provider,
              key: k.key,
              result: "skipped",
              kind: k.state === "bad" ? "bad" : "cooling",
            });
          }
        }
        this.#metrics.errors.inc({ model: key, purpose, stage: "request", kind: "cooling" });
        // What a model that was asked said tells more than that another was skipped.
        if (lastError === undefined || lastError instanceof ProviderCoolingError) {
          lastError = error;
          lastEntry = entry;
        }
        // A provider this call already waited on gets no last resort.
        if (!asked.has(model.provider)) cooled ??= model;
        continue;
      }
      asked.add(model.provider);
      if (lastResort) {
        log.warn({ model: key }, "every key is cooling and nothing else is left, trying it once");
      }
      const onAttempt = (a: KeyAttempt, counted: boolean) => {
        if (pool.keyed) record.keys.push(a);
        if (counted && a.kind !== null) {
          this.#metrics.errors.inc({ model: key, purpose, stage: "key", kind: a.kind });
        }
      };
      /** One `provider.stream`, with its own pick of keys. */
      const open = async (req: ChatRequest) => {
        const keys = pool.chooser(lastResort, onAttempt);
        try {
          return await this.#open(provider, req, signal, keys);
        } finally {
          keys.close();
        }
      };
      let iterator: AsyncIterator<StreamEvent>;
      let first: IteratorResult<StreamEvent>;
      const sentAt = this.#clock.now();
      let routed: ChatRequest = {
        ...request,
        model: model.model,
        thinking: reasoningEnabled(level),
        reasoning: level,
      };
      const images = hasImages(routed.messages);
      if (images && !this.modelTakesImages(model)) routed = textOnlyRequest(routed);
      sent = routed;
      try {
        try {
          [iterator, first] = await collectRetries(record.retries, () => open(routed));
        } catch (error) {
          // A provider that cannot take image parts: once more as text, and remember it.
          const downgrade =
            !required && images && hasImages(routed.messages) && rejectsImages(error);
          if (signal?.aborted || !downgrade) throw error;
          log.warn(
            { model: key, err: errorMessage(error) },
            "model refused image input, retrying as text",
          );
          record.retries.push("圖片被拒,改用文字");
          const textOnly = textOnlyRequest(routed);
          sent = textOnly;
          [iterator, first] = await collectRetries(record.retries, () => open(textOnly));
          this.#refusedImages.add(key);
          log.warn({ model: key }, "sending this model text only from now on");
        }
      } catch (error) {
        if (signal?.aborted) return fail(error);
        log.warn({ model: key, err: errorMessage(error) }, "model failed, trying next in chain");
        this.#metrics.errors.inc({
          model: key,
          purpose,
          stage: "request",
          kind: errorKind(error),
        });
        lastEntry = { model: key, error: errorMessage(error), kind: errorKind(error) };
        record.fallbacks.push(lastEntry);
        lastError = error;
        if (required && rejectsImages(error)) {
          blind++;
          refusedWith = error.status;
        }
        continue;
      }
      // The answering model is not a fallback.
      record.pricing = this.#cost.priceFor(key);
      const call: Call = {
        key,
        purpose,
        requestedAt,
        sentAt,
        firstTokenAt: null,
        record,
        request: sent,
        tag,
        fallback: budgetChain || record.fallbacks.length > 0,
      };
      this.#metrics.calls.inc({ model: key, purpose });
      if (!first.done) this.#observe(call, first.value);
      return new RoutedStream(call, this.#track(call, first, iterator, signal));
    }
    // The model whose error the call ends with is no fallback.
    const failed = lastEntry ?? record.fallbacks.at(-1);
    if (failed) {
      record.fallbacks.splice(record.fallbacks.lastIndexOf(failed), 1);
      record.model = failed.model;
      record.provider = tryParseModelRef(failed.model)?.provider ?? record.provider;
    }
    if (required && blind === chain.length) {
      return fail(new NoImageModelError(purpose, refusedWith));
    }
    return fail(lastError ?? new LlmError("all models failed"));
  }

  /** Hands a finished call to the sink; a failing sink never fails the call. */
  #finish(record: LlmCallRecord, request: ChatRequest, response: LlmLoggedResponse | null): void {
    if (!this.#sink) return;
    try {
      this.#sink.write({ record, request, response });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "LLM call sink failed");
    }
  }

  /** The call inspector's log (the most recent calls, bounded). */
  get calls(): LlmCallLog {
    return this.#calls;
  }

  /** Every `[llm.pricing]` entry, by `provider:model`. */
  prices(): Record<string, Pricing> {
    return this.#cost.prices();
  }

  /** Starts a response; only failures before the first event count as the model failing. */
  async #open(
    provider: ChatProvider,
    request: ChatRequest,
    signal: AbortSignal | undefined,
    keys: KeyChooser,
  ): Promise<[AsyncIterator<StreamEvent>, IteratorResult<StreamEvent>]> {
    const stream = await provider.stream(request, signal, { keys });
    const iterator = stream[Symbol.asyncIterator]();
    return [iterator, await iterator.next()];
  }

  async complete(
    purpose: string,
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return collectResponse(await this.stream(purpose, request, signal));
  }

  /** Notes the first text or reasoning delta of `call`. */
  #observe(call: Call, ev: StreamEvent): void {
    if (call.firstTokenAt !== null) return;
    if (ev.type !== "text_delta" && ev.type !== "reasoning_delta") return;
    const now = this.#clock.now();
    call.firstTokenAt = now;
    this.#metrics.firstToken.observe(
      { model: call.key, purpose: call.purpose },
      Math.max(0, now - call.sentAt) / 1000,
    );
  }

  #record(call: Call, usage: Usage): number {
    const key = call.key;
    let record = this.#usage.get(key);
    if (!record) {
      record = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0 };
      this.#usage.set(key, record);
    }
    record.calls += 1;
    record.prompt_tokens += usage.prompt_tokens;
    record.completion_tokens += usage.completion_tokens;
    record.cached_prompt_tokens += usage.cached_prompt_tokens ?? 0;
    const cost = this.#cost.record(key, usage);
    const labels = { model: key, purpose: call.purpose };
    const tokens = this.#metrics.tokens;
    tokens.inc({ ...labels, type: "prompt" }, usage.prompt_tokens);
    tokens.inc({ ...labels, type: "completion" }, usage.completion_tokens);
    tokens.inc({ ...labels, type: "cached_prompt" }, usage.cached_prompt_tokens ?? 0);
    this.#metrics.cost.inc(labels, cost);
    return cost;
  }

  async *#track(
    call: Call,
    first: IteratorResult<StreamEvent>,
    rest: AsyncIterator<StreamEvent>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamEvent> {
    let finished = false;
    const record = call.record;
    let text = "";
    let reasoning = "";
    const tools: ToolCall[] = [];
    const end = (status: LlmCallRecord["status"], error: unknown = null) => {
      if (record.status !== "streaming") return;
      record.status = status;
      record.total_ms = Math.max(0, this.#clock.now() - call.requestedAt);
      record.first_token_ms =
        call.firstTokenAt === null ? null : Math.max(0, call.firstTokenAt - call.requestedAt);
      if (error !== null) {
        record.error = errorMessage(error);
        record.error_kind = errorKind(error);
      }
      this.#calls.respond(record.id, text, reasoning, tools);
      this.#finish(record, call.request, { text, reasoning, tool_calls: tools });
      const usage =
        record.usage === null
          ? null
          : {
              prompt_tokens: record.usage.prompt_tokens,
              completion_tokens: record.usage.completion_tokens,
            };
      call.tag?.onCall?.({ id: record.id, cost_usd: record.cost_usd, status, usage });
    };
    try {
      for (let next = first; !next.done; ) {
        const ev = next.value;
        this.#observe(call, ev);
        if (ev.type === "text_delta") text += ev.text;
        else if (ev.type === "reasoning_delta") reasoning += ev.text;
        else if (ev.type === "tool_call_delta") {
          while (tools.length <= ev.index) tools.push({ id: "", name: "", arguments: "" });
          const t = tools[ev.index] as ToolCall;
          if (ev.id !== null) t.id = ev.id;
          if (ev.name !== null) t.name += ev.name;
          t.arguments += ev.arguments;
        } else if (ev.type === "done") {
          record.finish_reason = ev.finish_reason;
          if (ev.usage) {
            record.usage = callUsage(ev.usage);
            record.cost_usd = this.#record(call, ev.usage);
          }
        }
        yield ev;
        try {
          next = await rest.next();
        } catch (error) {
          if (!signal?.aborted) {
            this.#metrics.errors.inc({
              model: call.key,
              purpose: call.purpose,
              stage: "stream",
              kind: errorKind(error),
            });
          }
          end(signal?.aborted ? "aborted" : "error", error);
          throw error;
        }
      }
      finished = true;
      end("ok");
    } finally {
      if (!finished) {
        // The caller stopped reading (or the stream failed, recorded above).
        end(
          record.finish_reason !== null ? "ok" : "aborted",
          record.finish_reason !== null ? null : new LlmError("stopped before the end"),
        );
        await rest.return?.();
      }
    }
  }
}
