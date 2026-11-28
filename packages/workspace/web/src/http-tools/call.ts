// One call of a declarative HTTP tool. The request goes through the same guard as her page
// reader (`checkUrl`, every DNS answer public, the socket pinned to the checked address), and
// never follows a redirect: the next hop would get the secret header too. Secret values are read
// from the environment at call time, go into headers only, and are scrubbed from whatever comes
// back, so an API that echoes its request cannot hand one to her.

import http from "node:http";
import https from "node:https";
import { CapabilityError } from "@miyoria/gate/actions";
import { getLogger } from "@miyoria/runtime/kernel";
import { type JsonObject, type JsonValue, MASKED, maskSecrets } from "@miyoria/types";
import { z } from "zod";
import {
  checkUrl,
  type RawResponse,
  type Resolver,
  resolvePublic,
  systemResolver,
  WebError,
} from "../net.js";
import type { HttpParamDef, HttpToolDef, HttpToolsConfig } from "./schema.js";

const log = getLogger("web.http_tools");

// ---- transport ----------------------------------------------------------------------------

export interface HttpRequest {
  url: URL;
  /** Already checked: connect here and nowhere else. */
  address: { address: string; family: 4 | 6 };
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  signal: AbortSignal;
}

/** One request to one address. Tests inject a fake. */
export type HttpTransport = (request: HttpRequest) => Promise<RawResponse>;

const unbracket = (host: string) => (host.startsWith("[") ? host.slice(1, -1) : host);

/**
 * `node:http(s)` with the socket's DNS lookup replaced by the checked address (as net.ts's
 * `pinnedTransport`, with a method and a body).
 */
export const pinnedHttpTransport: HttpTransport = ({
  url,
  address,
  method,
  headers,
  body,
  signal,
}) =>
  new Promise<RawResponse>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        host: unbracket(url.hostname),
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers: body === null ? headers : { ...headers, "content-length": String(body.length) },
        agent: false,
        signal,
        // Called for the connection itself (also with `all: true` by happy-eyeballs).
        lookup: (_host, options, callback) => {
          const entry = { address: address.address, family: address.family };
          if ((options as { all?: boolean }).all) {
            (callback as (e: null, a: unknown[]) => void)(null, [entry]);
          } else {
            callback(null, entry.address, entry.family);
          }
        },
      },
      (res) => {
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          flat[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flat,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end(body ?? undefined);
  });

// ---- arguments ----------------------------------------------------------------------------

function typeName(type: HttpParamDef["type"]): string {
  return { string: "文字", integer: "整數", number: "數字", boolean: "true 或 false" }[type];
}

/**
 * Whether `value` stays one path segment wherever it is decoded. The URL parser resolves `.` and
 * `..` (even encoded); `/` and `\` are sent as `%2F` / `%5C`, which many servers and proxies decode
 * back into separators, so `../admin` would reach another endpoint as `..%2Fadmin`. A `%2F` or
 * `%2E` she wrote herself is refused as well, for the servers that decode twice.
 */
export function isPathSegment(value: string): boolean {
  if (value === "" || value === ".") return false;
  return !/[/\\]|\.\.|%(2e|2f|5c)/iu.test(value);
}

/**
 * `args` checked against the tool's parameters, or a message for her (Traditional Chinese).
 * Unknown arguments are refused: a typo must not quietly drop a value she meant to send.
 */
export function checkHttpArgs(def: HttpToolDef, args: unknown): JsonObject | string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "參數要是一個物件";
  const out: JsonObject = {};
  for (const key of Object.keys(args)) {
    if (def.params[key] === undefined) {
      const known = Object.keys(def.params);
      return known.length === 0
        ? `這個工具不用參數,不認得 ${key}`
        : `不認得參數 ${key}(可以用:${known.join("、")})`;
    }
  }
  for (const [name, param] of Object.entries(def.params)) {
    const value = (args as Record<string, unknown>)[name];
    if (value === undefined || value === null) {
      if (param.required) return `少了參數 ${name}`;
      continue;
    }
    const ok =
      param.type === "string"
        ? typeof value === "string"
        : param.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "number" &&
            Number.isFinite(value) &&
            (param.type === "number" || Number.isInteger(value));
    if (!ok) return `參數 ${name} 要是${typeName(param.type)}`;
    if (param.enum !== undefined && !param.enum.includes(value as string | number | boolean)) {
      return `參數 ${name} 只能是:${param.enum.map((v) => String(v)).join("、")}`;
    }
    if (param.in === "path" && !isPathSegment(String(value))) {
      return `參數 ${name} 是網址的一段路徑:不能是空的或「.」,也不能有「/」、「\\」或「..」`;
    }
    out[name] = value as JsonValue;
  }
  return out;
}

