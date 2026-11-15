// The control link (docs/design/v5-hostd.md §5, §6.1): each host's hostd dials Core, proves who
// it is with `hello`, and then both sides speak JSON-RPC over the socket with the extension
// protocol's `RpcPeer`.
//
// The first message must be a valid `hello` within `hello_timeout_ms`: a bad one closes with
// `BAD_HELLO`, an unknown host, wrong key or revoked host with `UNAUTHORIZED`, silence with
// `TIMEOUT`. A second connection of the same host replaces the first (`REPLACED`). Core pings
// every `ping_secs` and drops a host it has heard nothing from for `peer_timeout_secs`.
//
// A pending host (joined, not approved) may connect and report; nothing it reports is used.
//
// Binary frames after `welcome` are the relay's (§7.1, `relay.ts`): each connection has its
// channel, and every stream of it fails when the connection ends.

import { EXT_ERROR_CODE } from "@miyoria/contracts/ext";
import {
  HOST_ERROR_CODE,
  HOST_LINK_CLOSE,
  HOST_METHOD,
  HOST_NOTIFICATION,
  HOST_PROTOCOL_VERSION,
  HOST_RELAY_PROTOCOL_ERROR,
  type HostHello,
  HostHelloSchema,
  type HostReport,
  HostReportSchema,
  HostResolveSchema,
  HostServiceEventSchema,
  type HostWelcome,
} from "@miyoria/contracts/host";
import { errorMessage, type Logger } from "@miyoria/runtime/kernel";
import { RpcError, RpcPeer, WebSocketTransport } from "@miyoria/sdk";
import { Events, type Publish } from "@miyoria/types";
import WebSocket, { type RawData } from "ws";
import type { ClusterConfig } from "./config.js";
import type { GuardRegistry } from "./guards.js";
import type { EndpointRegistry } from "./registry.js";
import { RelayChannel, RelayError, type RelayHost, type RelayOptions } from "./relay.js";
import { ClusterError, type ClusterTables, type HostRecord } from "./tables.js";

/** How long a close handshake may take before the socket is dropped. */
const CLOSE_GRACE_MS = 2_000;
/** Default timeout of a request Core sends a host. */
const CALL_TIMEOUT_MS = 30_000;

/** One connected host. */
export interface HostConnection {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly version: string;
  /** Approved: what it reports is used. */
  readonly approved: boolean;
  /** Epoch ms. */
  readonly since: number;
}

export interface ClusterLinkOptions {
  config: ClusterConfig;
  tables: ClusterTables;
  registry: EndpointRegistry;
  guards: GuardRegistry;
  /** Publishes as the owning module. */
  publish: Publish;
  /** The module's stop signal. */
  signal: AbortSignal;
  log: Logger;
  /** What `welcome` says Core's version is. */
  coreVersion: string;
  now: () => number;
  /** The relay of HTTP requests over the link (v5-hostd §7.1). */
  relay?: RelayOptions;
}

interface Conn {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly version: string;
  approved: boolean;
  /** The capabilities it is approved for. */
  capabilities: readonly string[];
  /** Its latest report. */
  report: HostReport | null;
  readonly since: number;
  readonly ws: WebSocket;
  readonly peer: RpcPeer;
  /** Requests relayed to its services. */
  readonly relay: RelayChannel;
  /** The first close code wins. */
  closing: { code: number; reason: string } | null;
}

/** Starts the close handshake; drops the socket if the other side does not answer in time. */
export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
      return;
    }
  }
  setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, CLOSE_GRACE_MS).unref();
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

function rawText(data: RawData): string {
  return rawBytes(data).toString("utf8");
}

type HelloOutcome =
  | { ok: true; hello: HostHello; host: HostRecord }
  | { ok: false; code: number; reason: string };

/** The control link's server side: connections by host name. */
export class ClusterLink {
  readonly #o: ClusterLinkOptions;
  readonly #conns = new Map<string, Conn>();

