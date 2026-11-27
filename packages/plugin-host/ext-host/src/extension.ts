// One extension process managed as the supervisor module `ext.<id>`.

import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
  type CommandRegistry,
  CommandRegistryKey,
  type CommandSpec,
  commandName,
  splitPath,
} from "@miyoria/commands";
import {
  ExtCommandsUnregisterParamsSchema,
  ExtEventsPublishParamsSchema,
  ExtEventsTopicsParamsSchema,
  ExtKeyParamsSchema,
  ExtLogParamsSchema,
  ExtScheduleCancelParamsSchema,
  ExtStatusResultSchema,
  ExtStorageSetParamsSchema,
  ExtToolsUnregisterParamsSchema,
} from "@miyoria/contracts/ext";
import {
  type ActuatorRegistry,
  ActuatorRegistryKey,
  actuatorsFor,
  externalLimits,
  externalToolCapability,
  GatedToolsKey,
  isGatedToolName,
} from "@miyoria/gate/actions";
import { type Tool, type ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  errorMessage,
  getLogger,
  HEALTHY,
  type Health,
  type Module,
  type ModuleCard,
  type ModuleContext,
  type ModuleManifest,
  TopicFilter,
  withTimeout,
} from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ModuleId,
  type PromptContributors,
  PromptContributorsKey,
  publishTaskEvent,
  TaskExecutorsKey,
  type Timestamp,
} from "@miyoria/types";
import { z } from "zod";
import {
  defaultRunIn,
  type HostConfig,
  type RunIn,
  runtimeCommand,
  type ToolSetting,
} from "./config.js";
import { type ExtensionEnv, extensionEnvReport, extensionSecrets } from "./env.js";
import { resolvePublish, wireEnvelope } from "./events.js";
import { type ChildLike, ExtensionLauncherKey, type LaunchSpec, localLauncher } from "./launch.js";
import type { ExtensionManifest, Permissions } from "./manifest.js";
import { validPattern } from "./manifest.js";
import {
  CommandSpecSchema,
  type Contributions,
  type ExecutorDecl,
  ExecutorDeclSchema,
  type InitializeParams,
  InitializeResultSchema,
  PROTOCOL_VERSION,
  registryToolName,
  type ToolDecl,
  ToolDeclSchema,
  validToolName,
} from "./protocol.js";
import {
  ExtensionCallError,
  execContextJson,
  invokeCommand,
  ProxyPrompt,
  ProxyTool,
  toolResultText,
} from "./proxy.js";
import {
  CLOSED,
  CONFLICT,
  METHOD_NOT_FOUND,
  Peer,
  RpcError,
  type RpcHandler,
  UNAVAILABLE,
} from "./rpc.js";
import { ExtensionSchedules } from "./schedules.js";
import { ProfileIdKey } from "./services.js";
import { ProxyExecutor, TaskExecutorRegistry } from "./tasks.js";

/** Version sent as `initialize.host.version`. */
export const HOST_VERSION = "0.1.0";

/** Module id of the host module every extension requires. */
export const EXTENSIONS_MODULE_ID = "extensions";

/** How long the host waits for an extension's `status` answer (the panel's card deadline). */
export const STATUS_TIMEOUT_MS = 500;

/** Lines an extension writes to stderr and `log` calls go here (logger `miyoria_ext`). */
const extLog = getLogger("miyoria_ext");

/** A discovered extension with the permissions the host grants it. */
export interface ExtensionSpec {
  manifest: ExtensionManifest;
  /** Absolute extension directory. */
  dir: string;
  granted: Permissions;
  /**
   * Host variables passed through and values set for the process (besides the platform
   * allowlist). Missing = the manifest's `[env] pass`, nothing set.
   */
  env?: ExtensionEnv;
  /** `[extensions."<id>"] run_in`; missing: `defaultRunIn`. */
  runIn?: RunIn | null;
  /** `[extensions."<id>"] secrets`: Core variables the owner hands it, by name. */
  secrets?: readonly string[];
  /** `[extensions."<id>"] tools`: the owner's word on its tools, by wire name. */
  tools?: Readonly<Record<string, ToolSetting>>;
}

/** What the extension's process environment is built from. */
export function specEnv(spec: ExtensionSpec): ExtensionEnv {
  return spec.env ?? { pass: spec.manifest.env.pass, set: {} };
}

