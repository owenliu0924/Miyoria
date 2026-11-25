import type { JsonValue, ReasoningLevel } from "@miyoria/types";
import { z } from "zod";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model. */
  arguments: string;
}

export interface TextPart {
  type: "text";
  text: string;
}

/** How closely a vision model looks at an image (OpenAI `detail`); `low` costs least. */
export type ImageDetail = "auto" | "low" | "high";

export interface ImagePart {
  type: "image_url";
  /** `url` is an `https:` URL or a `data:image/...;base64,...` URL. */
  image_url: { url: string; detail: ImageDetail };
  /**
   * Text that stands in for the image when the model cannot take images (never sent along
   * with the image).
   */
  alt?: string;
}

/** One part of a multimodal message (Chat Completions content parts). */
export type ContentPart = TextPart | ImagePart;

/** Plain text, or parts (text and images) for vision models. */
export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: ChatRole;
  /** Images only in `user` messages. */
  content: MessageContent;
  /** Optional speaker name (OpenAI `name` field). */
  name: string | null;
  /** Tool calls made by the assistant in this message. */
  tool_calls: ToolCall[];
  /** For `tool` messages: which call this answers. */
  tool_call_id: string | null;
  /**
   * The model's reasoning for this assistant message. When set and not empty it is sent back
   * with the message (`reasoning_content`), which reasoning models expect between the rounds
   * of a tool loop.
   */
  reasoning?: string | null;
}

/** What stands in for an image without `alt` in text-only form. */
export const IMAGE_PLACEHOLDER = "[圖片]";

/**
 * The content as plain text: text parts joined by line breaks, images replaced by their `alt`
 * (or `[圖片]`).
 */
export function contentText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : (p.alt ?? IMAGE_PLACEHOLDER)))
    .filter((t) => t !== "")
    .join("\n");
}

/** Whether any message carries an image part. */
export function hasImages(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content !== "string" && m.content.some((p) => p.type === "image_url"),
  );
}

/** `request` with every multimodal message flattened to text (`contentText`). */
export function textOnlyRequest(request: ChatRequest): ChatRequest {
  return {
    ...request,
    messages: request.messages.map((m) =>
      typeof m.content === "string" ? m : { ...m, content: contentText(m.content) },
    ),
  };
}

function plain(role: ChatRole, content: MessageContent, name: string | null = null): ChatMessage {
  return { role, content, name, tool_calls: [], tool_call_id: null };
}

export function systemMessage(content: string): ChatMessage {
  return plain("system", content);
}

export function userMessage(content: MessageContent, name: string | null = null): ChatMessage {
  return plain("user", content, name);
}

export function assistantMessage(content: string, toolCalls: ToolCall[] = []): ChatMessage {
  return { ...plain("assistant", content), tool_calls: toolCalls };
}

export function toolResultMessage(callId: string, content: string): ChatMessage {
  return { ...plain("tool", content), tool_call_id: callId };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: JsonValue;
}

/** Everything but `messages` is optional; providers treat a missing field as "not set". */
export interface ChatRequest {
  /**
   * Filled in by the router from the purpose's model chain; providers use it as the model id
   * sent to the API.
   */
  model?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number | null;
  max_tokens?: number | null;
  stop?: string[];
  /** Ask for a JSON object response when the provider supports it. */
  json_mode?: boolean;
  /**
   * Whether a reasoning model thinks before answering. The router fills it from the reasoning
   * level when unset; `false` makes the provider send its "no thinking" switch.
   */
  thinking?: boolean | null;
  /**
   * The request is about its images: the router never strips them, skips models known not to
   * take them, and throws `NoImageModelError` when no model is left.
   */
  requires_images?: boolean;
  /**
   * How deeply a reasoning model thinks (`[llm.reasoning]`, docs/design/v2-architecture.md
   * §3.10). The router fills it (and `thinking` from it); set it to force a level. Providers
   * with an effort parameter send it, the others only switch thinking on / off and cap the
   * length with `max_tokens`.
   */
  reasoning?: ReasoningLevel | null;
  /**
   * The `[llm.reasoning]` entry that decides the level (`chat_text`, `plan`, ...); unset: the
   * model purpose the request is routed by. Reasoning purposes are finer than model purposes
   * (the three `chat_*` all use the `chat` chain).
   */
  reasoning_purpose?: string | null;
  /**
   * Stable id of the conversation this request belongs to (see `contextSession`). Providers
   * may forward it (e.g. as a header) for routing and prompt caching.
   */
  session?: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Prompt tokens served from the provider's prefix cache, if reported. */
  cached_prompt_tokens: number | null;
  /** Completion tokens spent thinking (part of `completion_tokens`), if reported. */
  reasoning_tokens?: number | null;
}

