// The MCP client side: one supervised connection per server (configured in `[mcp.servers.*]`,
// or bundled with an extension) whose tools are mirrored into the `ActuatorRegistry` as gated
// capabilities `mcp.<server>.<tool>`: the server's risk, rate limits, audit, `on_own`, review
// for high risk, and its node `tools.mcp.<server>` (a work node: members she knows well enough
// may use it). The model sees them under their old registry names `mcp_<server>_<tool>`.

import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Stream } from "node:stream";
import {
  type ActuatorRegistry,
  type Capability,
  type ExternalToolAnswer,
  externalToolCapability,
  type Risk,
} from "@miyoria/gate/actions";
import { MIYORIA_VERSION } from "@miyoria/llm/llm";
import type { ToolRegistry } from "@miyoria/llm/tools";
import { errorMessage, getLogger, sleep, withTimeout } from "@miyoria/runtime/kernel";
import { type Clock, isJsonObject, type JsonObject, type JsonValue } from "@miyoria/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type Tool as McpToolInfo,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";
import {
  compactSchema,
  flattenResult,
  registryName,
  stdioEnv,
  ToolFilter,
  truncateChars,
} from "./policy.js";
import type { McpStatus } from "./status.js";

const log = getLogger("mcp.client");

/** How long a closing connection gets before we stop waiting. */
const CLOSE_GRACE_MS = 5_000;

/** Thrown by MCP tools; the message goes back to the model. */
export class McpToolError extends Error {
  override readonly name = "McpToolError";
}

/** A connection attempt or session failure. */
export class McpConnectionError extends Error {
  override readonly name = "McpConnectionError";
}

/**
 * Registers capabilities in the actuator registry and remembers what it added (by tool name), so
 * everything can be removed on stop. After `close` nothing more can be registered.
 */
export class Registrar {
  readonly #actuators: ActuatorRegistry;
  /** The model's tools, to refuse a name another module already uses. */
  readonly #tools: ToolRegistry | null;
  readonly #added = new Map<string, () => void>();
  #closed = false;

  constructor(actuators: ActuatorRegistry, tools: ToolRegistry | null = null) {
    this.#actuators = actuators;
    this.#tools = tools;
  }

