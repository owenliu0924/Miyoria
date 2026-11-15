// Params and results of the methods the control link and the local API need first. The `gpu.*`,
// `cluster.llm`, `cluster.context` and
// `cluster.links` shapes are added by the steps that implement them.

import { z } from "zod";
import { HostGpuPolicySchema, HostGuardStateSchema } from "./service.js";

/** First message of the control link, host → Core. `host` is the id Core's `join` gave it. */
export const HostHelloSchema = z
  .object({
    protocol: z.number().int(),
    host: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    platform: z.string(),
    version: z.string(),
  })
  .meta({ id: "HostHello" });
export type HostHello = z.output<typeof HostHelloSchema>;

/** Core's answer to `hello`. */
export const HostWelcomeSchema = z
  .object({
    protocol: z.number().int(),
    core_version: z.string(),
    /** The name Core has for this host. */
    host: z.string(),
    /** The capabilities Core has approved for it. */
    approved: z.array(z.string()),
  })
  .meta({ id: "HostWelcome" });
export type HostWelcome = z.output<typeof HostWelcomeSchema>;

export const HostServiceStateSchema = z
  .enum([
    "stopped",
    "starting",
    "running",
    "stopping",
    "backoff",
    "failed",
    "external",
    "foreign",
    "disabled",
  ])
  .meta({ id: "HostServiceState" });
export type HostServiceState = z.output<typeof HostServiceStateSchema>;

/** One service as hostd reports it. */
export const HostServiceStatusSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["worker", "node", "external"]),
    provides: z.array(z.string()),
    state: HostServiceStateSchema,
    /** Epoch milliseconds of the last state change. */
    since: z.number(),
    pid: z.number().int().optional(),
    port: z.number().int().optional(),
    /** The base URL other machines should use. */
    url: z.string().optional(),
    healthy: z.boolean(),
    /** Restarts within the current give-up window. */
    restarts: z.number().int().nonnegative(),
    version: z.string().optional(),
    /** Why the service is failed, in backoff or disabled. */
    reason: z.string().optional(),
    /** The service token; only present in reports on the control link. */
    token: z.string().optional(),
    gpu: z
      .object({
        policy: HostGpuPolicySchema,
        resident_mb: z.number().optional(),
        leased: z.boolean(),
      })
      .optional(),
  })
  .meta({ id: "HostServiceStatus" });
export type HostServiceStatus = z.output<typeof HostServiceStatusSchema>;

/** What the card reads now. */
export const HostGpuReadingSchema = z
  .object({
    name: z.string().optional(),
    total_mb: z.number(),
    used_mb: z.number(),
    reserve_mb: z.number(),
  })
  .meta({ id: "HostGpuReading" });
export type HostGpuReading = z.output<typeof HostGpuReadingSchema>;

/** Where the daemon's control link to Core is; `none` without `[cluster]` or a host key. */
export const HostLinkStateSchema = z
  .enum(["none", "connecting", "connected", "unauthorized", "stopped"])
  .meta({ id: "HostLinkState" });
export type HostLinkState = z.output<typeof HostLinkStateSchema>;

/** `host.info` result. `gpu` is null when the machine has no card. */
export const HostInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    platform: z.string(),
    protocol: z.number().int(),
    gpu: HostGpuReadingSchema.nullable(),
    services: z.array(HostServiceStatusSchema),
    /** The control link's state; older daemons leave it out. */
    link: HostLinkStateSchema.optional(),
  })
  .meta({ id: "HostInfo" });
export type HostInfo = z.output<typeof HostInfoSchema>;

/** `host.report` notification params: the whole snapshot, sent on connect and on every change. */
export const HostReportSchema = HostInfoSchema.meta({ id: "HostReport" });
export type HostReport = z.output<typeof HostReportSchema>;

/** `service.event` notification params: one state change. */
export const HostServiceEventSchema = z
  .object({
    service: z.string(),
    state: HostServiceStateSchema,
    previous: HostServiceStateSchema,
    /** Epoch milliseconds. */
    at: z.number(),
    reason: z.string().optional(),
    /** The last log lines, sent when the service failed. */
    log_tail: z.array(z.string()).optional(),
  })
  .meta({ id: "HostServiceEvent" });
export type HostServiceEvent = z.output<typeof HostServiceEventSchema>;

/** `service.list` result. */
export const HostServiceListSchema = z
  .object({ services: z.array(HostServiceStatusSchema) })
  .meta({ id: "HostServiceList" });