/**
 * One streamed piece of a response. A well-formed stream ends with exactly one `done`.
 * `reasoning_delta` is model "thinking" (e.g. DeepSeek `reasoning_content`): it must never be
 * spoken or sent to chat. It goes back to the model only as `ChatMessage.reasoning`.
 * `tool_call_delta` fragments with the same `index` belong to the same call.
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id: string | null;
      name: string | null;
      arguments: string;
    }
  | { type: "done"; finish_reason: string | null; usage: Usage | null };

/** A response stream. Errors are thrown from the iterator; stop early with `break`. */
export type ChatStream = AsyncIterable<StreamEvent>;

export interface ChatResponse {
  text: string;
  reasoning: string;
  tool_calls: ToolCall[];
  finish_reason: string | null;
  usage: Usage | null;
}

/** Folds a stream into a full response. */
export async function collectResponse(stream: ChatStream): Promise<ChatResponse> {
  const out: ChatResponse = {
    text: "",
    reasoning: "",
    tool_calls: [],
    finish_reason: null,
    usage: null,
  };
  const calls: ToolCall[] = [];
  for await (const ev of stream) {
    switch (ev.type) {
      case "text_delta":
        out.text += ev.text;
        break;
      case "reasoning_delta":
        out.reasoning += ev.text;
        break;
      case "tool_call_delta": {
        while (calls.length <= ev.index) calls.push({ id: "", name: "", arguments: "" });
        const call = calls[ev.index] as ToolCall;
        if (ev.id !== null) call.id = ev.id;
        if (ev.name !== null) call.name += ev.name;
        call.arguments += ev.arguments;
        break;
      }
      case "done":
        out.finish_reason = ev.finish_reason;
        out.usage = ev.usage;
        break;
    }
  }
  out.tool_calls = calls;
  return out;
}

/** Why an attempt on a key failed in a way another key, or a moment later, could fix. */
export type KeyFailure =
  | "connect_timeout"
  | "auth"
  | "rate_limit"
  | "server"
  | "network"
  /** 402: the key's quota or payment. */
  | "quota"
  /** Another 4xx that another key of the same call did not get: the key is the problem. */
  | "rejected";

/** How an attempt on one key ended. */
export type KeyOutcome =
  /** A 2xx response arrived. */
  | { type: "ok" }
  /**
   * It failed in a way the breaker counts; `retryAfterMs`: a 429's `Retry-After`; `message`:
   * what the provider said, with the keys replaced by their positions.
   */
  | { type: "failed"; failure: KeyFailure; retryAfterMs?: number | null; message?: string | null }
  /** Neither: the request itself was refused (4xx), could not be built, or was aborted. */
  | { type: "ended"; kind: string };

/**
 * The API keys of one call (the router's breaker, `keys.ts`). Keys are named by position, from 0.
 * Every key `next` returns gets exactly one `report` per attempt sent with it.
 */
export interface KeyChooser {
  /** The next key to send with, never one already tried in this call; `null`: none left. */
  next(): number | null;
  /**
   * How the attempt on `key` went; whether the same key may be sent again in this call (not
   * once the breaker opened it, unless for a 429, whose `Retry-After` the retry waits out).
   */
  report(key: number, outcome: KeyOutcome): boolean;
  /** Every key is cooling and nothing else is left: one attempt, no retries. */
  readonly lastResort: boolean;
}

export interface StreamOptions {
  /** Which keys to send with; without it a provider tries its keys in order. */
  keys?: KeyChooser;
}