/** The gate's argument check (stage `args`) for `def`, with `checkHttpArgs`' messages. */
export function httpArgsSchema(def: HttpToolDef): z.ZodType<JsonObject> {
  return z.unknown().transform((value, ctx) => {
    const checked = checkHttpArgs(def, value);
    if (typeof checked === "string") {
      ctx.addIssue({ code: "custom", message: checked });
      return z.NEVER;
    }
    return checked;
  }) as unknown as z.ZodType<JsonObject>;
}

// ---- the call -----------------------------------------------------------------------------

export interface HttpCallDeps {
  config: HttpToolsConfig;
  resolver?: Resolver;
  transport?: HttpTransport;
  /** The environment (default `process.env`). */
  env?: (name: string) => string | undefined;
}

const SECRET_TOKEN = /\{secret:([^{}]*)\}/g;
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The url with path, fixed query and query parameters filled in. */
function buildUrl(def: HttpToolDef, args: JsonObject): string {
  const filled = def.url.replace(PLACEHOLDER, (_m, name: string) =>
    encodeURIComponent(String(args[name])),
  );
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    throw new CapabilityError("這個工具的網址組不起來");
  }
  for (const [key, value] of Object.entries(def.query)) url.searchParams.set(key, value);
  for (const [name, param] of Object.entries(def.params)) {
    const value = args[name];
    if (param.in === "query" && value !== undefined && value !== null) {
      url.searchParams.append(name, String(value));
    }
  }
  return url.href;
}

/** The body of the body parameters, or `null` when the tool sends none. */
function buildBody(def: HttpToolDef, args: JsonObject): { bytes: Uint8Array; type: string } | null {
  const names = Object.entries(def.params).filter(([, p]) => p.in === "body");
  if (names.length === 0) return null;
  const values: JsonObject = {};
  for (const [name] of names) {
    const value = args[name];
    if (value !== undefined && value !== null) values[name] = value;
  }
  if (def.body.format === "form") {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) form.append(k, String(v));
    return {
      bytes: new TextEncoder().encode(form.toString()),
      type: "application/x-www-form-urlencoded",
    };
  }
  return { bytes: new TextEncoder().encode(JSON.stringify(values)), type: "application/json" };
}

/** The tool's headers with its secrets filled in, and the values used (to scrub later). */
function buildHeaders(
  def: HttpToolDef,
  deps: HttpCallDeps,
): { headers: Record<string, string>; used: string[] } {
  const env = deps.env ?? ((name: string) => process.env[name]);
  const used: string[] = [];
  const headers: Record<string, string> = {
    "user-agent": deps.config.user_agent,
    accept: def.response.format === "json" ? "application/json" : "*/*",
    "accept-encoding": "identity",
  };
  for (const [header, template] of Object.entries(def.headers)) {
    const value = template.replace(SECRET_TOKEN, (_m, name: string) => {
      // Checked again here: the config may have changed since the file was read, and only the
      // names the file was allowed at load (`def.secrets`) count.
      const secret =
        deps.config.secrets.includes(name) && def.secrets.includes(name)
          ? env(name)?.trim()
          : undefined;
      if (secret === undefined || secret === "") {
        throw new CapabilityError(`這個工具的密鑰沒有設定(${name})`);
      }
      used.push(secret);
      return secret;
    });
    if (/[\r\n\0]/.test(value)) throw new CapabilityError("這個工具的密鑰格式不對,不能用");
    headers[header.toLowerCase()] = value;
  }
  return { headers, used };
}

/** Every way a secret's value could be written in an answer (as is, JSON-escaped, URL-encoded). */
function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const s of secrets) {
    forms.add(s);
    forms.add(JSON.stringify(s).slice(1, -1));
    forms.add(encodeURIComponent(s));
  }
  // Longest first, so a secret that contains another is replaced whole.
  return [...forms].filter((f) => f !== "").sort((a, b) => b.length - a.length);
}

function scrub(text: string, forms: readonly string[]): string {
  let out = text;
  for (const form of forms) out = out.replaceAll(form, MASKED);
  return out;
}