export type HostServiceList = z.output<typeof HostServiceListSchema>;

/** `service.start`, `service.stop` and `service.restart` params: one service per call. */
export const HostServiceControlSchema = z
  .object({
    service: z.string(),
    /** Go ahead although a guarded state is active. */
    force: z.boolean().optional(),
  })
  .meta({ id: "HostServiceControl" });
export type HostServiceControl = z.output<typeof HostServiceControlSchema>;

/** The result of those three. */
export const HostServiceControlResultSchema = z
  .object({ service: z.string(), state: HostServiceStateSchema })
  .meta({ id: "HostServiceControlResult" });
export type HostServiceControlResult = z.output<typeof HostServiceControlResultSchema>;

/** `service.logs` params. With `follow`, lines then arrive as `service.log` until cancelled. */
export const HostServiceLogsSchema = z
  .object({
    service: z.string(),
    lines: z.number().int().min(1).max(2000).default(100),
    follow: z.boolean().default(false),
  })
  .meta({ id: "HostServiceLogs" });
export type HostServiceLogs = z.output<typeof HostServiceLogsSchema>;
export type HostServiceLogsIn = z.input<typeof HostServiceLogsSchema>;

export const HostServiceLogsResultSchema = z
  .object({ lines: z.array(z.string()) })
  .meta({ id: "HostServiceLogsResult" });
export type HostServiceLogsResult = z.output<typeof HostServiceLogsResultSchema>;

/** `service.log` notification params. */
export const HostServiceLogLineSchema = z
  .object({ service: z.string(), line: z.string() })
  .meta({ id: "HostServiceLogLine" });
export type HostServiceLogLine = z.output<typeof HostServiceLogLineSchema>;

/** `host.shutdown` params (local API only). */
export const HostShutdownSchema = z
  .object({
    /** Go ahead although a guarded state is active for a running service. */
    force: z.boolean().optional(),
  })
  .meta({ id: "HostShutdown" });
export type HostShutdown = z.output<typeof HostShutdownSchema>;

/** `host.shutdown` result, sent before the daemon exits. */
export const HostShutdownResultSchema = z
  .object({
    /** The services that were stopped, in the order they were stopped. */
    stopped: z.array(z.string()),
  })
  .meta({ id: "HostShutdownResult" });
export type HostShutdownResult = z.output<typeof HostShutdownResultSchema>;

/** `host.relink` result: where the control link is after the daemon read its files again. */
export const HostRelinkResultSchema = z
  .object({ link: HostLinkStateSchema })
  .meta({ id: "HostRelinkResult" });
export type HostRelinkResult = z.output<typeof HostRelinkResultSchema>;

/** `cluster.guard` result: the guarded states that are active now. */
export const HostGuardResultSchema = z
  .object({ states: z.array(HostGuardStateSchema) })
  .meta({ id: "HostGuardResult" });
export type HostGuardResult = z.output<typeof HostGuardResultSchema>;

/** One place a capability can be used (v5-hostd §6.3). */
export const HostEndpointSchema = z
  .object({
    capability: z.string(),
    /** The host name, or the static entry's name. */
    host: z.string(),
    service: z.string(),
    /** With `via: "link"` this is the address on the host itself, not one Core can call. */
    url: z.string(),
    /** `direct`: call `url`. `link`: the request travels over the host's control link. */
    via: z.enum(["direct", "link"]).default("direct"),
    /** What to send with each request, such as the bearer token. */
    headers: z.record(z.string(), z.string()),
    healthy: z.boolean(),
    version: z.string().nullable(),
  })
  .meta({ id: "HostEndpoint" });
export type HostEndpoint = z.output<typeof HostEndpointSchema>;

/** `cluster.resolve` params. */
export const HostResolveSchema = z.object({ capability: z.string() }).meta({ id: "HostResolve" });
export type HostResolve = z.output<typeof HostResolveSchema>;

/** `cluster.resolve` result. */
export const HostResolveResultSchema = z
  .object({ endpoints: z.array(HostEndpointSchema) })
  .meta({ id: "HostResolveResult" });
export type HostResolveResult = z.output<typeof HostResolveResultSchema>;

// ---- installing (service.install, service.remove, host.update) ---------------------------------