export function extensionModuleId(spec: ExtensionSpec): ModuleId {
  return spec.manifest.moduleId();
}

export class ExtensionStartError extends Error {
  override readonly name = "ExtensionStartError";
}

/** Error of a crashed or misbehaving extension process (fails the module). */
export class ExtensionProcessError extends Error {
  override readonly name = "ExtensionProcessError";
}

interface ExitStatus {
  code: number | null;
  signal: string | null;
}

function formatExit(status: ExitStatus): string {
  return status.code !== null ? `exit code: ${status.code}` : `signal: ${status.signal}`;
}

/** Converts a manifest's JSON Schema into a zod schema for the panel, if zod understands it. */
function schemaFromJson(schema: JsonValue | null): z.ZodType | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return undefined;
  }
}

/**
 * Supervisor module running one extension process. Started after `agent` and `commands` when
 * present; requires the `extensions` host module.
 */
export class ExtensionModule implements Module {
  readonly manifest: ModuleManifest;
  readonly spec: ExtensionSpec;
  /** The extension's own config JSON Schema (`[config] schema`), as read from its file. */
  readonly configJsonSchema: JsonValue | null;
  readonly #host: HostConfig;
  #session: Session | null = null;
  /** Aborts a launch in progress and, at stop, whatever the launcher still holds. */
  #launch: AbortController | null = null;
  /** It answers the `status` request (its `initialize` contributions said so). */
  #answersStatus = false;

  constructor(spec: ExtensionSpec, host: HostConfig, schema: JsonValue | null = null) {
    const m = spec.manifest;
    const configSchema = schemaFromJson(schema);
    this.manifest = defineManifest(m.moduleId(), m.displayName(), {
      description: m.description ?? `Extension ${m.id} ${m.version}`,
      // `icon` of its manifest; the panel draws its default without one.
      ...(m.icon ? { icon: m.icon } : {}),
      category: "system",
      requires: [EXTENSIONS_MODULE_ID],
      optional: ["agent", "commands"],
      ...(configSchema ? { configSchema } : {}),
    });
    this.spec = spec;
    this.configJsonSchema = schema;
    this.#host = host;
  }