  constructor(options: ClusterLinkOptions) {
    this.#o = options;
  }

  /** The hosts connected now, by name. */
  connected(): HostConnection[] {
    return [...this.#conns.values()]
      .map(({ id, name, platform, version, approved, since }) => ({
        id,
        name,
        platform,
        version,
        approved,
        since,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  isConnected(name: string): boolean {
    return this.#conns.has(name);
  }

  /** Sends a request to a connected host (`host.info`, `service.*`). Rejects with `RpcError`. */
  call(name: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const conn = this.#conns.get(name);
    if (conn === undefined) {
      return Promise.reject(new ClusterError(`host \`${name}\` is not connected`));
    }
    return conn.peer.request(method, params ?? null, CALL_TIMEOUT_MS, signal);
  }

  /** What the relay needs of a connected host; `null` when it is not connected. */
  relayHost(name: string): RelayHost | null {
    const conn = this.#conns.get(name);
    if (conn === undefined) return null;
    return {
      approved: conn.approved,
      capabilities: conn.capabilities,
      services: conn.report?.services ?? null,
      channel: conn.relay,
    };
  }

  /** The host's approval changed while it may be connected. */
  approvalChanged(host: HostRecord): void {
    const conn = this.#conns.get(host.name);
    if (conn === undefined) return;
    conn.approved = host.status === "approved";
    conn.capabilities = conn.approved ? host.capabilities : [];
    this.#o.registry.setHost(host.name, conn.approved ? host.capabilities : null);
  }

  /** Closes a host's link (revoked, removed). */
  disconnect(name: string, code: number, reason: string): void {
    const conn = this.#conns.get(name);
    if (conn !== undefined) this.#shutdown(conn, code, reason);
  }

  /** Closes every link (module stop). */
  closeAll(): void {
    for (const conn of [...this.#conns.values()]) {
      this.#shutdown(conn, HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
    }
  }

  /** Runs the protocol on a freshly upgraded socket. */
  serve(ws: WebSocket): void {
    const o = this.#o;
    let phase: "hello" | "open" | "done" = "hello";
    const helloTimer = setTimeout(
      () => reject(HOST_LINK_CLOSE.TIMEOUT, "no hello in time"),
      o.config.hello_timeout_ms,
    );
    const onAbort = () => reject(HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
    const endHello = () => {
      clearTimeout(helloTimer);
      o.signal.removeEventListener("abort", onAbort);
      ws.off("message", onHello);
      ws.off("close", onEarlyClose);
    };
    const reject = (code: number, reason: string) => {
      if (phase !== "hello") return;
      phase = "done";
      endHello();
      o.log.warn({ code, reason }, "refused a host link");
      closeSocket(ws, code, reason);
    };
    const onHello = (data: RawData, isBinary: boolean) => {
      if (phase !== "hello") return;
      if (isBinary) {
        reject(HOST_LINK_CLOSE.BAD_HELLO, "expected hello");
        return;
      }
      const outcome = this.#readHello(rawText(data));
      if (!outcome.ok) {
        reject(outcome.code, outcome.reason);
        return;
      }
      phase = "open";
      endHello();
      this.#open(ws, outcome.hello, outcome.host);
    };
    const onEarlyClose = () => {
      if (phase !== "hello") return;
      phase = "done";
      endHello();
    };
    ws.on("error", (error: Error) => o.log.debug({ err: errorMessage(error) }, "host link error"));
    if (o.signal.aborted) {
      reject(HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
      return;
    }
    o.signal.addEventListener("abort", onAbort, { once: true });
    ws.on("message", onHello);
    ws.on("close", onEarlyClose);
  }

  #readHello(text: string): HelloOutcome {
    const refuse = (code: number, reason: string): HelloOutcome => ({ ok: false, code, reason });
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return refuse(HOST_LINK_CLOSE.BAD_HELLO, "invalid JSON");
    }
    const parsed = HostHelloSchema.safeParse(value);
    if (!parsed.success) return refuse(HOST_LINK_CLOSE.BAD_HELLO, "malformed hello");
    const hello = parsed.data;
    // The key before anything else, so a stranger learns nothing more.
    if (!this.#o.tables.hosts.verify(hello.host, hello.key)) {
      return refuse(HOST_LINK_CLOSE.UNAUTHORIZED, "unknown host or wrong key");
    }
    if (hello.protocol !== HOST_PROTOCOL_VERSION) {
      return refuse(
        HOST_LINK_CLOSE.BAD_HELLO,
        `protocol ${hello.protocol} is not supported (${HOST_PROTOCOL_VERSION} is)`,
      );
    }
    const host = this.#o.tables.hosts.get(hello.host);
    if (host === null || host.status === "revoked") {
      return refuse(HOST_LINK_CLOSE.UNAUTHORIZED, "unknown host or wrong key");
    }
    return { ok: true, hello, host };
  }

  #open(ws: WebSocket, hello: HostHello, host: HostRecord): void {
    const o = this.#o;
    const approved = host.status === "approved";
    const welcome: HostWelcome = {
      protocol: HOST_PROTOCOL_VERSION,
      core_version: o.coreVersion,
      host: host.name,
      approved: approved ? host.capabilities : [],
    };
    // Welcome goes out before anything else on this connection.
    ws.send(JSON.stringify(welcome));
    try {
      o.tables.hosts.seen(host.id, { platform: hello.platform, version: hello.version });
    } catch (error) {
      o.log.warn({ host: host.name, err: errorMessage(error) }, "cannot record the host's visit");
    }
    if (hello.name !== host.name) {
      o.log.info(
        { host: host.name, calls_itself: hello.name },
        "a host calls itself by another name; Core's name is used",
      );
    }

    let conn: Conn | null = null;
    const peer = new RpcPeer({
      transport: new WebSocketTransport(ws),
      role: "host",
      onRequest: (method, params) => this.#onRequest(host.name, method, params),
      onNotification: (method, params) => {
        if (conn !== null) this.#onNotification(conn, method, params);
      },
      onError: (what, error, method) =>
        o.log.debug({ host: host.name, what, method, err: errorMessage(error) }, "host link"),
    });
    const relay = new RelayChannel({
      host: host.name,
      peer,
      sink: {
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) return false;
          try {
            ws.send(frame);
          } catch {
            return false;
          }
          return true;
        },
        get bufferedAmount() {
          return ws.bufferedAmount;
        },
      },
      onProtocolError: (reason) => {
        o.log.warn({ host: host.name, reason }, "a host broke the relay protocol");
        if (conn !== null) this.#shutdown(conn, HOST_RELAY_PROTOCOL_ERROR, "relay protocol error");
      },
      ...(o.relay?.maxStreams === undefined ? {} : { maxStreams: o.relay.maxStreams }),
      ...(o.relay?.timeoutMs === undefined ? {} : { timeoutMs: o.relay.timeoutMs }),
    });
    conn = {
      id: host.id,
      name: host.name,
      platform: hello.platform,
      version: hello.version,
      approved,
      capabilities: approved ? host.capabilities : [],
      report: null,
      since: o.now(),
      ws,
      peer,
      relay,
      closing: null,
    };
    // Binary frames are the relay's; JSON-RPC reads the text frames.
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) relay.frame(rawBytes(data));
    });
    const old = this.#conns.get(host.name);
    this.#conns.set(host.name, conn);
    if (old !== undefined) {
      o.log.info({ host: host.name }, "host link replaced by a newer connection");
      this.#shutdown(old, HOST_LINK_CLOSE.REPLACED, "replaced by a newer connection");
    }
    o.registry.setHost(host.name, approved ? host.capabilities : null);
    o.log.info({ host: host.name, approved, platform: hello.platform }, "host connected");
    o.publish(Events.ClusterHostConnected, {
      host: host.name,
      platform: hello.platform,
      version: hello.version,
      approved,
    });
    const stopBeat = this.#heartbeat(conn);
    const current = conn;
    ws.on("close", (code: number, reason: Buffer) => {
      stopBeat();
      relay.close(new RelayError(`the link to host \`${current.name}\` closed`));
      peer.close();
      const closing = current.closing ?? { code, reason: reason.toString("utf8") };
      if (this.#conns.get(current.name) === current) {
        this.#conns.delete(current.name);
        o.registry.removeHost(current.name);
      }
      o.log.info({ host: current.name, code: closing.code }, "host disconnected");
      o.publish(Events.ClusterHostDisconnected, {
        host: current.name,
        code: closing.code,
        reason: closing.reason,
      });
    });
  }