/** What happened to the Python environment of one service. */
export const HostInstallRuntimeStateSchema = z
  .enum([
    /** `uv sync` ran and finished. */
    "synced",
    /** The install record already matched; nothing ran (`only_stale`). */
    "current",
    /** `host.toml` names an environment the user manages (`python = ...`); never touched. */
    "user-managed",
    /** The runtime needs no environment here (`node`, `binary`, `none`, or no `project`). */
    "none",
    /** The descriptor does not support this platform. */
    "unsupported",
    /** `uv` is not installed; `detail` says how to install it. */
    "uv-missing",
    /** `uv sync` ran and failed. */
    "failed",
  ])
  .meta({ id: "HostInstallRuntimeState" });
export type HostInstallRuntimeState = z.output<typeof HostInstallRuntimeStateSchema>;

/** `service.install` params: build the environment of one service and check the rest of `[install]`. */
export const HostServiceInstallSchema = z
  .object({
    service: z.string(),
    /** Replaces the extras of the descriptor and of `host.toml` for this run. */
    extras: z.array(z.string()).optional(),
    /** Run `uv sync` only when the install record differs from the lock, extras and descriptor. */
    only_stale: z.boolean().optional(),
    /** Do not download `install.files`. */
    no_files: z.boolean().optional(),
  })
  .meta({ id: "HostServiceInstall" });
export type HostServiceInstall = z.output<typeof HostServiceInstallSchema>;

/** `service.install` result, and one item of `host.update`'s. */
export const HostServiceInstallResultSchema = z
  .object({
    service: z.string(),
    /** False when something failed (a sync, a download); missing items to place by hand do not. */
    ok: z.boolean(),
    runtime: z.object({
      state: HostInstallRuntimeStateSchema,
      /** The environment folder, when there is one. */
      dir: z.string().optional(),
      /** The extras that were synced. */
      extras: z.array(z.string()).optional(),
      /** The reason, or what to do (the `uv` install command). */
      detail: z.string().optional(),
    }),
    /** `install.system`: programs on PATH. `hint` is how to install a missing one. */
    system: z.array(
      z.object({ program: z.string(), found: z.boolean(), hint: z.string().optional() }),
    ),
    files: z.array(
      z.object({
        path: z.string(),
        state: z.enum(["present", "downloaded", "skipped", "failed"]),
        detail: z.string().optional(),
      }),
    ),
    manual: z.array(z.object({ path: z.string(), what: z.string(), present: z.boolean() })),
    /** `install.models` and whether each is in the host's model cache. */
    models: z.array(
      z.object({
        repo: z.string(),
        revision: z.string().optional(),
        present: z.boolean(),
      }),
    ),
  })
  .meta({ id: "HostServiceInstallResult" });
export type HostServiceInstallResult = z.output<typeof HostServiceInstallResultSchema>;

/** `service.remove` params: stop the service, delete the environment hostd manages, forget it. */
export const HostServiceRemoveSchema = z
  .object({
    service: z.string(),
    /** Stop it although a guarded state is active. */
    force: z.boolean().optional(),
    /** Keep the environment folder. */
    keep_env: z.boolean().optional(),
  })
  .meta({ id: "HostServiceRemove" });
export type HostServiceRemove = z.output<typeof HostServiceRemoveSchema>;

/** `service.remove` result. */
export const HostServiceRemoveResultSchema = z
  .object({
    service: z.string(),
    stopped: z.boolean(),
    /** The environment folder that was deleted; absent when there was none, it is the user's, or it was kept. */
    deleted_env: z.string().optional(),
  })
  .meta({ id: "HostServiceRemoveResult" });
export type HostServiceRemoveResult = z.output<typeof HostServiceRemoveResultSchema>;

/**
 * `host.update` params: read the descriptors and `host.toml` again (a `git pull` changed them),
 * re-plan the services, and sync the environments whose install record is stale. It restarts
 * nothing: the caller asks for each restart through the guard.
 */
export const HostUpdateSchema = z
  .object({
    /** Only these; default every enabled service. */
    services: z.array(z.string()).optional(),
    /** Sync even when the install record matches. */
    force: z.boolean().optional(),
  })
  .meta({ id: "HostUpdate" });
export type HostUpdate = z.output<typeof HostUpdateSchema>;

/** `host.update` result: one install result per service that was looked at. */
export const HostUpdateResultSchema = z
  .object({ services: z.array(HostServiceInstallResultSchema) })
  .meta({ id: "HostUpdateResult" });
export type HostUpdateResult = z.output<typeof HostUpdateResultSchema>;
