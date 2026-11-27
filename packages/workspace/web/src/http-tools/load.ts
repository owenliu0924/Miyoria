// Reading tool files. Everything that can be checked without a request is checked here, so a
// bad file is a logged problem at start instead of a tool that misbehaves when she calls it:
// where secrets may appear and which ones, that the host is fixed by the file (no placeholder
// before the path), that every placeholder is a declared parameter, and the static URL checks.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, parseTomlJson } from "@miyoria/runtime/kernel";
import { isJsonObject, type JsonValue, maskSecrets } from "@miyoria/types";
import { checkUrl, WebError } from "../net.js";
import {
  HTTP_PARAM_NAME,
  type HttpParamDef,
  type HttpToolDef,
  HttpToolFileSchema,
  type HttpToolsConfig,
  SECRET_NAME,
} from "./schema.js";

/** A folder of tool files and who it belongs to (`config`, `ext:<id>`). */
export interface HttpToolDir {
  dir: string;
  origin: string;
  /**
   * An extension's folder: the only secrets its files may use, besides being listed in
   * `[modules.http_tools] secrets` (the owner's `[extensions."<id>"] secrets`). Without it a
   * tool file from an extension could send a key the owner set for their own tool to any host.
   */
  secrets?: readonly string[];
}

export interface HttpToolProblem {
  file: string;
  /** For the log; never holds a secret's value. */
  reason: string;
}

/** A tool file that cannot be used, with why. */
export class HttpToolLoadError extends Error {
  override readonly name = "HttpToolLoadError";
}

/** `{name}` placeholders of the url. */
const PLACEHOLDER = /\{([^{}]*)\}/g;
/** `{secret:NAME}` in a header value. */
const SECRET_TOKEN = /\{secret:([^{}]*)\}/g;
/** Anything that looks like the start of a secret reference, however spaced or cased. */
const SECRET_START = /\{\s*secret\s*:/i;

/** Headers the transport sets itself; a file setting them could desync or smuggle a request. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

/** Names the gate adds to every tool's arguments. */
const GATE_ARGS = new Set(["why", "on_own"]);

/** Every string of `value` with its path; an object key comes with `key` set. */
function* strings(
  value: JsonValue,
  path: string[] = [],
): Generator<{ path: string[]; text: string; key: boolean }> {
  if (typeof value === "string") {
    yield { path, text: value, key: false };
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* strings(item, [...path, String(i)]);
  } else if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      yield { path: [...path, key], text: key, key: true };
      yield* strings(item, [...path, key]);
    }
  }
}

function fail(reason: string): never {
  throw new HttpToolLoadError(reason);
}