  /** Pings, the peer timeout and module shutdown. Returns the teardown. */
  #heartbeat(conn: Conn): () => void {
    const o = this.#o;
    const { ws } = conn;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        o.log.warn({ host: conn.name }, "host link timed out");
        this.#shutdown(conn, HOST_LINK_CLOSE.TIMEOUT, "heartbeat timeout");
      }, o.config.peer_timeout_secs * 1000);
    };
    bump();
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, o.config.ping_secs * 1000);
    const onAbort = () => this.#shutdown(conn, HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
    o.signal.addEventListener("abort", onAbort, { once: true });
    // Any traffic, control frames too, shows the host is alive.
    ws.on("message", bump);
    ws.on("ping", bump);
    ws.on("pong", bump);
    return () => {
      clearTimeout(deadline);
      clearInterval(ping);
      o.signal.removeEventListener("abort", onAbort);
      ws.off("message", bump);
      ws.off("ping", bump);
      ws.off("pong", bump);
    };
  }

  #shutdown(conn: Conn, code: number, reason: string): void {
    conn.closing ??= { code, reason };
    closeSocket(conn.ws, conn.closing.code, conn.closing.reason);
  }

  async #onRequest(name: string, method: string, params: unknown): Promise<unknown> {
    const o = this.#o;
    switch (method) {
      case HOST_METHOD.ClusterGuard: {
        const states = await o.guards.active((error) =>
          o.log.warn({ err: errorMessage(error) }, "a guard source failed"),
        );
        return { states };
      }
      case HOST_METHOD.ClusterResolve: {
        const parsed = HostResolveSchema.safeParse(params);
        if (!parsed.success) throw RpcError.invalidParams(parsed.error.message);
        if (!this.#conns.get(name)?.approved) {
          throw new RpcError(HOST_ERROR_CODE.NotAllowed, "this host is not approved yet");
        }
        return { endpoints: o.registry.candidates(parsed.data.capability) };
      }
      default:
        throw new RpcError(EXT_ERROR_CODE.MethodNotFound, `unknown method "${method}"`);
    }
  }

  #onNotification(conn: Conn, method: string, params: unknown): void {
    const o = this.#o;
    switch (method) {
      case HOST_NOTIFICATION.Report: {
        const parsed = HostReportSchema.safeParse(params);
        if (!parsed.success) {
          o.log.warn({ host: conn.name, err: parsed.error.message }, "a host sent a bad report");
          return;
        }
        if (this.#conns.get(conn.name) !== conn) return;
        conn.report = parsed.data;
        o.registry.report(conn.name, parsed.data);
        return;
      }
      case HOST_NOTIFICATION.ServiceEvent: {
        const parsed = HostServiceEventSchema.safeParse(params);
        if (!parsed.success) {
          o.log.warn({ host: conn.name, err: parsed.error.message }, "a host sent a bad event");
          return;
        }
        const event = parsed.data;
        o.publish(Events.ClusterServiceState, {
          host: conn.name,
          service: event.service,
          state: event.state,
          previous: event.previous,
          reason: event.reason ?? null,
        });
        return;
      }
      default:
        o.log.debug({ host: conn.name, method }, "a host sent an unknown notification");
    }
  }
}
