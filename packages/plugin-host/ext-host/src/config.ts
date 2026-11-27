// `[modules.extensions]` and `[extensions."<id>"]` config sections.

import { isAbsolute, join } from "node:path";
import type { Config } from "@miyoria/runtime/kernel";
import { ConfigError } from "@miyoria/runtime/kernel";
import { isJsonObject, type JsonObject } from "@miyoria/types";
import { z } from "zod";
import type { Permissions } from "./manifest.js";

/**
 * `[modules.extensions]`.
 *
 * ```toml
 * [modules.extensions]
 * dirs = ["extensions"]
 * dev = true            # restart an extension when its files change
 * ```
 */
export const HostConfigSchema = z.object({
  /** Directories searched for extensions, relative to the working directory. `ext install` copies into the first. */
  dirs: z.array(z.string()).default(["extensions"]),
  /** Watch extension files and restart on change. */
  dev: z.boolean().default(false),
  watch_poll_ms: z.number().int().nonnegative().default(1000),
  /** `initialize` handshake. */
  init_timeout_ms: z.number().int().nonnegative().default(10_000),
  /** `tools.call`, `commands.invoke` and `task.start` / `task.cancel` / `task.observe`. */
  call_timeout_ms: z.number().int().nonnegative().default(30_000),
  /**
   * A task an extension's executor accepted may report its end this long after its `budget_s`;
   * then the host fails it with `timeout` itself (and sends `task.cancel`).
   */
  task_grace_ms: z.number().int().nonnegative().default(5_000),
  /** `prompt.contribute`. */
  prompt_timeout_ms: z.number().int().nonnegative().default(3_000),
  /** Time an extension gets to exit after `shutdown` before it is killed. */
  shutdown_grace_ms: z.number().int().nonnegative().default(2_000),
  /** Executables per runtime, e.g. `{ node = "C:/node/node.exe" }`. */
  runtimes: z.record(z.string(), z.string()).default({}),
  /** Her clock for extension schedules (`schedule.set { daily = "HH:MM" }`), minutes east of UTC. */
  utc_offset_minutes: z.number().int().min(-720).max(840).default(480),
});

export type HostConfig = z.output<typeof HostConfigSchema>;

export const HOST_CONFIG_SECTION = "modules.extensions";

export function hostConfigFromConfig(config: Config): HostConfig {
  return config.get(HOST_CONFIG_SECTION, HostConfigSchema);
}

/** `dirs` made absolute against `base`. */
export function resolvedDirs(host: HostConfig, base: string): string[] {
  return host.dirs.map((d) => (isAbsolute(d) ? d : join(base, d)));
}

/** Executable for a script runtime. */
export function runtimeCommand(host: HostConfig, runtime: string): string {
  return Object.hasOwn(host.runtimes, runtime) ? (host.runtimes[runtime] as string) : runtime;
}

/** Fields present replace (intersect with) the declared permissions. */
export const PermissionOverrideSchema = z.object({
  events: z.array(z.string()).nullable().default(null),
  tools: z.boolean().nullable().default(null),
  commands: z.boolean().nullable().default(null),
  network: z.array(z.string()).nullable().default(null),
  input: z.array(z.string()).nullable().default(null),
});

export type PermissionOverride = z.output<typeof PermissionOverrideSchema>;

/**
 * `[extensions."<id>"]`: `enabled`, an optional `permissions` override that can only narrow
 * what the manifest declares, the extension's environment (`env`, `env_pass`) and everything
 * else as the extension's own config.
 *
 * ```toml
 * [extensions."miyoria.minecraft"]
 * env = { MIYORIA_MC_TOKEN = "${MC_TOKEN}" }   # set for the process (literal values)
 * env_pass = ["MIYORIA_MC_URL"]               # replaces the manifest's `[env] pass`
 * secrets = ["MC_API_KEY"]                    # Core variables handed over by exact name
 * run_in = "host"                             # or "sandbox"; default by kind (`defaultRunIn`)
 * tools."minecraft.say".risk = "high"         # the owner's word on one tool's risk
 * ```
 */
export interface ExtensionSettings {
  enabled: boolean | null;
  permissions: PermissionOverride | null;
  /** Variables set for the extension process. */
  env: Record<string, string>;
  /** Host variables passed through instead of the manifest's `[env] pass`; `null` = the manifest's. */
  envPass: string[] | null;
  /** Where it runs (`run_in`); `null`: the default for its kind (`defaultRunIn`). */
  runIn: RunIn | null;
  /**
   * Core environment variables the owner agrees to hand it (`secrets`), by exact name: the only
   * way a key or token Core holds reaches an extension besides a literal `env` value.
   */
  secrets: string[];
  /** The owner's word on its tools, by wire name (`tools."<name>".risk`). */
  tools: Record<string, ToolSetting>;
  config: JsonObject;
}

