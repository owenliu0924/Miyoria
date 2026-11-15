// Module `cluster` (docs/design/v5-hostd.md §6): serves the control link hosts dial, keeps the
// hosts that joined, and offers the registry of service endpoints, the hosts and the guard
// sources to other modules (`ClusterKey`).
//
// ```toml
// [modules.cluster]
// bind = "127.0.0.1:7880"
// [modules.cluster.order]
// sing = ["friend-pc", "main-pc"]
// ```
//
// Not required: when the bind fails (the port is taken) the module fails, as the voice link does,
// and Core keeps running.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HOST_LINK_CLOSE, HOST_LINK_PATH } from "@miyoria/contracts/host";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ServiceLookup,
} from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import { Events, type Publish, serviceKey } from "@miyoria/types";
import { WebSocketServer } from "ws";
import { ClusterConfigSchema } from "./config.js";
import { GuardRegistry, type GuardSourceFn } from "./guards.js";
import { ClusterLink, type HostConnection } from "./link.js";
import { EndpointRegistry } from "./registry.js";
import {
  ClusterError,
  type ClusterTables,
  clusterTables,
  type HostRecord,
  type NewHost,
  type NewInvite,
} from "./tables.js";

/** Largest control-link message: the same cap as an extension frame. */
const MAX_MESSAGE = 16 * 1024 * 1024;