/** The url's text from the scheme to the first `/`, `?` or `#` after it. */
function authorityEnd(url: string): number {
  const start = url.indexOf("://");
  if (start === -1) return -1;
  const rest = url.slice(start + 3).search(/[/?#]/);
  return rest === -1 ? url.length : start + 3 + rest;
}

/**
 * One tool file's text as a checked tool, or `HttpToolLoadError`. `file` and `origin` are only
 * recorded on the result.
 */
export function parseHttpTool(
  text: string,
  config: HttpToolsConfig,
  file = "(inline)",
  origin = "config",
  /** Names its headers may use; default `config.secrets`. */
  allowed: readonly string[] = config.secrets,
): HttpToolDef {
  let raw: JsonValue;
  try {
    raw = parseTomlJson(text);
  } catch (error) {
    fail(errorMessage(error));
  }

  // Secrets go into headers and nowhere else: anywhere else they could reach a log, the url
  // (and so a server's access log or a redirect) or her prompt.
  for (const { path, text: value, key } of strings(raw)) {
    const inHeaderValue = !key && path.length === 2 && path[0] === "headers";
    if (!inHeaderValue && SECRET_START.test(value)) {
      fail(`a {secret:...} may only appear in a [headers] value, not at ${path.join(".")}`);
    }
  }

  const parsed = HttpToolFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(top)"}: ${i.message}`);
    fail(issues.join("; "));
  }
  const tool = parsed.data;

  // The host is the file's: a placeholder there would let the arguments choose where the
  // secret header goes.
  if (!/^https?:\/\//i.test(tool.url)) fail("url must start with http:// or https://");
  const hostEnd = authorityEnd(tool.url);
  if (/[{}]/.test(tool.url.slice(0, hostEnd)))
    fail("url may only have placeholders after the host");

  const inPath = new Set<string>();
  for (const match of tool.url.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? "";
    if (!HTTP_PARAM_NAME.test(name)) fail(`url placeholder {${name}} is not a parameter name`);
    if (tool.params[name] === undefined) fail(`url placeholder {${name}} has no [params.${name}]`);
    inPath.add(name);
  }
  if (/[{}]/.test(tool.url.replace(PLACEHOLDER, ""))) fail("url has an unmatched brace");

  const params: Record<string, HttpParamDef> = {};
  for (const [name, param] of Object.entries(tool.params)) {
    if (GATE_ARGS.has(name)) fail(`parameter ${name} is reserved`);
    let where: HttpParamDef["in"];
    if (inPath.has(name)) {
      if (param.in !== undefined && param.in !== "path") {
        fail(`parameter ${name} is in the url but says in = "${param.in}"`);
      }
      where = "path";
    } else if (param.in === "path") {
      fail(`parameter ${name} says in = "path" but the url has no {${name}}`);
    } else {
      where = param.in ?? (tool.method === "GET" || tool.method === "DELETE" ? "query" : "body");
    }
    if (where === "body" && tool.method === "GET")
      fail(`a GET cannot send parameter ${name} in a body`);
    for (const option of param.enum ?? []) {
      const ok =
        param.type === "string"
          ? typeof option === "string"
          : param.type === "boolean"
            ? typeof option === "boolean"
            : typeof option === "number" && (param.type === "number" || Number.isInteger(option));
      if (!ok)
        fail(`parameter ${name}: enum value ${JSON.stringify(option)} is not a ${param.type}`);
    }
    // A path segment cannot be left out, so a path parameter is always required.
    params[name] = { ...param, in: where, required: where === "path" ? true : param.required };
  }

  const seenHeaders = new Set<string>();
  const secrets = new Set<string>();
  for (const [header, value] of Object.entries(tool.headers)) {
    const lower = header.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith("proxy-")) {
      fail(`header ${header} is set by the transport`);
    }
    if (seenHeaders.has(lower)) fail(`header ${header} is given twice`);
    seenHeaders.add(lower);
    if (/[\r\n\0]/.test(value)) fail(`header ${header} has a line break`);
    for (const match of value.matchAll(SECRET_TOKEN)) {
      const name = match[1] ?? "";
      if (!SECRET_NAME.test(name))
        fail(`header ${header}: {secret:${name}} is not a variable name`);
      if (!config.secrets.includes(name)) {
        fail(`header ${header}: secret ${name} is not listed in [modules.http_tools] secrets`);
      }
      if (!allowed.includes(name)) {
        fail(`header ${header}: secret ${name} is not granted to ${origin}`);
      }
      secrets.add(name);
    }
    if (SECRET_START.test(value.replace(SECRET_TOKEN, ""))) {
      fail(`header ${header} has a malformed {secret:...}`);
    }
  }

  const pickList =
    tool.response.pick === undefined
      ? null
      : typeof tool.response.pick === "string"
        ? [tool.response.pick]
        : tool.response.pick;
  if (pickList !== null) {
    if (tool.response.format !== "json") fail('response.pick needs response.format = "json"');
    for (const path of pickList) {
      if (path.split(".").some((s) => s === ""))
        fail(`response.pick path ${path} has an empty segment`);
    }
  }

  // The static half of the guard now, so a tool pointed at an internal host never loads.
  try {
    checkUrl(tool.url.replace(PLACEHOLDER, "x"), config.allow_ports);
  } catch (error) {
    if (error instanceof WebError) fail(`url refused: ${error.reason}`);
    throw error;
  }

  return {
    ...tool,
    params,
    response: {
      format: tool.response.format,
      pick: pickList,
      single: typeof tool.response.pick === "string",
      max_chars: tool.response.max_chars,
    },
    secrets: [...secrets],
    origin,
    file,
  };
}

/** The `*.toml` files directly in `dir`, sorted; a missing folder has none. */
function tomlFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".toml"))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Every tool in `dirs`, in order. A file that cannot be used is a problem and is skipped; a name
 * already taken by an earlier file is a problem too (the first one stays).
 */
export function loadHttpTools(
  dirs: readonly HttpToolDir[],
  config: HttpToolsConfig,
): { tools: HttpToolDef[]; problems: HttpToolProblem[] } {
  const tools: HttpToolDef[] = [];
  const problems: HttpToolProblem[] = [];
  const byName = new Map<string, HttpToolDef>();
  for (const { dir, origin, secrets: granted } of dirs) {
    let names: string[];
    try {
      names = tomlFiles(dir);
    } catch (error) {
      problems.push({ file: dir, reason: maskSecrets(`cannot list: ${errorMessage(error)}`) });
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        const def = parseHttpTool(
          readFileSync(file, "utf8"),
          config,
          file,
          origin,
          granted ?? config.secrets,
        );
        const first = byName.get(def.name);
        if (first !== undefined) {
          problems.push({ file, reason: `the name ${def.name} is already used by ${first.file}` });
          continue;
        }
        byName.set(def.name, def);
        tools.push(def);
      } catch (error) {
        // A raw key pasted into a file could show up in a TOML error's snippet.
        problems.push({ file, reason: maskSecrets(errorMessage(error)) });
      }
    }
  }
  return { tools, problems };
}