/** Where an extension's process runs: this machine, or a sandbox job. */
export type RunIn = "host" | "sandbox";

export interface ToolSetting {
  /** Replaces the risk the extension declared. */
  risk?: "low" | "medium" | "high";
}

const EnvSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());
const EnvPassSchema = z.array(z.string());
const RunInSchema = z.enum(["host", "sandbox"]);
const SecretsSchema = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
const ToolSettingsSchema = z.record(
  z.string(),
  z.strictObject({ risk: z.enum(["low", "medium", "high"]).optional() }),
);

/**
 * The top-level `[extensions]` section, one `[extensions."<id>"]` per extension, as
 * `extensionSettings` reads it: an `enabled` that is not a boolean counts as unset, and every
 * other key is the extension's own config, described by its `config.schema.json`.
 */
export const ExtensionsSectionSchema = z.record(
  z.string(),
  z.looseObject({
    enabled: z.boolean().optional(),
    permissions: PermissionOverrideSchema.optional(),
    env: EnvSchema.optional(),
    env_pass: EnvPassSchema.optional(),
    run_in: RunInSchema.optional(),
    secrets: SecretsSchema.optional(),
    tools: ToolSettingsSchema.optional(),
  }),
);

function parseSetting<S extends z.ZodType>(
  schema: S,
  value: unknown,
  id: string,
  key: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(
      "invalid",
      `[extensions."${id}"].${key}: ${z.prettifyError(result.error)}`,
      `extensions.${id}.${key}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export function extensionSettings(config: Config, id: string): ExtensionSettings {
  const all = config.section("extensions");
  const section = isJsonObject(all) && Object.hasOwn(all, id) ? all[id] : undefined;
  if (!isJsonObject(section)) {
    return {
      enabled: null,
      permissions: null,
      env: {},
      envPass: null,
      runIn: null,
      secrets: [],
      tools: {},
      config: {},
    };
  }
  const { enabled, permissions, env, env_pass, run_in, secrets, tools, ...rest } = section;
  const vars = env === undefined ? {} : parseSetting(EnvSchema, env, id, "env");
  const pass =
    env_pass === undefined ? null : parseSetting(EnvPassSchema, env_pass, id, "env_pass");
  const runIn = run_in === undefined ? null : parseSetting(RunInSchema, run_in, id, "run_in");
  const granted = secrets === undefined ? [] : parseSetting(SecretsSchema, secrets, id, "secrets");
  const toolSettings =
    tools === undefined ? {} : parseSetting(ToolSettingsSchema, tools, id, "tools");
  let parsed: PermissionOverride | null = null;
  if (permissions !== undefined) {
    const result = PermissionOverrideSchema.safeParse(permissions);
    if (!result.success) {
      throw new ConfigError(
        "invalid",
        `[extensions."${id}"].permissions: ${z.prettifyError(result.error)}`,
        `extensions.${id}.permissions`,
        { cause: result.error },
      );
    }
    parsed = result.data;
  }
  return {
    enabled: typeof enabled === "boolean" ? enabled : null,
    permissions: parsed,
    env: vars,
    envPass: pass,
    runIn,
    secrets: granted,
    tools: toolSettings,
    config: rest,
  };
}

/**
 * Where an extension runs when `run_in` does not say (docs/design/v6-sandbox.md §16 item 3): a
 * game adapter and anything granted `input` stay on this machine, because they work on its game
 * and its keyboard; everything else goes into a sandbox when the app has a launcher for that
 * (`ExtensionLauncherKey`), and runs here otherwise.
 */
export function defaultRunIn(kind: readonly string[], granted: Permissions): RunIn {
  return kind.includes("game-adapter") || granted.input.length > 0 ? "host" : "sandbox";
}

/**
 * What the host grants: declared ∩ override. `input` is never granted unless the override
 * lists it.
 */
export function grantedPermissions(
  settings: ExtensionSettings,
  declared: Permissions,
): Permissions {
  const o = settings.permissions;
  const intersect = (d: readonly string[], allowed: readonly string[] | null | undefined) =>
    allowed == null ? [...d] : d.filter((x) => allowed.includes(x));
  return {
    events: intersect(declared.events, o?.events),
    tools: declared.tools && (o?.tools ?? true),
    commands: declared.commands && (o?.commands ?? true),
    network: intersect(declared.network, o?.network),
    input: intersect(declared.input, o?.input ?? []),
  };
}