/** The hosts that joined, and the ones connected now. */
export interface ClusterHosts {
  /** Adds a host and returns its key, once (`cluster.host.joined`). */
  create(options: { name: string; approved?: boolean; capabilities?: readonly string[] }): NewHost;
  /** Approves a host for exactly these capabilities (`cluster.host.approved`). */
  approve(name: string, capabilities: readonly string[]): HostRecord;
  /** Revokes its key and closes its link (`cluster.host.removed`). `null`: no such host. */
  revoke(name: string): HostRecord | null;
  /** Deletes its row and closes its link (`cluster.host.removed`). `null`: no such host. */
  remove(name: string): HostRecord | null;
  /** Makes a one-time join code. */
  invite(options: { name?: string | null; ttl_s?: number; by: string }): NewInvite;
  /** Uses a join code: a new pending host, with its key (`cluster.host.joined`). */
  redeem(code: string, name: string): NewHost;
  list(): HostRecord[];
  /** The hosts whose link is up now. */
  connected(): HostConnection[];
  /** Sends a request to a connected host (`host.info`, `service.list`, ...). */
  call(name: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** What `cluster` offers other modules (`ClusterKey`). */
export interface ClusterService {
  /** Where each capability can be used now. */
  readonly registry: EndpointRegistry;
  readonly hosts: ClusterHosts;
  /** Sources of the guarded states (`cluster.guard`). */
  readonly guards: GuardRegistry;
  /** The address the control link listens on. */
  readonly address: AddressInfo;
}

export const ClusterKey = serviceKey<ClusterService>("Cluster");

/** A guard source Core's wiring adds: it reads other modules through their service keys. */
export type ClusterGuard = (services: ServiceLookup) => ReturnType<GuardSourceFn>;

export interface ClusterModuleOptions {
  /** Guard sources that stay for the module's whole life (Core's `singing` and `live`). */
  guards?: readonly ClusterGuard[];
  /** What `welcome` says Core's version is. */
  version?: string;
}

/** `host:port` / `[v6]:port`. */
function parseBind(bind: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(bind.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port > 65_535) return null;
  return { host: (m[1] ?? m[2]) as string, port };
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The hosts functions over the tables, with their events and their effect on live links. */
function clusterHosts(tables: ClusterTables, link: ClusterLink, publish: Publish): ClusterHosts {
  const removed = (host: HostRecord, how: "revoked" | "deleted") => {
    link.disconnect(host.name, HOST_LINK_CLOSE.UNAUTHORIZED, `host ${how}`);
    publish(Events.ClusterHostRemoved, { host: host.name, how });
  };
  return {
    create: (options) => {
      const made = tables.hosts.create(options);
      publish(Events.ClusterHostJoined, {
        id: made.host.id,
        host: made.host.name,
        status: made.host.status === "approved" ? "approved" : "pending",
      });
      return made;
    },
    approve: (name, capabilities) => {
      const host = tables.hosts.approve(name, capabilities);
      link.approvalChanged(host);
      publish(Events.ClusterHostApproved, { host: host.name, capabilities: host.capabilities });
      return host;
    },
    revoke: (name) => {
      const host = tables.hosts.revoke(name);
      if (host !== null) removed(host, "revoked");
      return host;
    },
    remove: (name) => {
      const host = tables.hosts.remove(name);
      if (host !== null) removed(host, "deleted");
      return host;
    },
    invite: (options) => tables.invites.invite(options),
    redeem: (code, name) => {
      const made = tables.invites.redeem(code, name);
      publish(Events.ClusterHostJoined, {
        id: made.host.id,
        host: made.host.name,
        status: "pending",
      });
      return made;
    },
    list: () => tables.hosts.list(),
    connected: () => link.connected(),
    call: (name, method, params, signal) => link.call(name, method, params, signal),
  };
}

export class ClusterModule implements Module {
  static readonly ID = "cluster";
  readonly manifest = defineManifest(ClusterModule.ID, "Cluster", {
    description: "The control link hosts dial, the hosts that joined, and the service registry",
    configSchema: ClusterConfigSchema,
  });
  /** Outlives restarts of the module: Core's sources are added once. */
  readonly guards = new GuardRegistry();
  readonly #version: string;
  #services: ServiceLookup | null = null;
  #addr: AddressInfo | null = null;
  #link: ClusterLink | null = null;

  constructor(options: ClusterModuleOptions = {}) {
    this.#version = options.version ?? "0.0.0";
    for (const guard of options.guards ?? []) {
      this.guards.add(() => (this.#services === null ? null : guard(this.#services)));
    }
  }

  /** The address the server is bound to while running (useful with port 0). */
  localAddr(): AddressInfo | null {
    return this.#addr;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ClusterConfigSchema);
    const bind = parseBind(config.bind);
    if (!bind) throw new ClusterError(`cannot bind the cluster link to \`${config.bind}\``);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) throw new ClusterError("the cluster module needs the store");
    const tables = store.plugin(clusterTables).withClock(ctx.clock);
    this.#services = ctx.services;

    const registry = new EndpointRegistry({
      order: config.order,
      static: config.static,
      retrySecs: config.retry_secs,
      clock: ctx.clock,
    });
    const link = new ClusterLink({
      config,
      tables,
      registry,
      guards: this.guards,
      publish: ctx.publisher,
      signal: ctx.signal,
      log: ctx.log,
      coreVersion: this.#version,
      now: () => ctx.clock.now(),
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE,
      perMessageDeflate: false,
    });
    const server = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" }).end("upgrade required");
    });
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== HOST_LINK_PATH) {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => link.serve(ws));
    });
    try {
      await listen(server, bind.host, bind.port);
    } catch (error) {
      throw new ClusterError(
        `cannot bind the cluster link to \`${config.bind}\`: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const addr = server.address() as AddressInfo;
    if (!isLoopback(addr.address)) {
      ctx.log.warn(
        { addr: `${addr.address}:${addr.port}` },
        "the cluster link is reachable from the network over plain WebSocket",
      );
    }
    ctx.log.info({ addr: `${addr.address}:${addr.port}` }, "cluster link listening");
    this.#addr = addr;
    this.#link = link;
    ctx.provide(ClusterKey, {
      registry,
      hosts: clusterHosts(tables, link, ctx.publisher),
      guards: this.guards,
      address: addr,
    });

    ctx.spawn("server", async (signal) => {
      const failed = new Promise<never>((_, reject) => {
        server.on("error", (error) =>
          reject(new ClusterError("the cluster link server failed", { cause: error })),
        );
      });
      try {
        await Promise.race([aborted(signal), failed]);
      } finally {
        link.closeAll();
        wss.close();
        server.close();
        server.closeAllConnections();
      }
    });
  }

  async stop(): Promise<void> {
    this.#link?.closeAll();
    this.#link = null;
    this.#addr = null;
    this.#services = null;
  }

  async health(): Promise<Health> {
    if (this.#addr === null) return { status: "unhealthy", reason: "not listening" };
    return HEALTHY;
  }
}
