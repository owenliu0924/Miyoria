// The shape of one declarative HTTP tool file and of `[modules.http_tools]`. Objects are strict:
// a misspelt key (`header` for `headers`, `per_hour` under the wrong table) is an error instead
// of a setting that silently does nothing.

import { z } from "zod";

/** A tool's name: also its registry tool name, `http.<name>` and `tools.http.<name>`. */
export const HTTP_TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/** A parameter's name (a `{name}` placeholder in the url uses the same characters). */
export const HTTP_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

/** An environment variable name a `{secret:NAME}` may use. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** An HTTP header name (RFC 9110 token characters). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const HttpParamSchema = z.strictObject({
  type: z.enum(["string", "integer", "number", "boolean"]),
  description: z.string().max(500).default(""),
  required: z.boolean().default(false),
  enum: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .min(1)
    .max(100)
    .optional(),
  /** Unset: `path` when the url has `{name}`, else `query` for GET / DELETE and `body` otherwise. */
  in: z.enum(["path", "query", "body"]).optional(),
});
export type HttpParamFile = z.output<typeof HttpParamSchema>;

/** Same keys as an extension tool's limits; unset keys keep the tier's. */
export const HttpToolLimitsSchema = z.strictObject({
  per_hour: z.number().int().nonnegative().optional(),
  per_person_per_hour: z.number().int().nonnegative().optional(),
  per_day: z.number().int().nonnegative().optional(),
  per_person_per_day: z.number().int().nonnegative().optional(),
  cooldown_ms: z.number().int().nonnegative().optional(),
});
export type HttpToolLimits = z.output<typeof HttpToolLimitsSchema>;

/** One `*.toml` file. */
export const HttpToolFileSchema = z.strictObject({
  name: z.string().regex(HTTP_TOOL_NAME),
  description: z.string().trim().min(1).max(2000),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  /** Work-tier limits (`[modules.actions.work]`) instead of the medium tier's. */
  work: z.boolean().optional(),
  /** Low risk only: it only looks, so it may run next to other such calls. */
  read_only: z.boolean().default(false),
  method: z.enum(HTTP_METHODS).default("GET"),
  url: z.string().min(1).max(2000),
  params: z.record(z.string().regex(HTTP_PARAM_NAME), HttpParamSchema).default({}),
  query: z.record(z.string().min(1).max(200), z.string().max(2000)).default({}),
  headers: z.record(z.string().regex(HEADER_NAME), z.string().max(4000)).default({}),
  body: z.strictObject({ format: z.enum(["json", "form"]).default("json") }).default({
    format: "json",
  }),
  response: z
    .strictObject({
      format: z.enum(["json", "text"]).default("json"),
      /** Dotted paths into the JSON answer; an array index is a segment (`list.0.name`). */
      pick: z
        .union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(50)])
        .optional(),
      max_chars: z.number().int().min(100).max(100_000).default(4000),
    })
    .default({ format: "json", max_chars: 4000 }),
  limits: HttpToolLimitsSchema.optional(),
});
export type HttpToolFile = z.output<typeof HttpToolFileSchema>;

/** A parameter after loading: where it goes is settled. */
export interface HttpParamDef extends Omit<HttpParamFile, "in"> {
  in: "path" | "query" | "body";
}

/** A loaded, checked tool. */
export interface HttpToolDef extends Omit<HttpToolFile, "params" | "response"> {
  params: Record<string, HttpParamDef>;
  response: { format: "json" | "text"; pick: string[] | null; single: boolean; max_chars: number };
  /** The environment variable names its headers use (all listed in `secrets`). */
  secrets: string[];
  /** `config`, or `ext:<id>` for an extension's. */
  origin: string;
  /** The file it came from. */
  file: string;
}

/**
 * `[modules.http_tools]`: declarative HTTP tools, one `*.toml` per tool.
 *
 * ```toml
 * [modules.http_tools]
 * dirs = ["tools/http"]
 * secrets = ["WEATHER_KEY"]
 * ```
 */
export const HttpToolsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Folders read for `*.toml` (relative to the app's folder). Extensions' `http-tools/` come on top. */
  dirs: z.array(z.string().min(1)).default(() => ["tools/http"]),
  /**
   * The only environment variables a tool's `{secret:NAME}` may read. A tool naming another one
   * is not loaded, so a tool file alone cannot reach an unrelated key in the environment.
   */
  secrets: z.array(z.string().regex(SECRET_NAME)).default(() => []),
  /** Ports other than 80 / 443 a tool's url may use. */
  allow_ports: z.array(z.number().int().min(1).max(65_535)).default(() => []),
  timeout_ms: z.number().int().min(100).max(120_000).default(15_000),
  /** At most this much of an answer is read. */
  max_response_bytes: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(1_048_576),
  user_agent: z.string().trim().min(1).max(200).default("Miyoria/1 (http tool)"),
});
export type HttpToolsConfig = z.output<typeof HttpToolsConfigSchema>;
