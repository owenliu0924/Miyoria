// Input validation for config values. Errors are user-facing (`t.validate`). Strings holding
// `${VAR}` references are not checked; their value is.
//
// What a value may be is the root schema's to say (`rootConfigSchema` of `@miyoria/core`, with the
// CLI's own `[stack]` and `[machine]`): a key it describes is checked by it, worded here. The rules
// below cover the keys it does not describe, and the formats it does not say (a URL, `host:port`,
// a database URL), which are checked on top of it.

import {
  type ConfigProblem,
  type ConfigSchema,
  checkConfig,
  schemaAt,
} from "@miyoria/runtime/kernel";
import { isEnvName } from "./env-file.js";
import { t } from "./i18n/index.js";
import { StackSchema } from "./stack/config.js";
import { MachineSchema } from "./stack/roles.js";
import { isTable, type TomlTable, type TomlValue } from "./toml-patch.js";

/** `null` when valid, else the error text. */
export type Check = (s: string) => string | null;

function urlWith(s: string, schemes: readonly string[], hint: string): string | null {
  const v = s.trim();
  if (v.includes("${")) return null;
  try {
    const u = new URL(v);
    const scheme = u.protocol.replace(/:$/, "");
    return schemes.includes(scheme) && u.hostname !== "" ? null : hint;
  } catch {
    return hint;
  }
}

export const httpUrl: Check = (s) => urlWith(s, ["http", "https"], t.validate.httpUrl);

export const wsUrl: Check = (s) => urlWith(s, ["ws", "wss", "http", "https"], t.validate.wsUrl);

export const databaseUrl: Check = (s) => {
  const v = s.trim();
  if (v === "memory://" || v.includes("${")) return null;
  if (v.startsWith("sqlite:")) {
    return v.replace(/^sqlite:(\/\/)?/, "") === "" ? t.validate.sqlitePath : null;
  }
  if (/^postgres(ql)?:/i.test(v)) return t.validate.noPostgres;
  return t.validate.databaseUrl;
};

export const port: Check = (s) => {
  const v = s.trim();
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  return n >= 1 && n <= 65535 ? null : t.validate.port;
};

export const bind: Check = (s) => {
  const v = s.trim();
  if (v.includes("${")) return null;
  const hint = t.validate.bind;
  const colon = v.lastIndexOf(":");
  if (colon <= 0) return hint;
  const host = v.slice(0, colon);
  if (/\s/.test(host)) return hint;
  return port(v.slice(colon + 1)) === null ? null : hint;
};

export const discordId: Check = (s) => {
  return /^\d{17,20}$/.test(s.trim()) ? null : t.validate.discordId;
};

export const optionalDiscordId: Check = (s) => (s.trim() === "" ? null : discordId(s));

/** Comma or space separated ids; empty is fine. */
export const discordIds: Check = (s) => {
  for (const part of s.split(/[, ]/)) {
    if (part.trim() === "") continue;
    const err = discordId(part);
    if (err) return err;
  }
  return null;
};

export const modelId: Check = (s) => {
  const v = s.trim();
  if (v === "") return t.validate.modelEmpty;
  if (/\s/.test(v)) return t.validate.modelSpace;
  return null;
};

export const envName: Check = (s) => (isEnvName(s) ? null : t.validate.envName(s));

// ---- the root schema ---------------------------------------------------------------------

/** The sections only the CLI reads, which it adds to Core's root schema. */
export const CLI_SECTIONS = { stack: StackSchema, machine: MachineSchema } as const;

let loaded: Promise<ConfigSchema | null> | undefined;

/**
 * The root schema of the whole file. It needs every module package, so it is loaded on first
 * use; `null` when they cannot be loaded, and then only the rules below check values.
 */
export function configSchema(): Promise<ConfigSchema | null> {
  loaded ??= import("@miyoria/core").then(
    (core) => core.rootConfigSchema(CLI_SECTIONS),
    () => null,
  );
  return loaded;
}

/** The root schema and the document a value is checked in (as `Workspace.doc.data` holds it). */
export interface SchemaContext {
  schema: ConfigSchema;
  doc: TomlTable;
}

/** The context for checks in `doc`, `null` without a root schema. */
export async function schemaContext(doc: TomlTable): Promise<SchemaContext | null> {
  const schema = await configSchema();
  return schema === null ? null : { schema, doc };
}

