import type { Server } from "node:http";
import { actuatorsFor } from "@miyoria/gate/actions";
import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  type Config,
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  SupervisorKey,
} from "@miyoria/runtime/kernel";
import { Events, is } from "@miyoria/types";
import { ExtensionCatalogKey } from "../../ext-host/src/host.js";
import { ExtensionLauncherKey, localLauncher } from "../../ext-host/src/launch.js";
import { type BundledServer, bundledServers } from "./bundled.js";
import { Registrar, ServerRunner } from "./client.js";
import {
  type McpConfig,
  parseMcpConfig,
  reconnectInitialMs,
  reconnectMaxMs,
  type ServerConfig,
} from "./config.js";
import { bind, exposeHandler, localAddress, McpServeError, serveUntil } from "./server.js";
import { McpStatus, McpStatusKey, newServerStatus } from "./status.js";

export class McpStartError extends Error {
  override readonly name = "McpStartError";
}

interface Running {
  status: McpStatus;
  registrar: Registrar;
}

/** A server an extension bundles, run while that extension's module is not disabled. */
interface Follow {
  name: string;
  runner: ServerRunner;
  /** Stops the current run; `null` while it is not running. */
  stop: AbortController | null;
  /** The last run has ended. */
  done: Promise<void>;
}

/**
 * Module `mcp`: connects to configured MCP servers and to the ones enabled extensions bundle, and
 * mirrors their tools into the `ActuatorRegistry` as gated capabilities (offered to the model
 * through the shared `ToolRegistry`); optionally serves a read-only MCP endpoint. Provides
 * `McpStatusKey`; requires the `ToolRegistryKey` service to exist.
 *
 * Its config is the top-level `[mcp]` section (not `[modules.mcp]`), passed to the constructor.
 */
export class McpModule implements Module {
  static readonly ID = "mcp";
  readonly manifest: ModuleManifest = defineManifest(McpModule.ID, "MCP", {
    icon: "plug",
    category: "system",
    description: "MCP client for external tools, optional read-only MCP server",
    // Started after the extension host when there is one: its catalog lists bundled servers.
    optional: ["extensions", "actions"],
  });
  readonly config: McpConfig;
  #running: Running | null = null;

  constructor(config: McpConfig = parseMcpConfig(null)) {
    this.config = config;
  }

  /** Builds the module from the app config's top-level `[mcp]` section. */
  static fromAppConfig(config: Config): McpModule {
    return new McpModule(parseMcpConfig(config.section("mcp")));
  }