  register(capability: Capability<JsonObject>): void {
    if (this.#closed) throw new McpConnectionError("MCP module is stopping");
    const name = capability.tool?.name ?? capability.name;
    if (this.#tools?.get(name) !== undefined && !this.#added.has(name)) {
      throw new McpConnectionError(`tool \`${name}\` is already registered by something else`);
    }
    this.#added.get(name)?.();
    this.#added.set(name, this.#actuators.register(capability));
  }

  unregister(name: string): void {
    const off = this.#added.get(name);
    this.#added.delete(name);
    off?.();
  }

  /** Removes every capability this registrar added and refuses new ones. */
  close(): void {
    this.#closed = true;
    for (const off of this.#added.values()) off();
    this.#added.clear();
  }
}

/** What one MCP tool becomes. */
export interface McpToolOptions {
  server: string;
  /** Registry name, `mcp_<server>_<tool>` (maybe hashed). */
  name: string;
  info: McpToolInfo;
  permission: string | null;
  client: Client;
  config: ServerConfig;
}

/** The gate's tier for a tool: the owner's `risk`, else low for a trusted read-only hint. */
export function mcpToolRisk(config: ServerConfig, info: McpToolInfo): Risk {
  if (config.risk !== null) return config.risk;
  return trustedReadOnly(config, info) ? "low" : "medium";
}

function trustedReadOnly(config: ServerConfig, info: McpToolInfo): boolean {
  return config.trust_read_only_hint && info.annotations?.readOnlyHint === true;
}

/** Capability name of a tool: `mcp.<server>.<tool part of its registry name>`. */
export function mcpCapabilityName(server: string, name: string): string {
  const prefix = `mcp_${server}_`;
  return `mcp.${server}.${name.startsWith(prefix) ? name.slice(prefix.length) : name}`;
}

/** A tool of an MCP server as a gated capability. */
export function mcpToolCapability(o: McpToolOptions): Capability<JsonObject> {
  const { client, config, server } = o;
  const remoteName = o.info.name;
  // What the model does not need (`$schema`, `title`, `examples`, ...) costs tokens every turn.
  const schema = compactSchema((o.info.inputSchema ?? {}) as JsonValue);
  const parameters: JsonObject = isJsonObject(schema) ? { ...schema } : {};
  if (Object.keys(parameters).length === 0) parameters.type = "object";
  const description = o.info.description ?? o.info.title ?? remoteName;
  const risk = mcpToolRisk(config, o.info);
  return externalToolCapability({
    capability: mcpCapabilityName(server, o.name),
    tool: o.name,
    summary: `MCP 伺服器「${server}」的工具 ${remoteName}`,
    description,
    parameters,
    risk,
    permission: o.permission,
    group: "mcp",
    readOnly: risk === "low" && trustedReadOnly(config, o.info),
    // One step of what she is doing, like an extension's tool: the work limits, not a cooldown.
    work: true,
    source: `mcp.${server}`,
    async call(args, ctx): Promise<ExternalToolAnswer> {
      let result: CallToolResult;
      try {
        result = (await client.callTool({ name: remoteName, arguments: args }, undefined, {
          timeout: config.callTimeoutMs,
          signal: ctx.signal,
        })) as CallToolResult;
      } catch (error) {
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          throw new McpToolError(
            `MCP tool \`${remoteName}\` on server \`${server}\` timed out after ${config.callTimeoutMs} ms`,
            { cause: error },
          );
        }
        throw new McpToolError(
          `MCP tool \`${remoteName}\` on server \`${server}\` failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      const text = truncateChars(flattenResult(result), config.max_result_chars);
      if (result.isError === true) throw new McpToolError(text === "" ? "(empty error)" : text);
      return { text };
    },
  });
}

/** Why one connection attempt / session ended. */
type SessionEnd =
  | { kind: "cancelled" }
  /** Never got as far as `connected`. */
  | { kind: "connect_failed"; error: unknown }
  /** Was connected, then lost or broke. */
  | { kind: "lost"; error: unknown; livedMs: number };

/** Message of an error with its cause chain (like anyhow's `{:#}`). */
function chain(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  while (cur !== undefined && cur !== null && parts.length < 8) {
    const msg = errorMessage(cur);
    // Skip causes whose text is already part of the message they were wrapped in.
    if (!parts.some((p) => p.includes(msg))) parts.push(msg);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(": ");
}

/** A one-shot-at-a-time wake-up (a pending wake-up is remembered until consumed). */
class Notify {
  #pending = false;
  #waiter: (() => void) | null = null;

  notify(): void {
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w();
    } else this.#pending = true;
  }

  wait(): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }
}

export interface ServerRunnerOptions {
  name: string;
  config: ServerConfig;
  /**
   * Opens the connection instead of the configured `command` / `url` (a server an extension
   * bundles, started by its launcher).
   */
  transport?: (signal: AbortSignal) => Promise<Transport>;
  status: McpStatus;
  registrar: Registrar;
  backoffInitialMs: number;
  backoffMaxMs: number;
  clock: Clock;
}

/** Keeps one server connected for as long as the module runs. */
export class ServerRunner {
  readonly name: string;
  readonly config: ServerConfig;
  readonly #status: McpStatus;
  readonly #registrar: Registrar;
  readonly #backoffInitialMs: number;
  readonly #backoffMaxMs: number;
  readonly #clock: Clock;
  readonly #transport: ((signal: AbortSignal) => Promise<Transport>) | null;
  #connects = 0;

  constructor(options: ServerRunnerOptions) {
    this.name = options.name;
    this.config = options.config;
    this.#status = options.status;
    this.#registrar = options.registrar;
    this.#backoffInitialMs = options.backoffInitialMs;
    this.#backoffMaxMs = options.backoffMaxMs;
    this.#clock = options.clock;
    this.#transport = options.transport ?? null;
  }

  /** Connects, mirrors tools and reconnects with backoff until `signal` aborts. Never rejects. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.#backoffInitialMs;
    for (;;) {
      this.#status.update(this.name, (s) => {
        s.state = "connecting";
      });
      const end = await this.#session(signal);
      this.#clear();
      if (end.kind === "cancelled") break;
      if (end.kind === "lost" && end.livedMs >= this.#backoffMaxMs) {
        backoff = this.#backoffInitialMs;
      }
      const message = chain(end.error);
      log.warn(
        { server: this.name, error: message, retry_in_ms: backoff },
        "MCP server unavailable",
      );
      this.#status.update(this.name, (s) => {
        s.state = "failed";
        s.tools = [];
        s.last_error = message;
      });
      try {
        await sleep(backoff, signal);
      } catch {
        break;
      }
      backoff = Math.min(backoff * 2, this.#backoffMaxMs);
    }
    this.#clear();
    log.debug({ server: this.name }, "MCP server runner stopped");
  }

  /** Unregisters this server's tools. */
  #clear(): void {
    for (const name of this.#status.server(this.name)?.tools ?? []) {
      this.#registrar.unregister(name);
    }
    this.#status.update(this.name, (s) => {
      s.tools = [];
    });
  }

  async #session(signal: AbortSignal): Promise<SessionEnd> {
    if (signal.aborted) return { kind: "cancelled" };
    const toolsChanged = new Notify();
    let closed = false;
    let onClosed: () => void = () => {};
    const closedPromise = new Promise<void>((resolve) => {
      onClosed = resolve;
    });
    let client: Client;
    try {
      client = await connect(this.name, this.config, {
        signal,
        transport: this.#transport,
        onToolsChanged: () => toolsChanged.notify(),
        onClose: () => {
          closed = true;
          onClosed();
        },
      });
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      return { kind: "connect_failed", error };
    }

    const filter = new ToolFilter(this.config.tools_allow, this.config.tools_deny);
    let livedFrom: number | null = null;
    let failure: unknown = null;
    const aborted = new Promise<"abort">((resolve) => {
      if (signal.aborted) resolve("abort");
      signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });
    try {
      await this.#syncTools(client, filter);
      this.#connects += 1;
      livedFrom = this.#clock.now();
      const reconnects = Math.max(this.#connects - 1, 0);
      this.#status.update(this.name, (s) => {
        s.state = "connected";
        s.reconnects = reconnects;
      });
      log.info({ server: this.name }, "MCP server connected");
      for (;;) {
        const what = await Promise.race([
          aborted,
          closedPromise.then(() => "closed" as const),
          toolsChanged.wait().then(() => "changed" as const),
        ]);
        if (what === "abort") break;
        if (what === "closed") throw new McpConnectionError("connection closed");
        log.debug({ server: this.name }, "MCP tool list changed");
        await this.#syncTools(client, filter);
      }
    } catch (error) {
      failure = error;
    }

    // Closing the client also ends the child process.
    if (!closed) {
      const done = await withTimeout(
        client.close().then(
          () => true,
          () => true,
        ),
        CLOSE_GRACE_MS,
      );
      if (done === undefined)
        log.warn({ server: this.name }, "MCP connection did not close in time");
    }
    if (signal.aborted || failure === null) return { kind: "cancelled" };
    if (livedFrom === null) return { kind: "connect_failed", error: failure };
    return { kind: "lost", error: failure, livedMs: this.#clock.now() - livedFrom };
  }

  /** Lists the server's tools and makes the registry match the allowed ones. */
  async #syncTools(client: Client, filter: ToolFilter): Promise<void> {
    const listed = await listAllTools(client, this.config.connectTimeoutMs);
    const remoteCount = listed.length;
    const allowed = listed
      .filter((t) => filter.allows(t.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const permission = this.config.permissionNode(this.name);
    const wanted = new Map<string, Capability<JsonObject>>();
    const taken = new Set<string>();
    for (const tool of allowed) {
      const name = registryName(this.name, tool.name, taken);
      if (name === null) {
        log.warn(
          { server: this.name, tool: tool.name },
          "cannot derive a unique tool name, skipping",
        );
        continue;
      }
      taken.add(name);
      wanted.set(
        name,
        mcpToolCapability({
          server: this.name,
          name,
          info: tool,
          permission,
          client,
          config: this.config,
        }),
      );
    }

    const previous = this.#status.server(this.name)?.tools ?? [];
    for (const old of previous) if (!wanted.has(old)) this.#registrar.unregister(old);
    const registered: string[] = [];
    for (const name of [...wanted.keys()].sort()) {
      try {
        this.#registrar.register(wanted.get(name) as Capability<JsonObject>);
        registered.push(name);
      } catch (error) {
        log.warn(
          { server: this.name, tool: name, error: errorMessage(error) },
          "cannot register MCP tool",
        );
      }
    }
    this.#status.update(this.name, (s) => {
      s.tools = registered;
      s.remote_tool_count = remoteCount;
    });
  }
}

async function listAllTools(client: Client, timeoutMs: number): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = [];
  let cursor: string | undefined;
  do {
    let page: Awaited<ReturnType<Client["listTools"]>>;
    try {
      page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: timeoutMs,
      });
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new McpConnectionError("timed out listing tools", { cause: error });
      }
      throw new McpConnectionError(`cannot list tools: ${errorMessage(error)}`, { cause: error });
    }
    out.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor !== "");
  return out;
}

