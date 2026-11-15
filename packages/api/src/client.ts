// Typed client for the admin API, used by the CLI. The routes on the route table
// (`@miyoria/contracts/api`) are not here: the CLI calls those through the contract's client.

import { statusText } from "./errors.js";
import type { ErrorBody } from "./types.js";

export type ClientErrorKind = "invalid_url" | "transport" | "api";

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
}

/** Options every call accepts. */
export interface CallOptions {
  signal?: AbortSignal;
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
}