/** At most `limit` bytes of `body`. */
async function readLimited(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const room = limit - size;
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

/** The value at a dotted `path` (an array index is a segment), or `null`. */
export function pickPath(value: JsonValue, path: string): JsonValue {
  let at: JsonValue | undefined = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(at)) {
      at = /^\d+$/.test(segment) ? at[Number(segment)] : undefined;
    } else if (typeof at === "object" && at !== null) {
      at = Object.hasOwn(at, segment) ? at[segment] : undefined;
    } else {
      at = undefined;
    }
    if (at === undefined) return null;
  }
  return at;
}

/** The answer's text: picked and compact for JSON, as is for text. */
function render(def: HttpToolDef, raw: string): string {
  if (def.response.format === "text") return raw;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    throw new CapabilityError("服務回的不是有效的 JSON");
  }
  const pick = def.response.pick;
  if (pick === null) return JSON.stringify(parsed);
  if (def.response.single) {
    const value = pickPath(parsed, pick[0] ?? "");
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  const out: JsonObject = {};
  for (const path of pick) out[path] = pickPath(parsed, path);
  return JSON.stringify(out);
}

function cut(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}\n…(後面還有 ${chars.length - max} 字,已截斷)`;
}

/**
 * Calls `def` with `args` (checked again here) and answers its text. Every failure is a
 * `CapabilityError` with a message for her that names no secret value and no header.
 */
export async function callHttpTool(
  def: HttpToolDef,
  args: unknown,
  signal: AbortSignal,
  deps: HttpCallDeps,
): Promise<{ text: string; data: null }> {
  const checked = checkHttpArgs(def, args);
  if (typeof checked === "string") throw new CapabilityError(checked);
  const resolver = deps.resolver ?? systemResolver;
  const transport = deps.transport ?? pinnedHttpTransport;

  let url: URL;
  let address: { address: string; family: 4 | 6 };
  try {
    url = checkUrl(buildUrl(def, checked), deps.config.allow_ports);
    address = await resolvePublic(url, resolver);
  } catch (error) {
    if (error instanceof WebError) {
      log.warn({ tool: def.name, reason: error.reason }, "an http tool's url was refused");
      throw new CapabilityError(error.message);
    }
    throw error;
  }
  const { headers, used } = buildHeaders(def, deps);
  const forms = secretForms(used);
  const body = def.method === "GET" ? null : buildBody(def, checked);
  if (body !== null) headers["content-type"] = body.type;

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(deps.config.timeout_ms)]);
  const started = Date.now();
  let res: RawResponse;
  try {
    res = await transport({
      url,
      address,
      method: def.method,
      headers,
      body: body?.bytes ?? null,
      signal: deadline,
    });
  } catch (error) {
    if (deadline.aborted) throw new CapabilityError("服務回應太久了");
    log.warn(
      { tool: def.name, host: url.hostname, err: scrub(String(error), forms) },
      "an http tool could not connect",
    );
    throw new CapabilityError("連不上這個工具的服務");
  }
  let read: { bytes: Uint8Array; truncated: boolean };
  try {
    log.debug(
      { tool: def.name, method: def.method, host: url.hostname, status: res.status },
      "http tool answered",
    );
    if (res.status >= 300 && res.status < 400) {
      throw new CapabilityError(`服務要轉址到別的地方(${res.status}),不會跟過去`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new CapabilityError(`服務回了 ${res.status}`);
    }
    try {
      read = await readLimited(res.body, deps.config.max_response_bytes);
    } catch {
      if (deadline.aborted) throw new CapabilityError("服務回應太久了");
      throw new CapabilityError("回應讀到一半斷了");
    }
  } finally {
    res.destroy();
  }
  if (read.truncated && def.response.format === "json") {
    throw new CapabilityError("服務的回應太大了");
  }
  const raw = new TextDecoder("utf-8").decode(read.bytes);
  // Scrubbed before the cut too, so a cut cannot leave half a secret behind.
  const text = scrub(render(def, scrub(raw, forms)), forms);
  const note = read.truncated ? "\n…(回應太大,只讀了前面)" : "";
  log.debug({ tool: def.name, ms: Date.now() - started }, "http tool done");
  return { text: maskSecrets(scrub(cut(text, def.response.max_chars), forms)) + note, data: null };
}
