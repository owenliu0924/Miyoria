// Requests to the `sandbox` service of one computer (docs/design/v6-sandbox.md §3), through the
// cluster's `EndpointSource.request` (direct, a route, or the control link's relay). Every reply
// is checked against its contract shape before anything uses it: the computer is someone else's.

import { SandboxErrorBodySchema, type SandboxErrorCode } from "@miyoria/contracts/workers";
import type { Endpoint, EndpointSource } from "@miyoria/runtime/kernel";
import { sleep } from "@miyoria/runtime/kernel";
import type { z } from "zod";

/** The service answered with an error body (or an unreadable one). */
export class SandboxHttpError extends Error {
  override readonly name = "SandboxHttpError";

  constructor(
    readonly status: number,
    readonly code: SandboxErrorCode | "bad_reply",
    message: string,
    readonly extra: {
      retry_after_ms?: number;
      ended?: { reason: string; at: number };
      reason?: string;
    } = {},
  ) {
    super(message);
  }
}

/** Errors of a connection that never opened (the same list as the cluster's `routed.ts`). */
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Whether a failed request never left Core, so another computer may be tried with no doubt
 * about the first. The cluster's own `neverSent`, by name: this package does not depend on it.
 */
export function notSent(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown; name?: unknown };
  if (e.name === "RelayUnavailableError") return true;
  if (
    (e.name === "RelayError" || e.name === "RouteError") &&
    (e as { sent?: unknown }).sent === false
  ) {
    return true;
  }
  if (typeof e.code === "string" && NOT_CONNECTED.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.every((inner) => notSent(inner, depth + 1));
  }
  return notSent(e.cause, depth + 1);
}

/**
 * The relay to that computer has all its streams open (16 per host): the request was refused
 * before it left. It is waited out and sent again, not taken for a broken computer.
 */
export function relayFull(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; message?: unknown; sent?: unknown };
  return (
    e.name === "RelayError" &&
    e.sent === false &&
    typeof e.message === "string" &&
    /open already/.test(e.message)
  );
}

export interface CallOptions {
  method: "GET" | "PUT" | "DELETE";
  /** JSON body, or raw bytes (upload parts, stdin). */
  json?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  /** Until the reply's head. */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** How long a request refused for a full relay waits before the next try, and how often. */
const RELAY_RETRY_MS = 500;
const RELAY_RETRIES = 40;

function toBody(o: CallOptions): { body?: RequestInit["body"]; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.json !== undefined) {
    const text = JSON.stringify(o.json);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(text, "utf8"));
    return { body: text, headers };
  }
  if (o.bytes !== undefined) {
    headers["content-type"] = "application/octet-stream";
    headers["content-length"] = String(o.bytes.byteLength);
    return { body: o.bytes as unknown as NonNullable<RequestInit["body"]>, headers };
  }
  if (o.method === "PUT") {
    headers["content-type"] = "application/json";
    headers["content-length"] = "2";
    return { body: "{}", headers };
  }
  return { headers };
}

/** The error a non-2xx reply stands for. */
async function failure(response: Response): Promise<SandboxHttpError> {
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: a proxy or an older service.
  }
  const body = SandboxErrorBodySchema.safeParse(parsed);
  if (!body.success) {
    return new SandboxHttpError(
      response.status,
      response.status === 401 ? "unauthorized" : "bad_reply",
      `the sandbox service answered ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const e = body.data.error;
  return new SandboxHttpError(response.status, e.code, e.message.slice(0, 500), {
    ...(e.retry_after_ms === undefined ? {} : { retry_after_ms: e.retry_after_ms }),
    ...(e.ended === undefined ? {} : { ended: e.ended }),
    ...(e.reason === undefined ? {} : { reason: e.reason.slice(0, 500) }),
  });
}

/**
 * One request, its reply's head within `timeoutMs`. Refused for a full relay: waited out and
 * sent again (the request never left). A non-2xx reply throws `SandboxHttpError`.
 */
export async function call(
  source: EndpointSource,
  endpoint: Endpoint,
  path: string,
  o: CallOptions,
): Promise<Response> {
  const { body, headers } = toBody(o);
  for (let attempt = 0; ; attempt++) {
    // The limit is on the head only: a tar or a log may take longer to arrive than to start.
    const head = new AbortController();
    const timer = setTimeout(
      () => head.abort(new Error(`no answer within ${o.timeoutMs} ms`)),
      o.timeoutMs,
    );
    const signal = o.signal ? AbortSignal.any([o.signal, head.signal]) : head.signal;
    try {
      const response = await source.request(endpoint, path, {
        method: o.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw await failure(response);
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (!relayFull(error) || attempt >= RELAY_RETRIES) throw error;
      await sleep(RELAY_RETRY_MS, o.signal);
    }
  }
}

/** A request whose reply is JSON of `schema`. */
export async function callJson<S extends z.ZodType>(
  source: EndpointSource,
  endpoint: Endpoint,
  path: string,
  schema: S,
  o: CallOptions,
): Promise<z.output<S>> {
  const response = await call(source, endpoint, path, o);
  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SandboxHttpError(response.status, "bad_reply", "the sandbox service sent no JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SandboxHttpError(
      response.status,
      "bad_reply",
      `the sandbox service sent an unexpected reply to ${path.split("?")[0]}`,
    );
  }
  return parsed.data;
}

/** A reply's body as bytes, `maxBytes` at most (more is refused, not cut). */
export async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SandboxHttpError(response.status, "too_large", `a reply over ${maxBytes} bytes`);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/** A reply's body as an async iterable of bytes (a tar coming back). */
export async function* bodyChunks(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