/** A TOML value as Core sees it once loaded: integers are numbers, dates their text. */
function jsonOf(value: TomlValue): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonOf);
  if (isTable(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonOf(v)]));
  }
  return value;
}

/** Whether the root schema describes the value at `path`. */
export function described(ctx: SchemaContext | null, path: readonly string[]): boolean {
  return ctx !== null && schemaAt(ctx.schema, path) !== null;
}

/** A problem in the CLI's words (a fragment: `must be a number`). */
function wording(problem: ConfigProblem): string {
  const issue = problem.issue;
  switch (issue.code) {
    case "invalid_type": {
      return t.validate.mustBe(t.validate.types[issue.expected] ?? issue.expected);
    }
    case "too_big":
      if (issue.origin === "number" || issue.origin === "int") {
        return t.validate.tooBig(String(issue.maximum), issue.inclusive === false);
      }
      return problem.expected;
    case "too_small":
      if (issue.origin === "number" || issue.origin === "int") {
        return t.validate.tooSmall(String(issue.minimum), issue.inclusive === false);
      }
      return problem.expected;
    case "invalid_value":
      return t.validate.oneOf(t.common.list(issue.values.map((v) => JSON.stringify(v))));
    default:
      return problem.expected;
  }
}

/**
 * What the root schema says about putting `value` at `path` of the document: `null` when it
 * fits (or the schema does not describe that key), else the error text. Only problems at `path`
 * or inside `value` count; what is wrong elsewhere in the file is not this value's fault.
 */
export function schemaCheck(
  ctx: SchemaContext | null,
  path: readonly string[],
  value: TomlValue,
): string | null {
  if (ctx === null || !described(ctx, path)) return null;
  const doc = jsonOf(ctx.doc) as Record<string, unknown>;
  let table = doc;
  for (const key of path.slice(0, -1)) {
    const next = table[key];
    table[key] = typeof next === "object" && next !== null && !Array.isArray(next) ? next : {};
    table = table[key] as Record<string, unknown>;
  }
  table[path.at(-1) ?? ""] = jsonOf(value);
  const problems = checkConfig(ctx.schema, doc, { skipEnvRefs: true });
  // A table that takes no other keys (`[stack]`) names the key it does not know on itself.
  const unknown = problems.find(
    (p) =>
      p.issue.code === "unrecognized_keys" &&
      p.keys.length === path.length - 1 &&
      p.keys.every((key, i) => path[i] === key) &&
      p.issue.keys.includes(path.at(-1) ?? ""),
  );
  if (unknown !== undefined) return t.validate.unknownKey(path.at(-1) ?? "");
  const problem = problems.find((p) => path.every((key, i) => p.keys[i] === key));
  if (problem === undefined) return null;
  const inside = problem.keys.slice(path.length);
  return inside.length === 0
    ? t.validate.sentence(wording(problem))
    : `${inside.map((k) => (typeof k === "number" ? `[${k}]` : k)).join(".")} ${wording(problem)}`;
}

/**
 * Checks a value written with `miyoria config set`: by the root schema where it describes the
 * key, then by the key's name for the formats it does not say and the keys it does not describe.
 */
export function valueForKey(
  path: readonly string[],
  value: TomlValue,
  ctx: SchemaContext | null = null,
): string | null {
  const last = path.at(-1) ?? "";
  if (typeof value === "string" && value.includes("${")) return null;
  const fromSchema = schemaCheck(ctx, path, value);
  if (fromSchema !== null) return fromSchema;
  const own = !described(ctx, path);
  const string = (check: Check) =>
    typeof value === "string" ? check(value) : t.validate.keyString(last);
  if (own && (last === "enabled" || last === "dev") && typeof value !== "boolean") {
    return t.validate.keyBoolean(last);
  }
  if (own && last === "port") {
    return typeof value === "bigint" && value >= 1n && value <= 65535n ? null : t.validate.port;
  }
  if (last === "bind") return string(bind);
  if (last === "database_url") return string(databaseUrl);
  if (last === "core_url") return string(wsUrl);
  if (own && last === "command_guilds") {
    if (!Array.isArray(value) || isTable(value)) return t.validate.idsArray;
    for (const v of value) {
      if (typeof v !== "string") return t.validate.idsString;
      const err = discordId(v);
      if (err) return err;
    }
    return null;
  }
  if (last === "url" || last.endsWith("_url") || last.endsWith("_uri")) return string(httpUrl);
  return null;
}
