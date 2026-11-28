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
  /**
   * Until the reply's head; for a reply read whole here (`callJson`, `callBytes`, an error body),
   * also until its last byte, so a service that starts in time and then drips cannot hold the
   * caller (the event poll of every job on that computer) forever.
   */
  timeoutMs: number;
  /** For a reply read whole: until its last byte instead (a log may be slow to arrive in full). */
  bodyTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Most of a JSON reply read unless the call allows more. The computer is someone else's: a reply
 * of gigabytes would take Core's memory, and every small reply (info, a job, a part) fits easily.
 */
export const JSON_MAX_BYTES = 256 * 1024;
/** Most of an error body read; the message is cut to 500 characters anyway. */
const ERROR_MAX_BYTES = 64 * 1024;

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

/** The error a non-2xx reply stands for (its body read up to a cap, within the call's time). */
async function failure(response: Response, signal: AbortSignal): Promise<SandboxHttpError> {
  const text = await readCapped(response, ERROR_MAX_BYTES, signal).then(
    (bytes) => bytes.toString("utf8"),
    (error: unknown) => {
      // Out of time: that is the error. Too long: the start is enough to tell what it was.
      if (signal.aborted) throw error;
      return "";
    },
  );
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

/** A reply whose time limit still runs: `done()` once its body is read, or not wanted whole. */
interface Sent {
  response: Response;
  /** Aborts when the call's time is up (or the caller's own signal). */
  signal: AbortSignal;
  done(): void;
}

/**
 * One request. Its head must come within `timeoutMs`; the whole reply, when the caller reads it
 * here, within `bodyTimeoutMs` (default the same) until `done()`. Refused for a full relay: waited
 * out and sent again (the request never left). A non-2xx reply throws `SandboxHttpError`.
 */
async function send(
  source: EndpointSource,
  endpoint: Endpoint,
  path: string,
  o: CallOptions,
): Promise<Sent> {
  const { body, headers } = toBody(o);
  for (let attempt = 0; ; attempt++) {
    const limit = new AbortController();
    const headTimer = setTimeout(
      () => limit.abort(new Error(`no answer within ${o.timeoutMs} ms`)),
      o.timeoutMs,
    );
    const wholeMs = o.bodyTimeoutMs ?? o.timeoutMs;
    const wholeTimer = setTimeout(
      () => limit.abort(new Error(`the answer did not arrive in full within ${wholeMs} ms`)),
      wholeMs,
    );
    const done = () => {
      clearTimeout(headTimer);
      clearTimeout(wholeTimer);
    };
    const signal = o.signal ? AbortSignal.any([o.signal, limit.signal]) : limit.signal;
    try {
      const response = await source.request(endpoint, path, {
        method: o.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
        // A redirect is never the service's own answer: followed, it would send the request (and
        // Core's bearer token, to the same host) wherever the other computer points, a LAN or
        // admin address included.
        redirect: "error",
      });
      clearTimeout(headTimer);
      if (!response.ok) throw await failure(response, signal);
      return { response, signal, done };
    } catch (error) {
      done();
      if (!relayFull(error) || attempt >= RELAY_RETRIES) throw error;
      await sleep(RELAY_RETRY_MS, o.signal);
    }
  }
}

/**
 * One request, its reply's head within `timeoutMs`; the body is the caller's to read (a tar or
 * a stream may take longer to arrive than to start, and is held to its own size cap there).
 */
export async function call(
  source: EndpointSource,
  endpoint: Endpoint,
  path: string,
  o: CallOptions,
): Promise<Response> {
  const sent = await send(source, endpoint, path, o);
  sent.done();
  return sent.response;
}

/**
 * A request whose reply is JSON of `schema`, `maxBytes` at most (default `JSON_MAX_BYTES`), all
 * of it within the call's time.
 */
export async function callJson<S extends z.ZodType>(
  source: EndpointSource,
  endpoint: Endpoint,
  path: string,
  schema: S,
  o: CallOptions & { maxBytes?: number },
): Promise<z.output<S>> {
  const { response, bytes } = await callBytes(
    source,
    endpoint,
    path,
    o.maxBytes ?? JSON_MAX_BYTES,
    o,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
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

/** A request whose reply is read whole, `maxBytes` at most, within the call's time. */
export async function callBytes(
  source: EndpointSource,
  endpoint: Endpoint,
  path: string,
  maxBytes: number,
  o: CallOptions,
): Promise<{ response: Response; bytes: Buffer }> {
  const sent = await send(source, endpoint, path, o);
  try {
    return {
      response: sent.response,
      bytes: await readCapped(sent.response, maxBytes, sent.signal),
    };
  } finally {
    sent.done();
  }
}

/** A reply's body as bytes, `maxBytes` at most (more is refused, not cut). */
export function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  return readCapped(response, maxBytes);
}

/**
 * The body, `maxBytes` at most, given up when `signal` aborts. The abort is raced here as well as
 * passed to the request: a relayed or test reply need not tie its body to the request's signal.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  // `bad_reply`, not `too_large`: that code is the service refusing what Core sent (her folder
  // too large, a body refused everywhere), while a reply past its cap is the computer's fault.
  const tooLarge = () =>
    new SandboxHttpError(
      response.status,
      "bad_reply",
      `the sandbox service sent a reply over ${maxBytes} bytes`,
    );
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let onAbort: (() => void) | null = null;
  const aborted =
    signal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
  // Raced below; once the loop is over a late abort must not surface as unhandled.
  aborted?.catch(() => undefined);
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await (aborted === null
        ? reader.read()
        : Promise.race([reader.read(), aborted]));
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (onAbort !== null) signal?.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(parts);
}

/**
 * A request whose reply is streamed to the caller (a tar coming back): its head within
 * `timeoutMs`, its last byte within `bodyTimeoutMs`, `maxBytes` at most. The computer is someone
 * else's, so a body that drips or does not end is given up, and the reader is cancelled however
 * the caller stops reading (an error of its own included), so the connection does not stay open.
 */
export async function callStream(
  source: EndpointSource,
  endpoint: Endpoint,
  path: string,
  maxBytes: number,
  o: CallOptions & { bodyTimeoutMs: number },
): Promise<AsyncGenerator<Uint8Array>> {
  const sent = await send(source, endpoint, path, o);
  const { response, signal } = sent;
  const tooLarge = () =>
    new SandboxHttpError(
      response.status,
      "bad_reply",
      `the sandbox service sent a reply over ${maxBytes} bytes`,
    );
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    sent.done();
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  return (async function* stream(): AsyncGenerator<Uint8Array> {
    const reader = response.body?.getReader();
    let finished = false;
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      if (!reader) return;
      let total = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) {
          finished = true;
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) throw tooLarge();
        yield value;
      }
    } finally {
      if (onAbort !== null) signal.removeEventListener("abort", onAbort);
      sent.done();
      if (reader && !finished) await reader.cancel().catch(() => undefined);
    }
  })();
}