  /** Program and arguments that start the extension. */
  command(): { program: string; args: string[] } {
    const m = this.spec.manifest;
    const entry = join(this.spec.dir, m.entry);
    switch (m.runtime) {
      case "node":
        return { program: runtimeCommand(this.#host, "node"), args: [entry] };
      case "bun":
        return { program: runtimeCommand(this.#host, "bun"), args: ["run", entry] };
      case "deno": {
        const args = ["run", "--allow-read", "--allow-env"];
        if (this.spec.granted.network.length > 0) {
          args.push(`--allow-net=${this.spec.granted.network.join(",")}`);
        }
        args.push(entry);
        return { program: runtimeCommand(this.#host, "deno"), args };
      }
      case "binary":
        return { program: entry, args: [] };
    }
  }

  /** What the launcher is asked to start (environment and secrets resolved now, from `source`). */
  launchSpec(source: NodeJS.ProcessEnv = process.env): {
    spec: LaunchSpec;
    held: string[];
    missing: string[];
  } {
    const m = this.spec.manifest;
    const { program, args } = this.command();
    // Never the core's whole environment (its secrets): an allowlist (see `env.ts`).
    const report = extensionEnvReport(m.id, specEnv(this.spec), source);
    const wanted = this.spec.secrets ?? [];
    const secrets = extensionSecrets(wanted, source);
    return {
      spec: {
        extension: m.id,
        dir: this.spec.dir,
        runtime: m.runtime,
        program,
        args,
        cwd: this.spec.dir,
        env: report.env,
        network: [...this.spec.granted.network],
        secrets,
        runIn: this.spec.runIn ?? defaultRunIn(m.kind, this.spec.granted),
        runInChosen: this.spec.runIn !== undefined && this.spec.runIn !== null,
      },
      held: report.held,
      missing: wanted.filter((name) => !Object.hasOwn(secrets, name)),
    };
  }

  async start(ctx: ModuleContext): Promise<void> {
    const id = this.spec.manifest.id;
    const { spec, held, missing } = this.launchSpec();
    if (held.length > 0) {
      ctx.log.warn(
        { ext: id, held },
        "credentials not passed to the extension: name them exactly in env_pass, or list them in secrets",
      );
    }
    if (missing.length > 0) {
      ctx.log.warn(
        { ext: id, missing },
        "secrets the owner granted are not set in the environment",
      );
    }
    const launcher = ctx.services.get(ExtensionLauncherKey) ?? localLauncher();
    const launch = new AbortController();
    this.#launch = launch;
    let child: ChildLike;
    try {
      child = await launcher.launch(spec, launch.signal);
    } catch (error) {
      this.#launch = null;
      throw new ExtensionStartError(`spawning extension \`${id}\`: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (child.where.kind === "sandbox") {
      ctx.log.info(
        { ext: id, host: child.where.host, job: child.where.job },
        "extension in a sandbox",
      );
    }

    const session = new Session(ctx, this.spec, this.#host, child);
    this.#session = session;

    ctx.spawn("stderr", (signal) => forwardStderr(child, id, signal));
    ctx.spawn("rpc", async (signal) => {
      let protocolError: unknown = null;
      try {
        await session.peer.serve(child.stdout, session, signal);
      } catch (error) {
        protocolError = error;
      }
      if (signal.aborted || session.stopping) return;
      let status: string;
      const exited = await withTimeout(session.exited, 1000);
      if (exited) status = formatExit(exited);
      else {
        child.kill();
        status = "closed its stdout";
      }
      // Its tasks die with it (a terminal event each, code `crashed`).
      session.failTasks("crashed", `擴充套件結束了(${status})`);
      if (protocolError !== null) {
        throw new ExtensionProcessError(
          `extension \`${id}\` protocol error: ${errorMessage(protocolError)} (${status})`,
        );
      }
      throw new ExtensionProcessError(`extension \`${id}\` exited (${status})`);
    });
    ctx.spawn("events", () => session.forwardEvents());

    try {
      await this.#handshake(session);
      ctx.log.info({ ext: id }, "extension running");
    } catch (error) {
      this.#session = null;
      await this.#shutdown(session, false);
      this.#launch?.abort();
      this.#launch = null;
      throw error;
    }
    ctx.spawn("schedules", (signal) => session.runSchedules(signal));
  }

  async #handshake(session: Session): Promise<void> {
    const m = this.spec.manifest;
    const raw = session.ctx.rawConfig;
    const params: InitializeParams = {
      protocol: PROTOCOL_VERSION,
      host: { name: "miyoria", version: HOST_VERSION },
      extension: { id: m.id, version: m.version, dir: this.spec.dir, game: m.gameId() },
      config: (raw ?? {}) as JsonObject,
      permissions: this.spec.granted,
    };
    let result: JsonValue;
    try {
      result = await session.peer.request(
        "initialize",
        params as unknown as JsonValue,
        this.#host.init_timeout_ms,
      );
    } catch (error) {
      throw new ExtensionStartError(`initialize failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const parsed = InitializeResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new ExtensionStartError(`invalid initialize result: ${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.protocol !== PROTOCOL_VERSION) {
      throw new ExtensionStartError(protocolMismatch(parsed.data.protocol));
    }
    session.apply(parsed.data.contributions);
    this.#answersStatus = parsed.data.contributions.status;
  }

  /**
   * The extension's card, when it said it answers `status`: its facts, next thing and last error
   * (no actions: an extension's controls are its commands and tools). Nothing otherwise.
   */
  async card(): Promise<ModuleCard> {
    const session = this.#session;
    if (session === null || !this.#answersStatus) return { facts: [] };
    const answer = await session.peer.request("status", {}, STATUS_TIMEOUT_MS);
    const parsed = ExtStatusResultSchema.safeParse(answer);
    if (!parsed.success) {
      throw new Error(`invalid status result: ${z.prettifyError(parsed.error)}`);
    }
    const { facts, next, last_error } = parsed.data;
    return {
      facts: facts.map((f) => ({ ...f })),
      ...(next ? { next: { label: next.label, at: next.at as Timestamp } } : {}),
      ...(last_error
        ? { last_error: { at: last_error.at as Timestamp, message: last_error.message } }
        : {}),
    };
  }

  async #shutdown(session: Session, graceful: boolean): Promise<void> {
    session.stopping = true;
    if (graceful) {
      await withTimeout(
        session.peer.notify("shutdown", {}).catch(() => undefined),
        200,
      );
    }
    const grace = graceful ? this.#host.shutdown_grace_ms : 0;
    const exited = session.hasExited || (await withTimeout(session.exited, grace)) !== undefined;
    if (!exited) {
      session.child.kill();
      await withTimeout(session.exited, 2000);
    }
    session.cleanup();
  }

  async stop(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session) await this.#shutdown(session, true);
    this.#launch?.abort();
    this.#launch = null;
  }

  async health(): Promise<Health> {
    const s = this.#session;
    if (s && !s.peer.isClosed) return HEALTHY;
    return { status: "unhealthy", reason: "extension process is not running" };
  }
}

/** Why the host refuses an extension that speaks protocol `theirs`, saying which side is older. */
export function protocolMismatch(theirs: number): string {
  const older =
    theirs < PROTOCOL_VERSION
      ? "the extension is older: rebuild it against a newer @miyoria/sdk"
      : "the host is older: update Miyoria";
  return `the extension speaks extension protocol ${theirs} and the host speaks ${PROTOCOL_VERSION}; ${older}`;
}

async function forwardStderr(child: ChildLike, id: string, signal: AbortSignal): Promise<void> {
  const lines = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
  const onAbort = () => lines.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const line of lines) extLog.info({ ext: id }, line);
  } catch {
    // The stream broke; the rpc task reports the exit.
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** A registered tool: a game adapter's raw one in the gated registry, or a capability. */
type ToolReg =
  | { kind: "gated"; registry: ToolRegistry; tool: Tool }
  | { kind: "capability"; off: () => void };

interface CommandReg {
  registry: CommandRegistry;
  spec: CommandSpec;
}

function params<S extends z.ZodType>(schema: S, value: JsonValue): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw RpcError.invalidParams(z.prettifyError(result.error));
  return result.data;
}

/**
 * Tools under `game.` (registry `game_`) are reserved for the adapter that declared that game:
 * `game.<id>.*` (or `game_<id>_*`) with `own` = `<id>`.
 */
export function gameToolAllowed(wire: string, own: string | null): boolean {
  const name = registryToolName(wire);
  if (!name.startsWith("game_")) return true;
  if (own === null) return false;
  const rest = name.slice("game_".length);
  const prefix = registryToolName(own);
  return rest.startsWith(prefix) && rest.slice(prefix.length).startsWith("_");
}

/** State of one running extension process, shared by the module, its tasks and the RPC handler. */
class Session implements RpcHandler {
  readonly ctx: ModuleContext;
  readonly spec: ExtensionSpec;
  readonly host: HostConfig;
  readonly child: ChildLike;
  readonly peer: Peer;
  readonly grants: TopicFilter;
  readonly exited: Promise<ExitStatus>;
  hasExited = false;
  stopping = false;
  #patterns: string[] = [];
  #filter = new TopicFilter([]);
  #tools = new Map<string, ToolReg>();
  #commands = new Map<string, CommandReg>();
  #prompts = new Map<string, PromptContributors>();
  #executor: { proxy: ProxyExecutor; registry: TaskExecutorRegistry } | null = null;
  #actuators: ActuatorRegistry | null = null;
  #schedules: ExtensionSchedules | null = null;

  constructor(ctx: ModuleContext, spec: ExtensionSpec, host: HostConfig, child: ChildLike) {
    this.ctx = ctx;
    this.spec = spec;
    this.host = host;
    this.child = child;
    this.peer = new Peer(child.stdin);
    this.grants = new TopicFilter(spec.granted.events);
    this.exited = child.exited.then((status) => {
      this.hasExited = true;
      return status;
    });
  }

  get id(): string {
    return this.spec.manifest.id;
  }

  async forwardEvents(): Promise<void> {
    const sub = this.ctx.subscribe("*");
    const me = this.ctx.id;
    for await (const env of sub) {
      if (env.source === me) continue;
      const topic = env.type;
      if (!this.grants.matches(topic) || !this.#filter.matches(topic)) continue;
      const value = { envelope: wireEnvelope(env) } as unknown as JsonValue;
      if (!this.peer.tryNotify("event", value)) {
        this.ctx.log.warn({ ext: this.id, topic }, "extension is not keeping up; event dropped");
      }
    }
  }

  /**
   * Applies the contributions returned by `initialize`. Permission violations fail the start;
   * a missing registry only warns.
   */
  apply(c: Contributions): void {
    const fatal = (e: unknown) => !(e instanceof RpcError) || e.code !== UNAVAILABLE;
    const message = (e: unknown) => errorMessage(e);
    try {
      this.subscribe(c.subscriptions);
    } catch (e) {
      throw new ExtensionStartError(`subscriptions: ${message(e)}`);
    }
    for (const decl of c.tools) {
      try {
        this.registerTool(decl);
      } catch (e) {
        if (fatal(e)) throw new ExtensionStartError(`tool \`${decl.name}\`: ${message(e)}`);
        this.ctx.log.warn(
          { ext: this.id, tool: decl.name, error: message(e) },
          "tool not registered",
        );
      }
    }
    for (const spec of c.commands) {
      const name = commandName(spec);
      try {
        this.registerCommand(spec);
      } catch (e) {
        if (fatal(e)) throw new ExtensionStartError(`command \`${name}\`: ${message(e)}`);
        this.ctx.log.warn(
          { ext: this.id, command: name, error: message(e) },
          "command not registered",
        );
      }
    }
    for (const key of c.prompts) {
      try {
        this.registerPrompt(key);
      } catch (e) {
        if (fatal(e)) throw new ExtensionStartError(`prompt \`${key}\`: ${message(e)}`);
        this.ctx.log.warn(
          { ext: this.id, prompt: key, error: message(e) },
          "prompt not registered",
        );
      }
    }
    if (c.executor !== null) {
      try {
        this.registerExecutor(c.executor);
      } catch (e) {
        if (fatal(e)) throw new ExtensionStartError(`executor: ${message(e)}`);
        this.ctx.log.warn({ ext: this.id, error: message(e) }, "task executor not registered");
      }
    }
  }

  /** Topic prefix of this extension's task events: its game's namespace, else `ext.<id>`. */
  taskOwner(): string {
    const game = this.spec.manifest.gameId();
    return game !== null ? `game.${game}` : `ext.${this.id}`;
  }

  /** `tasks.register`: (re)places this extension's executor in the `TaskExecutors` registry. */
  registerExecutor(decl: ExecutorDecl): JsonValue {
    const registry = this.ctx.services.get(TaskExecutorsKey);
    if (!(registry instanceof TaskExecutorRegistry)) {
      throw new RpcError(UNAVAILABLE, "the task executor registry is not available");
    }
    if (this.stopping) throw Session.closedError();
    const owner = this.taskOwner();
    const current = registry.get(owner);
    if (current !== undefined && current !== this.#executor?.proxy) {
      throw new RpcError(CONFLICT, `an executor for \`${owner}\` is already registered`);
    }
    if (this.#executor) {
      this.#executor.proxy.close("superseded", "擴充套件換了一個執行器");
      this.#executor.registry.unregister(this.#executor.proxy);
    }
    const proxy = new ProxyExecutor(
      this.peer,
      {
        owner,
        name: decl.name,
        goals: decl.goals.map((g) => ({ ...g })),
        guide: decl.guide,
      },
      {
        callTimeoutMs: this.host.call_timeout_ms,
        steer: decl.steer,
        graceMs: this.host.task_grace_ms,
        publish: (event) => {
          publishTaskEvent(this.ctx.publisher, owner, event);
        },
        now: () => this.ctx.clock.now(),
      },
    );
    registry.register(proxy);
    this.#executor = { proxy, registry };
    return { owner };
  }

  /** The process is gone: every task it was running fails with `code`. */
  failTasks(code: "crashed" | "disconnected", detail: string): void {
    const executor = this.#executor;
    if (!executor) return;
    executor.proxy.close(code, detail);
  }

  subscribe(topics: readonly string[]): JsonValue {
    const bad = topics.find((t) => !validPattern(t));
    if (bad !== undefined) throw RpcError.invalidParams(`bad topic pattern \`${bad}\``);
    for (const t of topics) if (!this.#patterns.includes(t)) this.#patterns.push(t);
    this.#filter = new TopicFilter(this.#patterns);
    return { topics: [...this.#patterns] };
  }

  unsubscribe(topics: readonly string[]): JsonValue {
    this.#patterns = this.#patterns.filter((p) => !topics.includes(p));
    this.#filter = new TopicFilter(this.#patterns);
    return { topics: [...this.#patterns] };
  }

  /** `events.publish`: one event of a registered type, by its definition (see `events.ts`). */
  publish(raw: JsonValue): JsonValue {
    const p = params(ExtEventsPublishParamsSchema, raw);
    const who = { id: this.id, game: this.spec.manifest.gameId(), grants: this.grants };
    const { definition, data } = resolvePublish(who, p.type, p.data as JsonValue);
    this.ctx.publish(definition, data, {
      type: p.type,
      turn: p.turn,
      parent: p.parent,
      key: p.key,
    });
    return {};
  }

  static closedError(): RpcError {
    return new RpcError(CLOSED, "the extension is stopping");
  }

  registerTool(decl: ToolDecl): JsonValue {
    if (!this.spec.granted.tools) throw RpcError.denied("the `tools` permission is not granted");
    if (!validToolName(decl.name)) {
      throw RpcError.invalidParams(`invalid tool name \`${decl.name}\``);
    }
    if (!gameToolAllowed(decl.name, this.spec.manifest.gameId())) {
      throw RpcError.denied(
        `tool \`${decl.name}\` is in another game's namespace; only the adapter declaring that \`game\` may use \`game.<id>.*\``,
      );
    }
    const name = registryToolName(decl.name);
    // A game adapter's raw tools (`game_<id>_*`: launch, quit, game chat) are never offered to
    // chat turns: they go to the gated registry, which only capabilities behind the gate use.
    if (isGatedToolName(name)) return this.#registerGated(decl, name);
    const tools = this.ctx.services.get(ToolRegistryKey);
    if (!tools && !this.ctx.services.get(ActuatorRegistryKey)) {
      throw new RpcError(UNAVAILABLE, "the tool registry is not available");
    }
    if (this.stopping) throw Session.closedError();
    if (tools?.get(name) !== undefined && !this.#tools.has(name)) {
      throw new RpcError(CONFLICT, `tool \`${name}\` is already registered`);
    }
    const capability = this.toolCapability(decl, name);
    this.#actuators ??= actuatorsFor(this.ctx);
    const previous = this.#tools.get(name);
    if (previous) releaseTool(previous, name);
    let off: () => void;
    try {
      off = this.#actuators.register(capability);
    } catch (e) {
      throw RpcError.invalidParams(e);
    }
    this.#tools.set(name, { kind: "capability", off });
    return { name };
  }

  /**
   * An extension's tool as a gated capability `ext.<id>.<wire>` (docs/design/v6-agent-split.md
   * §3.6): the risk it declared unless the owner set one, its node (default `tools.ext.<id>`, a
   * work node: a member she knows well enough may use it), its limits and audit. A tool that
   * does not say otherwise counts against the work limits (`[modules.actions.work]`), not the
   * medium tier's 20 s cooldown: an extension's tool is usually one step of what she is doing.
   */
  toolCapability(decl: ToolDecl, name: string) {
    const m = this.spec.manifest;
    const peer = this.peer;
    const timeout = this.host.call_timeout_ms;
    const wire = decl.name;
    const risk = this.spec.tools?.[wire]?.risk ?? decl.risk;
    const parameters = isJsonObject(decl.parameters)
      ? decl.parameters
      : { type: "object", properties: {} };
    const limits = externalLimits(decl.limits);
    return externalToolCapability({
      capability: `ext.${m.id}.${wire}`,
      tool: name,
      summary: `擴充「${m.displayName()}」的工具 ${wire}`,
      description: decl.description,
      parameters,
      risk,
      permission: decl.permission ?? `tools.ext.${m.id}`,
      group: "extension",
      readOnly: decl.read_only,
      work: decl.work ?? true,
      ...(decl.followup === true ? { followup: true } : {}),
      ...(limits === undefined ? {} : { limits }),
      source: `ext.${m.id}`,
      async call(args, ctx) {
        let result: JsonValue;
        try {
          result = await peer.request(
            "tools.call",
            { name: wire, args, context: execContextJson(ctx) },
            timeout,
            ctx.signal,
          );
        } catch (error) {
          if (error instanceof RpcError) {
            throw new ExtensionCallError(error.message, { cause: error });
          }
          throw error;
        }
        return { text: toolResultText(result) };
      },
    });
  }

  #registerGated(decl: ToolDecl, name: string): JsonValue {
    const registry = this.ctx.services.get(GatedToolsKey);
    if (!registry) throw new RpcError(UNAVAILABLE, "the gated tool registry is not available");
    if (this.stopping) throw Session.closedError();
    if (registry.get(name) !== undefined && !this.#tools.has(name)) {
      throw new RpcError(CONFLICT, `tool \`${name}\` is already registered`);
    }
    const tool = new ProxyTool(
      this.peer,
      decl.name,
      { name, description: decl.description, parameters: decl.parameters },
      decl.permission,
      this.host.call_timeout_ms,
      decl.read_only,
    );
    try {
      registry.register(tool);
    } catch (e) {
      throw RpcError.invalidParams(e);
    }
    this.#tools.set(name, { kind: "gated", registry, tool });
    return { name };
  }

  unregisterTool(wire: string): JsonValue {
    const name = registryToolName(wire);
    const reg = this.#tools.get(name);
    this.#tools.delete(name);
    if (reg) releaseTool(reg, name);
    return {};
  }

  /** This extension's schedules, once the settings store is there. */
  #scheduleBook(): ExtensionSchedules {
    if (this.#schedules) return this.#schedules;
    const { store, profile } = this.#storage();
    this.#schedules = new ExtensionSchedules({
      extension: this.id,
      store,
      profile,
      clock: this.ctx.clock,
      offsetMinutes: this.host.utc_offset_minutes,
      fire: (p) =>
        !this.stopping && this.peer.tryNotify("schedule.fire", p as unknown as JsonValue),
      warn: (message, fields) => this.ctx.log.warn({ ext: this.id, ...fields }, message),
    });
    return this.#schedules;
  }

  /** Fires this extension's schedules while it runs (nothing without a settings store). */
  async runSchedules(signal: AbortSignal): Promise<void> {
    if (!this.ctx.services.get(SettingsStoreKey)) return;
    await this.#scheduleBook().run(signal);
  }

  registerCommand(spec: CommandSpec): JsonValue {
    if (!this.spec.granted.commands) {
      throw RpcError.denied("the `commands` permission is not granted");
    }
    const registry = this.ctx.services.get(CommandRegistryKey);
    if (!registry) throw new RpcError(UNAVAILABLE, "the command registry is not available");
    if (this.stopping) throw Session.closedError();
    const key = spec.path.join(" ");
    if (registry.get(spec.path) !== undefined && !this.#commands.has(key)) {
      throw new RpcError(CONFLICT, `command \`${commandName(spec)}\` is already registered`);
    }
    const peer = this.peer;
    const timeout = this.host.call_timeout_ms;
    const handlerSpec = structuredClone(spec);
    try {
      registry.register(spec, (inv) => invokeCommand(peer, handlerSpec, inv, timeout));
    } catch (e) {
      throw RpcError.invalidParams(e);
    }
    this.#commands.set(key, { registry, spec: structuredClone(spec) });
    return {};
  }

  unregisterCommand(path: readonly string[]): JsonValue {
    const key = path.join(" ");
    const reg = this.#commands.get(key);
    this.#commands.delete(key);
    if (reg) unregisterCommandIfOurs(reg);
    return {};
  }

  promptKey(key: string): string {
    return `ext.${this.id}.${key}`;
  }

  registerPrompt(key: string): JsonValue {
    if (key.length === 0 || key.length > 64) {
      throw RpcError.invalidParams("prompt key must be 1-64 chars");
    }
    const registry = this.ctx.services.get(PromptContributorsKey);
    if (!registry) throw new RpcError(UNAVAILABLE, "prompt contributors are not available");
    const full = this.promptKey(key);
    if (this.stopping) throw Session.closedError();
    registry.register(new ProxyPrompt(this.peer, full, key, this.host.prompt_timeout_ms));
    this.#prompts.set(full, registry);
    return { key: full };
  }

  unregisterPrompt(key: string): JsonValue {
    const full = this.promptKey(key);
    const registry = this.#prompts.get(full);
    this.#prompts.delete(full);
    registry?.unregister(full);
    return {};
  }

  #storage() {
    const store = this.ctx.services.get(SettingsStoreKey);
    if (!store) throw new RpcError(UNAVAILABLE, "storage is not available");
    const profile = this.ctx.services.get(ProfileIdKey) ?? "default";
    return { store, profile };
  }

  storageKey(key: string): string {
    if (key.length === 0 || key.length > 200) {
      throw RpcError.invalidParams("storage key must be 1-200 chars");
    }
    return `ext:${this.id}:${key}`;
  }

  log(raw: JsonValue): void {
    const parsed = ExtLogParamsSchema.safeParse(raw);
    if (!parsed.success) return;
    const p = parsed.data;
    const fields = p.fields === null ? "" : JSON.stringify(p.fields);
    const bindings = { ext: this.id, fields };
    switch (p.level) {
      case "error":
        extLog.error(bindings, p.message);
        break;
      case "warn":
        extLog.warn(bindings, p.message);
        break;
      case "debug":
        extLog.debug(bindings, p.message);
        break;
      case "trace":
        extLog.trace(bindings, p.message);
        break;
      default:
        extLog.info(bindings, p.message);
    }
  }

  /** Removes everything this session registered. Idempotent. */
  cleanup(): void {
    this.stopping = true;
    const tools = this.#tools;
    const commands = this.#commands;
    const prompts = this.#prompts;
    this.#tools = new Map();
    this.#commands = new Map();
    this.#prompts = new Map();
    for (const [name, reg] of tools) releaseTool(reg, name);
    for (const reg of commands.values()) unregisterCommandIfOurs(reg);
    for (const [key, registry] of prompts) registry.unregister(key);
    const executor = this.#executor;
    this.#executor = null;
    if (executor) {
      executor.proxy.close("disconnected", "擴充套件停止了");
      executor.registry.unregister(executor.proxy);
    }
  }

  async request(method: string, p: JsonValue): Promise<JsonValue> {
    switch (method) {
      case "events.subscribe":
        return this.subscribe(params(ExtEventsTopicsParamsSchema, p).topics);
      case "events.unsubscribe":
        return this.unsubscribe(params(ExtEventsTopicsParamsSchema, p).topics);
      case "events.publish":
        return this.publish(p);
      case "tools.register":
        return this.registerTool(params(ToolDeclSchema, p));
      case "tools.unregister":
        return this.unregisterTool(params(ExtToolsUnregisterParamsSchema, p).name);
      case "commands.register":
        return this.registerCommand(params(CommandSpecSchema, p));
      case "commands.unregister": {
        const path = params(ExtCommandsUnregisterParamsSchema, p).path;
        return this.unregisterCommand(typeof path === "string" ? splitPath(path) : path);
      }
      case "tasks.register":
        return this.registerExecutor(params(ExecutorDeclSchema, p));
      case "prompt.register":
        return this.registerPrompt(params(ExtKeyParamsSchema, p).key);
      case "prompt.unregister":
        return this.unregisterPrompt(params(ExtKeyParamsSchema, p).key);
      case "storage.get": {
        const key = this.storageKey(params(ExtKeyParamsSchema, p).key);
        const { store, profile } = this.#storage();
        try {
          return { value: await store.get(profile, key) };
        } catch (e) {
          throw RpcError.internal(e);
        }
      }
      case "storage.set": {
        const set = params(ExtStorageSetParamsSchema, p);
        const key = this.storageKey(set.key);
        const { store, profile } = this.#storage();
        try {
          await store.set(profile, key, (set.value ?? null) as JsonValue | null);
        } catch (e) {
          throw RpcError.internal(e);
        }
        return {};
      }
      case "schedule.set":
        return (await this.#scheduleBook().set(p)) as unknown as JsonValue;
      case "schedule.cancel": {
        const id = params(ExtScheduleCancelParamsSchema, p).id;
        return { cancelled: await this.#scheduleBook().cancel(id) };
      }
      case "schedule.list":
        return (await this.#scheduleBook().list()) as unknown as JsonValue;
      case "log":
        this.log(p);
        return {};
      default:
        throw new RpcError(METHOD_NOT_FOUND, `unknown method \`${method}\``);
    }
  }

  notification(method: string, p: JsonValue): void {
    if (method === "log") this.log(p);
    else if (method === "task.event") this.#executor?.proxy.onEvent(p);
    else this.ctx.log.debug({ ext: this.id, method }, "ignored notification");
  }
}

function releaseTool(reg: ToolReg, name: string): void {
  if (reg.kind === "capability") reg.off();
  else if (reg.registry.get(name) === reg.tool) reg.registry.unregister(name);
}

function unregisterCommandIfOurs(reg: CommandReg): void {
  const current = reg.registry.get(reg.spec.path);
  if (current !== undefined && isDeepStrictEqual(current, reg.spec)) {
    reg.registry.unregister(commandName(reg.spec));
  }
}