export interface ChatProvider {
  /** Provider instance name from config, e.g. `"deepseek"`. */
  readonly name: string;
  /**
   * How many API keys it sends with (0: none). Providers that set it take their keys from
   * `StreamOptions.keys`; the others are left to themselves.
   */
  readonly keyCount?: number;
  /**
   * Starts a response. Rejects for failures before the stream exists (HTTP errors after
   * retries); later failures are thrown by the stream.
   */
  stream(request: ChatRequest, signal?: AbortSignal, options?: StreamOptions): Promise<ChatStream>;
  /**
   * Sends with these keys from the next request on (keys added or removed in the panel). A
   * provider without it keeps the keys it was built with.
   */
  setKeys?(keys: readonly string[]): void;
  /** One cheap request to `model` with `key` alone, no retries; throws what it failed with. */
  check?(key: string, model: string, signal?: AbortSignal, name?: string): Promise<void>;
}

/** `stream` + `collectResponse`. */
export async function completeChat(
  provider: ChatProvider,
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  return collectResponse(await provider.stream(request, signal));
}

export class LlmError extends Error {
  override name = "LlmError";
}

/** The budget is used up and `on_exhausted = "stop"`. Message: `budget exhausted`. */
export class BudgetExhaustedError extends LlmError {
  override name = "BudgetExhaustedError";

  constructor() {
    super("budget exhausted");
  }
}

/** A non-2xx HTTP response (after retries). The message never contains credentials. */
export class ProviderHttpError extends LlmError {
  override name = "ProviderHttpError";

  constructor(
    message: string,
    readonly status: number,
    /**
     * What the provider said: the body's `error.message` when it is JSON with one, else its start;
     * keys replaced by their positions. `null` when not known.
     */
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

/**
 * A request with `requires_images` found no model that takes them. `status`: the last HTTP status
 * a model refused it with; `null` when every model was known not to take images, so none was asked.
 */
export class NoImageModelError extends LlmError {
  override name = "NoImageModelError";

  constructor(
    purpose: string,
    readonly status: number | null,
  ) {
    super(`no model for purpose \`${purpose}\` takes images`);
  }
}

/**
 * The provider did not answer in time. `connect`: no response headers within the connect
 * timeout (never retried, so the router falls back right away); `idle`: no bytes for the idle
 * timeout.
 */
export class ProviderTimeoutError extends LlmError {
  override name = "ProviderTimeoutError";

  constructor(
    message: string,
    readonly phase: "connect" | "idle",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Every API key of the provider is cooling after recent failures (`keys.ts`), so it was not
 * asked. Its message names the provider, never a key.
 */
export class ProviderCoolingError extends LlmError {
  override name = "ProviderCoolingError";

  constructor(
    readonly provider: string,
    /** When the first key may be tried again (ms), if known. */
    readonly until: number | null = null,
  ) {
    super(
      `${provider}: skipped, every API key is cooling down after recent failures${
        until === null ? "" : ` (until ${new Date(until).toISOString()})`
      }`,
    );
  }
}

/**
 * `provider:model`, e.g. `deepseek:deepseek-chat`. The model part may itself contain `:` (the
 * split happens at the first one).
 */
export interface ModelRef {
  provider: string;
  model: string;
}

/** Parses `provider:model`; returns `null` when either part is empty or `:` is missing. */
export function tryParseModelRef(s: string): ModelRef | null {
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

/** Parses `provider:model`; throws `LlmError`. */
export function parseModelRef(s: string): ModelRef {
  const parsed = tryParseModelRef(s);
  if (!parsed) throw new LlmError(`model reference \`${s}\` must look like \`provider:model\``);
  return parsed;
}

export function modelRefString(m: ModelRef): string {
  return `${m.provider}:${m.model}`;
}

/** Config form: a `"provider:model"` string, parsed into a `ModelRef`. */
export const ModelRefSchema = z
  .string()
  .refine((s) => tryParseModelRef(s) !== null, {
    error: (issue) =>
      `model reference \`${String(issue.input)}\` must look like \`provider:model\``,
  })
  .transform((s) => parseModelRef(s));
