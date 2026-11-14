// Typed client for the admin API, used by the CLI. The routes on the route table
// (`@miyoria/contracts/api`) are not here: the CLI calls those through the contract's client.

import type {
  ActivitySnapshot,
  ActivityTask,
  AffectSnapshot,
  ArbiterVerdict,
  ContextKey,
  Envelope,
  LedgerView,
  PersonCard,
  SavedPrompt,
  ThoughtDigest,
  TurnOutcomeRecord,
} from "@miyoria/types";
import { statusText } from "./errors.js";
import type {
  ArbiterDecisionsView,
  ConversationNoteView,
  DayPlanView,
  ErrorBody,
  GoalsView,
  KnowledgeView,
  MemoryItem,
  MemoryListQuery,
  MemoryRecordView,
  Page,
  PromptSummary,
  ReflectionView,
  SelfView,
  TurnOutcomeKind,
  UpdateMemoryRequest,
  WorldView,
} from "./types.js";

export type ClientErrorKind = "invalid_url" | "transport" | "api" | "decode";

/** Every failure of `ApiClient`. `status` is set for `api` errors (non-success answers). */
export class ClientError extends Error {
  override readonly name = "ClientError";

  private constructor(
    readonly kind: ClientErrorKind,
    message: string,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  static invalidUrl(url: string): ClientError {
    return new ClientError("invalid_url", `invalid API base URL \`${url}\``, null);
  }

  static transport(error: unknown): ClientError {
    let reason = error instanceof Error ? error.message : String(error);
    // `fetch` reports "fetch failed" and keeps the reason (ECONNREFUSED, ...) in `cause`.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error && cause.message !== "") reason = `${reason}: ${cause.message}`;
    return new ClientError("transport", `cannot reach the admin API: ${reason}`, null, {
      cause: error,
    });
  }

  static api(status: number, message: string): ClientError {
    return new ClientError("api", `admin API returned ${statusText(status)}: ${message}`, status);
  }

  static decode(reason: string): ClientError {
    return new ClientError("decode", `invalid event from the admin API: ${reason}`, null);
  }
}

/** Options every call accepts. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** Bus envelopes from `GET /api/events`. Iterate with `for await`; `close()` ends it early. */
export interface EventStream extends AsyncIterableIterator<Envelope> {
  close(): void;
}

/** Minimal Server-Sent Events parser: yields the `data` of each event. */
export class SseParser {
  #line: number[] = [];
  #data = "";
  #hasData = false;
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });

  feed(chunk: Uint8Array): string[] {
    const out: string[] = [];
    for (const byte of chunk) {
      if (byte !== 0x0a) {
        this.#line.push(byte);
        continue;
      }
      if (this.#line[this.#line.length - 1] === 0x0d) this.#line.pop();
      const line = this.#decoder.decode(Uint8Array.from(this.#line));
      this.#line = [];
      if (line === "") {
        if (this.#hasData) {
          out.push(this.#data);
          this.#data = "";
          this.#hasData = false;
        }
      } else if (line.startsWith("data")) {
        // Other fields (`id`, `event`, `retry`) and `:` comments are ignored.
        let value = line.slice(4);
        if (value.startsWith(":")) value = value.slice(1);
        else if (value !== "") continue;
        if (this.#hasData) this.#data += "\n";
        this.#data += value.startsWith(" ") ? value.slice(1) : value;
        this.#hasData = true;
      }
    }
    return out;
  }
}

/** The `ClientError` of a response that is not ok, with the server's message when it sent one. */
export async function responseError(response: Response): Promise<ClientError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let message: string;
  try {
    const parsed = JSON.parse(text) as Partial<ErrorBody>;
    if (typeof parsed.error !== "string") throw new Error("not an error body");
    message = parsed.error;
  } catch {
    message =
      text.trim() !== ""
        ? text.trim()
        : statusText(response.status).split(" ").slice(1).join(" ") || "error";
  }
  return ClientError.api(response.status, message);
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Query = Record<string, string | undefined>;

/** Admin API client. */
export class ApiClient {
  readonly #base: URL;
  readonly #token: string;

  /** `baseUrl` is e.g. `http://127.0.0.1:7878`. Throws `ClientError` (`invalid_url`). */
  constructor(baseUrl: string, token: string) {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      throw ClientError.invalidUrl(baseUrl);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw ClientError.invalidUrl(baseUrl);
    }
    this.#base = base;
    this.#token = token;
  }

  // ---- memory ---------------------------------------------------------------------------

  /**
   * Lists (newest first) or, with `q`, searches her memories (hybrid recall when the memory
   * module runs, full text otherwise).
   */
  memory(query: MemoryListQuery = {}, o?: CallOptions): Promise<Page<MemoryItem>> {
    return this.#json("GET", ["memory"], {
      ...o,
      query: {
        q: query.q,
        kind: query.kind,
        subject: query.subject,
        before: query.before,
        include_superseded: query.include_superseded ? "true" : undefined,
        limit: query.limit === undefined ? undefined : String(query.limit),
      },
    });
  }

  updateMemory(
    id: string,
    request: UpdateMemoryRequest,
    o?: CallOptions,
  ): Promise<MemoryRecordView> {
    return this.#json("PATCH", ["memory", id], { ...o, body: request });
  }

  deleteMemory(id: string, o?: CallOptions): Promise<void> {
    return this.#empty("DELETE", ["memory", id], o);
  }

  // ---- inner life -----------------------------------------------------------------------

  /** Her drives, boredom, policy, agenda, mood and feelings. */
  self(o?: CallOptions): Promise<SelfView> {
    return this.#json("GET", ["self"], o);
  }

  /** What she perceives: people, voice channels, channel activity, her own status. */
  world(o?: CallOptions): Promise<WorldView> {
    return this.#json("GET", ["world"], o);
  }

  // ---- body, arbiter, affect, plan, prompts -----------------------------------------------

  /** Her presence, broadcast, activity and scene. */
  activity(o?: CallOptions): Promise<ActivitySnapshot> {
    return this.#json("GET", ["activity"], o);
  }

  /** Recent activity transition tasks, newest first. */
  activityTasks(limit = 20, o?: CallOptions): Promise<ActivityTask[]> {
    return this.#json("GET", ["activity", "tasks"], { ...o, query: { limit: String(limit) } });
  }

  /** What she did or tried (`context`: entries there first), her limits, topics nobody took up. */
  ledger(context: ContextKey | null = null, limit = 50, o?: CallOptions): Promise<LedgerView> {
    return this.#json("GET", ["arbiter", "ledger"], {
      ...o,
      query: { limit: String(limit), context: context ? JSON.stringify(context) : undefined },
    });
  }

  /** The arbiter's recent verdicts with reasons, newest first (`verdict`: only that kind). */
  arbiterDecisions(
    q: { limit?: number; context?: ContextKey | null; verdict?: ArbiterVerdict } = {},
    o?: CallOptions,
  ): Promise<ArbiterDecisionsView> {
    return this.#json("GET", ["arbiter", "decisions"], {
      ...o,
      query: {
        limit: q.limit === undefined ? undefined : String(q.limit),
        context: q.context ? JSON.stringify(q.context) : undefined,
        verdict: q.verdict,
      },
    });
  }

  /** Her emotions, derived mood, drives and the behaviour biases they imply. */
  affect(o?: CallOptions): Promise<AffectSnapshot> {
    return this.#json("GET", ["affect"], o);
  }

  /** One card per person, highest attachment first. */
  affectPeople(o?: CallOptions): Promise<PersonCard[]> {
    return this.#json("GET", ["affect", "people"], o);
  }

  /** Her goals (`closed`: also the done and dropped ones when the agenda keeps them). */
  goals(closed = false, o?: CallOptions): Promise<GoalsView> {
    return this.#json("GET", ["mind", "goals"], {
      ...o,
      query: { closed: closed ? "true" : undefined },
    });
  }

  /** Today's plan in her words. */
  dayPlan(o?: CallOptions): Promise<DayPlanView> {
    return this.#json("GET", ["mind", "plan"], o);
  }

  /** The saved prompts of recent turns (no text), newest first. */
  prompts(
    context: ContextKey | null = null,
    limit = 30,
    o?: CallOptions,
  ): Promise<PromptSummary[]> {
    return this.#json("GET", ["prompts"], {
      ...o,
      query: { limit: String(limit), context: context ? JSON.stringify(context) : undefined },
    });
  }

  /** The saved prompt of one turn, in full. */
  prompt(turn: string, o?: CallOptions): Promise<SavedPrompt> {
    return this.#json("GET", ["prompts", turn], o);
  }

  /** How turns ended, newest first. */
  turnOutcomes(
    q: { limit?: number; context?: ContextKey | null; outcome?: TurnOutcomeKind } = {},
    o?: CallOptions,
  ): Promise<TurnOutcomeRecord[]> {
    return this.#json("GET", ["turns", "outcomes"], {
      ...o,
      query: {
        limit: q.limit === undefined ? undefined : String(q.limit),
        context: q.context ? JSON.stringify(q.context) : undefined,
        outcome: q.outcome,
      },
    });
  }

  /** Digests of her older thoughts, newest first. */
  digests(limit = 20, o?: CallOptions): Promise<ThoughtDigest[]> {
    return this.#json("GET", ["mind", "digests"], { ...o, query: { limit: String(limit) } });
  }

  /** Her self-organized documents. */
  knowledge(o?: CallOptions): Promise<KnowledgeView> {
    return this.#json("GET", ["knowledge"], o);
  }

  /** Her running notes on each conversation. */
  conversationNotes(o?: CallOptions): Promise<ConversationNoteView[]> {
    return this.#json("GET", ["knowledge", "conversations"], o);
  }

  /** Her reflections, lessons and the feedback of the last `days` days. */
  reflection(days = 7, o?: CallOptions): Promise<ReflectionView> {
    return this.#json("GET", ["reflection"], { ...o, query: { days: String(days) } });
  }

  /**
   * Streams bus envelopes matching `topics` (e.g. `["platform.*", "agent.*"]`; empty means
   * everything). The subscription is active once this resolves; the stream ends when the
   * server stops, `close()` is called or `signal` aborts.
   */
  async events(topics: readonly string[] = [], o?: CallOptions): Promise<EventStream> {
    const controller = new AbortController();
    const signal = o?.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal;
    const response = await this.#send("GET", ["events"], {
      signal,
      query: { topics: topics.length > 0 ? topics.join(",") : undefined },
    });
    const body = response.body;
    if (!body) throw ClientError.transport(new Error("the event stream has no body"));
    const reader = body.getReader();
    const parser = new SseParser();
    const pending: string[] = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      void reader.cancel().catch(() => undefined);
    };
    const stream: EventStream = {
      async next(): Promise<IteratorResult<Envelope>> {
        for (;;) {
          const data = pending.shift();
          if (data !== undefined) {
            try {
              return { value: JSON.parse(data) as Envelope, done: false };
            } catch (error) {
              throw ClientError.decode(error instanceof Error ? error.message : String(error));
            }
          }
          if (finished) return { value: undefined, done: true };
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (finished || signal.aborted) {
              finish();
              return { value: undefined, done: true };
            }
            finish();
            throw ClientError.transport(error);
          }
          if (chunk.done) {
            finish();
            continue;
          }
          pending.push(...parser.feed(chunk.value));
        }
      },
      async return(): Promise<IteratorResult<Envelope>> {
        finish();
        pending.length = 0;
        return { value: undefined, done: true };
      },
      close: () => {
        finish();
        pending.length = 0;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return stream;
  }

  /** `<base>/api/<segments...>` with each segment percent-encoded. */
  url(segments: readonly string[], query: Query = {}): URL {
    const url = new URL(this.#base.href);
    let path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    for (const s of ["api", ...segments]) path += `/${encodeURIComponent(s)}`;
    url.pathname = path;
    url.search = "";
    url.hash = "";
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.append(k, v);
    }
    return url;
  }

  async #send(
    method: Method,
    segments: readonly string[],
    options: CallOptions & { query?: Query; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await fetch(this.url(segments, options.query), {
        method,
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      throw ClientError.transport(error);
    }
    if (response.ok) return response;
    throw await responseError(response);
  }

  async #json<T>(
    method: Method,
    segments: readonly string[],
    options?: CallOptions & { query?: Query; body?: unknown },
  ): Promise<T> {
    const response = await this.#send(method, segments, options);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw ClientError.transport(error);
    }
  }

  /** For routes answering `204 No Content`. */
  async #empty(
    method: Method,
    segments: readonly string[],
    options?: CallOptions & { query?: Query; body?: unknown },
  ): Promise<void> {
    const response = await this.#send(method, segments, options);
    try {
      await response.arrayBuffer();
    } catch (error) {
      throw ClientError.transport(error);
    }
  }
}