  /** Status of the current run, if the module is running. */
  status(): McpStatus | null {
    return this.#running?.status ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const registry = ctx.services.get(ToolRegistryKey);
    if (!registry) throw new McpStartError("the tool registry service is not available");
    const status = new McpStatus();
    const registrar = new Registrar(actuatorsFor(ctx), registry);
    const catalog = ctx.services.get(ExtensionCatalogKey);
    const bundled = catalog === undefined ? [] : bundledServers(catalog, this.config.servers);
    const bundledNames = new Set(bundled.map((b) => b.name));
    const launcher = () => ctx.services.get(ExtensionLauncherKey) ?? localLauncher();
    const supervisor = ctx.services.get(SupervisorKey);
    const followers = new Map<string, Follow[]>();

    const runners: [string, ServerConfig, BundledServer | null][] = [
      ...[...this.config.servers]
        // An entry that only tunes a bundled server (no command, no url of its own) is not a
        // server of its own.
        .filter(([name, s]) => !(bundledNames.has(name) && s.command === null && s.url === null))
        .map(([name, s]) => [name, s, null] as [string, ServerConfig, null]),
      ...bundled.map((b) => [b.name, b.config, b] as [string, ServerConfig, BundledServer]),
    ];
    for (const [name, server, from] of runners) {
      status.insert(
        newServerStatus(
          name,
          server.effectiveTransport(),
          server.permissionNode(name),
          server.displayTarget(),
        ),
      );
      if (!server.enabled) {
        status.update(name, (s) => {
          s.state = "disabled";
        });
        continue;
      }
      try {
        server.validate(name);
      } catch (error) {
        ctx.log.warn({ server: name, error: errorMessage(error) }, "invalid MCP server config");
        status.update(name, (s) => {
          s.state = "failed";
          s.last_error = `invalid config: ${errorMessage(error)}`;
        });
        continue;
      }
      const runner = new ServerRunner({
        name,
        config: server,
        ...(from?.launch ? { transport: (signal) => from.connect(launcher(), signal) } : {}),
        status,
        registrar,
        backoffInitialMs: reconnectInitialMs(this.config),
        backoffMaxMs: reconnectMaxMs(this.config),
        clock: ctx.clock,
      });
      if (from === null) {
        ctx.spawn("mcp-client", (signal) => runner.run(signal));
        continue;
      }
      const owner = from.from.owner.manifest.moduleId();
      const follow: Follow = { name, runner, stop: null, done: Promise.resolve() };
      followers.set(owner, [...(followers.get(owner) ?? []), follow]);
      // Disabled from the panel since the app started: it waits for the extension to come back.
      if (supervisor?.list().find((m) => m.id === owner)?.enabled === false) {
        status.update(name, (s) => {
          s.state = "disabled";
        });
      } else this.#follow(ctx, status, follow);
    }
    if (followers.size > 0) {
      // A bundled server is part of its extension: it stops when the extension is disabled and
      // starts again when it runs again (the catalog only knew `enabled` at start).
      const states = ctx.subscribe(Events.SystemModuleState.type);
      ctx.spawn("mcp-bundled", async () => {
        for await (const env of states) {
          if (!is(Events.SystemModuleState, env)) continue;
          const list = followers.get(env.data.module) ?? [];
          for (const follow of list) {
            if (env.data.state === "disabled") this.#unfollow(follow);
            else if (env.data.state === "running") this.#follow(ctx, status, follow);
          }
        }
      });
    }

    const expose = this.config.server;
    if (expose.enabled) {
      let listener: Server | null = null;
      let failure: string | null = null;
      if (expose.token.trim() === "") {
        failure = "`mcp.server.token` must be set when the MCP server is enabled";
      } else {
        try {
          listener = await bind(
            expose.bind,
            exposeHandler({ ctx, token: expose.token, extraHosts: expose.allowed_hosts }),
          );
        } catch (error) {
          failure = error instanceof McpServeError ? error.message : errorMessage(error);
        }
      }
      if (listener !== null) {
        const local = localAddress(listener);
        ctx.log.info({ addr: local }, "MCP server listening");
        status.setExpose({ enabled: true, listening: local, error: null });
        const server = listener;
        ctx.spawn("mcp-expose", (signal) => serveUntil(server, signal));
      } else {
        ctx.log.warn({ error: failure }, "MCP server not started");
        status.setExpose({ enabled: true, listening: null, error: failure });
      }
    }

    ctx.provide(McpStatusKey, status);
    this.#running = { status, registrar };
  }

  /** Runs a bundled server's runner unless it runs already (after the last stop ended). */
  #follow(ctx: ModuleContext, status: McpStatus, follow: Follow): void {
    if (follow.stop !== null) return;
    const stop = new AbortController();
    follow.stop = stop;
    const before = follow.done;
    let finished: () => void = () => {};
    follow.done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    ctx.spawn("mcp-client", async (signal) => {
      try {
        await before;
        if (stop.signal.aborted) return;
        await follow.runner.run(AbortSignal.any([signal, stop.signal]));
      } finally {
        if (follow.stop === null && !signal.aborted) {
          status.update(follow.name, (s) => {
            s.state = "disabled";
            s.tools = [];
          });
        }
        finished();
      }
    });
  }

  /** Stops a bundled server's runner: its tools go, closing the connection ends its program. */
  #unfollow(follow: Follow): void {
    const stop = follow.stop;
    if (stop === null) return;
    follow.stop = null;
    stop.abort();
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    running?.registrar.close();
  }

  async health(): Promise<Health> {
    const status = this.status();
    if (!status) return { status: "unhealthy", reason: "not running" };
    const expose = status.expose();
    if (expose.error !== null) return { status: "degraded", reason: `MCP server: ${expose.error}` };
    const down = status.unavailable();
    if (down.length === 0) return HEALTHY;
    return { status: "degraded", reason: `MCP servers not connected: ${down.join(", ")}` };
  }
}