interface ConnectOptions {
  signal: AbortSignal;
  transport?: ((signal: AbortSignal) => Promise<Transport>) | null;
  onToolsChanged: () => void;
  onClose: () => void;
}

function newClient(options: ConnectOptions): Client {
  const client = new Client({ name: "miyoria", version: MIYORIA_VERSION }, { capabilities: {} });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    options.onToolsChanged();
  });
  client.onclose = options.onClose;
  client.onerror = (err) => log.debug({ err }, "MCP transport error");
  return client;
}

function isSpawnError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn")
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves `command` through `PATH` (and `PATHEXT` on Windows, so shims like `npx.cmd` work),
 * like rmcp's `which_command`. Returns `null` when nothing matches.
 */
export function whichCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = process.platform === "win32";
  const exts = windows
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")]
    : [""];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    for (const ext of exts) if (isFile(command + ext)) return command + ext;
    return null;
  }
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Opens the transport and runs the MCP handshake, within the connect timeout. */
async function connect(
  name: string,
  config: ServerConfig,
  options: ConnectOptions,
): Promise<Client> {
  const timeoutMs = config.connectTimeoutMs;
  const client = newClient(options);
  if (options.transport) {
    let transport: Transport;
    try {
      transport = await options.transport(options.signal);
    } catch (error) {
      throw new McpConnectionError(`cannot start the server: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    try {
      await withConnectTimeout(
        client.connect(transport, { timeout: timeoutMs, signal: options.signal }),
        timeoutMs,
        transport,
      );
    } catch (error) {
      throw new McpConnectionError(`MCP handshake failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return client;
  }
  if (config.effectiveTransport() === "stdio") {
    const command = config.command ?? "";
    if (whichCommand(command) === null) {
      throw new McpConnectionError(`cannot start \`${command}\`: program not found`);
    }
    // Not the whole host environment: it holds the Discord and LLM tokens.
    const env = stdioEnv(process.env, config.env_pass, config.env);
    const transport = new StdioClientTransport({
      command,
      args: config.args,
      env,
      stderr: "pipe",
      ...(config.cwd !== null ? { cwd: config.cwd } : {}),
    });
    const tail: string[] = [];
    collectStderr(transport.stderr, name, tail);
    try {
      await withConnectTimeout(
        client.connect(transport, { timeout: timeoutMs, signal: options.signal }),
        timeoutMs,
        transport,
      );
    } catch (error) {
      if (isSpawnError(error)) {
        throw new McpConnectionError(`cannot start \`${command}\`: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      // Let the stderr reader catch up so the cause is included.
      await sleep(20);
      const lines = tail.join(" | ");
      throw new McpConnectionError(
        lines === ""
          ? `MCP handshake failed: ${errorMessage(error)}`
          : `MCP handshake failed: ${errorMessage(error)} (stderr: ${lines})`,
        { cause: error },
      );
    }
    return client;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(config.headers)) {
    if (key.toLowerCase() === "authorization") {
      const token = value.startsWith("Bearer ")
        ? value.slice(7)
        : value.startsWith("bearer ")
          ? value.slice(7)
          : null;
      if (token === null) {
        throw new McpConnectionError('only `Authorization = "Bearer <token>"` is supported');
      }
      headers.set("authorization", `Bearer ${token.trim()}`);
      continue;
    }
    try {
      headers.set(key, value);
    } catch (error) {
      throw new McpConnectionError(`invalid header \`${key}\`: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
  const transport = new StreamableHTTPClientTransport(new URL(config.url ?? ""), {
    requestInit: { headers },
  });
  try {
    await withConnectTimeout(
      client.connect(transport, { timeout: timeoutMs, signal: options.signal }),
      timeoutMs,
      transport,
    );
  } catch (error) {
    throw new McpConnectionError(`MCP handshake failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return client;
}

async function withConnectTimeout(
  connecting: Promise<void>,
  timeoutMs: number,
  transport: { close(): Promise<void> },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new McpConnectionError(`timed out connecting after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([connecting, timeout]);
  } catch (error) {
    await transport.close().catch(() => undefined);
    void connecting.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function collectStderr(stream: Stream | null, server: string, tail: string[]): void {
  if (!stream) return;
  let partial = "";
  stream.on("data", (chunk: Buffer | string) => {
    const text = partial + chunk.toString();
    const lines = text.split(/\r?\n/u);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      log.debug({ server }, `stderr: ${line}`);
      if (tail.length >= 5) tail.shift();
      tail.push(line);
    }
  });
  stream.on("end", () => {
    if (partial !== "") {
      if (tail.length >= 5) tail.shift();
      tail.push(partial);
      partial = "";
    }
  });
  stream.on("error", () => undefined);
}
