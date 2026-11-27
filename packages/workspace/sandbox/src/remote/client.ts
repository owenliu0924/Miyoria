// `SandboxClient` over the cluster (docs/design/v6-sandbox.md §9.2, v5-hostd.md §15): which
// computer takes a job, the one event long-poll per computer, the leases.
//
// - Choosing: the registry's `candidates("sandbox")` (scored; what takes no new work is not in
//   it), each one's `GET /v1/info` kept a minute; only a ready one whose image is there and whose
//   owner takes this kind of job (`policy`) is asked. Each is reserved (`reserve`) before its
//   `PUT /v1/jobs/{id}`; busy, not accepting, unavailable or never reached: the next one. A job
//   stays where it opened.
// - One `GET /v1/events` long-poll per computer, for all its jobs: the relay to a computer has
//   16 streams, and a poll per exec or proc would use them up. Uploads and downloads take one
//   stream each while they run; a request refused for a full relay is sent again (`wire.ts`).
// - Every job's lease is renewed every minute; the long-poll renews it too.
// - CPU seconds: every rise of a job's cgroup total is charged to its payer (`WorkQuota`); a
//   payer over their limit has their running execs stopped and their browser and plugin jobs
//   closed (`quota`).

import { createHmac, randomBytes } from "node:crypto";
import {
  EventsPageSchema,
  type JobCreate,
  type JobView,
  JobViewSchema,
  type SandboxInfo,
  SandboxInfoSchema,
} from "@miyoria/contracts/workers";
import {
  type Endpoint,
  type EndpointSource,
  type EndpointUnit,
  errorMessage,
  getLogger,
  sleep,
} from "@miyoria/runtime/kernel";
import {
  type Clock,
  newId,
  type SandboxClient,
  type SandboxFor,
  type SandboxJob,
  type SandboxJobSpec,
  systemClock,
  type WorkPayer,
  type WorkQuota,
} from "@miyoria/types";
import { networkMode, type SandboxConfig } from "../config.js";
import { execReplyBytes, type JobLink, RemoteJob, TIMEOUTS } from "./job.js";
import { encodePayer, type SandboxJobRow, type SandboxJobs } from "./jobs-store.js";
import { call, callJson, notSent, SandboxHttpError } from "./wire.js";

const log = getLogger("sandbox.client");

/** The capability the `sandbox` service provides. */
export const SANDBOX_CAPABILITY = "sandbox";
/** How long a computer's `/v1/info` is used. */
export const INFO_TTL_MS = 60_000;
/**
 * How long an answer of "not ready" (or none) is used: a service that was still checking Docker
 * when it was asked is ready seconds later, and a minute of refusals would send her elsewhere.
 */
export const NOT_READY_TTL_MS = 5_000;
/** One long-poll waits this long for events (the service takes at most 25 s). */
export const POLL_WAIT_MS = 25_000;
/** How often every open job's lease is renewed. */
export const LEASE_EVERY_MS = 60_000;
const MIB = 1024 * 1024;
/**
 * Most of one page of events read: the service fills a page to the 1 MiB asked for, but one
 * `exit` event may be larger (it holds the exec's whole result), so such a page must still fit.
 */
const EVENTS_MAX_BYTES = 2 * MIB;

export type SandboxClientErrorCode =
  | "no_machine"
  | "not_accepting"
  | "busy"
  | "too_large"
  | "quota"
  | "unavailable";

/** `open` found no computer that takes the job; `message` is a sentence she can pass on. */
export class SandboxClientError extends Error {
  override readonly name = "SandboxClientError";

  constructor(
    readonly code: SandboxClientErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** What Core knows of one computer now. */
export interface MachineState {
  host: string;
  service: string;
  /** Its info answered and it says it is ready. */
  ready: boolean;
  /** Why not, in her words (the service's own reason, or that it does not answer). */
  reason: string | null;
  info: SandboxInfo | null;
  /** Its jobs Core has open. */
  jobs: number;
}

export interface HttpSandboxClientOptions {
  endpoints: EndpointSource;
  config: SandboxConfig;
  clock?: Clock;
  /** The key the payers' ids are hashed with before they leave Core; default random per process. */
  payerKey?: Uint8Array;
  /** Where the open jobs are remembered across restarts; default nowhere. */
  jobs?: SandboxJobs | null;
  /** Each person's CPU seconds; read at each charge (it is provided later than this starts). */
  quota?: () => WorkQuota | null;
  capability?: string;
  pollWaitMs?: number;
  leaseEveryMs?: number;
  infoTtlMs?: number;
}

interface Info {
  at: number;
  info: SandboxInfo | null;
  error: string | null;
}

interface Poller {
  key: string;
  host: string;
  service: string;
  jobs: Map<string, RemoteJob>;
  cursor: string | null;
  running: boolean;
}

function keyOf(e: { host: string; service: string }): string {
  return `${e.host}\u0000${e.service}`;
}

/** Whose jobs a computer's owner lets in. */
function accepts(info: SandboxInfo, forWho: SandboxFor): boolean {
  if (forWho === "member") return info.policy.members;
  if (forWho === "plugin") return info.policy.plugins;
  return true;
}

/** Every reserved CPU already taken: a new job would be refused. */
function full(info: SandboxInfo): boolean {
  return info.load.cpus >= info.policy.cpus || info.load.memory_mb >= info.policy.memory_mb;
}

const WHO: Record<SandboxFor, string> = {
  self: "",
  owner: "",
  member: "成員",
  plugin: "插件",
};

/** The sentences of §10.4. */
export function refusalText(
  code: "no_machine" | "not_accepting" | "busy",
  forWho: SandboxFor,
  reasons: readonly string[],
): string {
  switch (code) {
    case "not_accepting":
      return `能跑程式的電腦現在都不接${WHO[forWho] || "這種"}的工作,那幾台的主人沒開;這次沒有跑。`;
    case "busy":
      return "能跑程式的電腦現在都滿了,稍後再試。";
    default:
      return reasons.length === 0
        ? "現在沒有能跑程式的電腦。"
        : `現在沒有能跑程式的電腦(${reasons.join(";")})。`;
  }
}

export class HttpSandboxClient implements SandboxClient {
  readonly #source: EndpointSource;
  readonly #config: SandboxConfig;
  readonly #clock: Clock;
  readonly #payerKey: Uint8Array;
  readonly #jobs: SandboxJobs | null;
  readonly #quota: () => WorkQuota | null;
  readonly #capability: string;
  readonly #pollWaitMs: number;
  readonly #infoTtlMs: number;
  readonly #infos = new Map<string, Info>();
  readonly #pollers = new Map<string, Poller>();
  readonly #units = new Map<string, EndpointUnit>();
  readonly #listeners = new Set<() => void>();
  readonly #closing = new AbortController();
  readonly #unwatch: () => void;
  readonly #lease: ReturnType<typeof setInterval>;
  #refreshing: Promise<void> | null = null;

  constructor(o: HttpSandboxClientOptions) {
    this.#source = o.endpoints;
    this.#config = o.config;
    this.#clock = o.clock ?? systemClock;
    this.#payerKey = o.payerKey ?? randomBytes(32);
    this.#jobs = o.jobs ?? null;
    this.#quota = o.quota ?? (() => null);
    this.#capability = o.capability ?? SANDBOX_CAPABILITY;
    this.#pollWaitMs = o.pollWaitMs ?? POLL_WAIT_MS;
    this.#infoTtlMs = o.infoTtlMs ?? INFO_TTL_MS;
    this.#unwatch = this.#source.watch(this.#capability, () => {
      this.#infos.clear();
      void this.refresh().finally(() => this.#notify());
    });
    this.#lease = setInterval(() => void this.#renewLeases(), o.leaseEveryMs ?? LEASE_EVERY_MS);
    this.#lease.unref?.();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "a sandbox watcher failed");
      }
    }
  }

  watch(onChange: () => void): () => void {
    this.#listeners.add(onChange);
    return () => this.#listeners.delete(onChange);
  }

  /** The computers that may take work now, healthy first. */
  #candidates(hosts?: readonly string[]): Endpoint[] {
    return this.#source
      .candidates(this.#capability)
      .filter((e) => e.healthy && (hosts === undefined || hosts.includes(e.host)));
  }

  /** The endpoint of a computer a job is on, as the registry has it now. */
  #endpointOf(host: string, service: string, fallback: Endpoint | null): Endpoint | null {
    return (
      this.#source
        .candidates(this.#capability, { all: true })
        .find((e) => e.host === host && e.service === service) ?? fallback
    );
  }

  /** Re-reads the `/v1/info` of every computer whose copy is older than a minute. */
  refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    this.#refreshing ??= (async () => {
      const now = this.#clock.now();
      await Promise.all(
        this.#candidates().map(async (e) => {
          const known = this.#infos.get(keyOf(e));
          const ttl =
            known?.info?.ready === true
              ? this.#infoTtlMs
              : Math.min(this.#infoTtlMs, NOT_READY_TTL_MS);
          if (!options.force && known && now - known.at < ttl) return;
          await this.#readInfo(e, options.signal);
        }),
      );
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #readInfo(e: Endpoint, signal?: AbortSignal): Promise<Info> {
    let entry: Info;
    try {
      const info = await callJson(this.#source, e, "/v1/info", SandboxInfoSchema, {
        method: "GET",
        timeoutMs: TIMEOUTS.info,
        ...(signal === undefined ? {} : { signal }),
      });
      entry = { at: this.#clock.now(), info, error: null };
    } catch (error) {
      entry = { at: this.#clock.now(), info: null, error: errorMessage(error) };
    }
    this.#infos.set(keyOf(e), entry);
    return entry;
  }

  /** Every computer that offers the service, and what Core knows of it. */
  machines(): MachineState[] {
    return this.#source.candidates(this.#capability, { all: true }).map((e) => {
      const known = this.#infos.get(keyOf(e));
      const info = known?.info ?? null;
      const reason = !e.healthy
        ? "沒有回應"
        : known === undefined
          ? null
          : info === null
            ? "連不上沙箱服務"
            : info.ready
              ? null
              : (info.reason ?? "沙箱還沒準備好");
      return {
        host: e.host,
        service: e.service,
        ready: e.healthy && info?.ready === true,
        reason,
        info,
        jobs: this.#pollers.get(keyOf(e))?.jobs.size ?? 0,
      };
    });
  }

  /** Why `e` would not take a job of `spec`, or `null` when it might. */
  #refusal(
    e: Endpoint,
    spec: Pick<SandboxJobSpec, "for" | "image">,
  ): { code: "no_machine" | "not_accepting" | "busy"; reason: string } | null {
    const known = this.#infos.get(keyOf(e));
    if (known === undefined) return null;
    const info = known.info;
    if (info === null) return { code: "no_machine", reason: `${e.host}:連不上沙箱服務` };
    if (!info.ready)
      return { code: "no_machine", reason: `${e.host}:${info.reason ?? "沙箱還沒準備好"}` };
    const image = info.images[spec.image];
    if (image !== undefined && !image.present) {
      return { code: "no_machine", reason: `${e.host}:沙箱映像檔還沒建好` };
    }
    if (!accepts(info, spec.for)) return { code: "not_accepting", reason: `${e.host}:不接` };
    if (full(info)) return { code: "busy", reason: `${e.host}:滿了` };
    return null;
  }

  available(
    forWho: SandboxFor,
  ): { ok: true } | { ok: false; code: "no_machine" | "not_accepting" | "busy"; reason: string } {
    const list = this.#candidates();
    if (list.length === 0) {
      const reasons = this.machines().flatMap((m) =>
        m.reason === null ? [] : [`${m.host}:${m.reason}`],
      );
      return { ok: false, code: "no_machine", reason: refusalText("no_machine", forWho, reasons) };
    }
    const refusals = list.map((e) => this.#refusal(e, { for: forWho, image: "default" }));
    if (refusals.some((r) => r === null)) return { ok: true };
    const codes = refusals.map((r) => r?.code);
    const code = codes.includes("busy")
      ? "busy"
      : codes.includes("not_accepting")
        ? "not_accepting"
        : "no_machine";
    return {
      ok: false,
      code,
      reason: refusalText(
        code,
        forWho,
        refusals.flatMap((r) => (r?.code === "no_machine" ? [r.reason] : [])),
      ),
    };
  }

  /** The payer as the computer sees it: a keyed hash, never the person's key. */
  payerId(payer: WorkPayer | null): string | null {
    if (payer === null) return null;
    return createHmac("sha256", this.#payerKey)
      .update(payer.person, "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  /** `JobCreate` of a spec, the `[modules.sandbox]` defaults filling what it leaves out. */
  createBody(spec: SandboxJobSpec): JobCreate {
    const c = this.#config;
    const l = spec.limits ?? {};
    const sessionLike = spec.kind === "session" || spec.kind === "browser";
    return {
      kind: spec.kind,
      image: spec.image,
      for: spec.for,
      payer: this.payerId(spec.payer),
      limits: {
        cpus: l.cpus ?? c.limits.cpus,
        memory_mb: l.memory_mb ?? c.limits.memory_mb,
        pids: l.pids ?? c.limits.pids_limit,
        tmp_mb: l.tmp_mb ?? c.limits.tmpfs_mb,
        file_mb: l.file_mb ?? Math.max(1, Math.ceil(c.limits.max_file_size_bytes / MIB)),
        nofile: l.nofile ?? c.limits.nofile,
        disk_mb: l.disk_mb ?? c.sessions.disk_mb,
      },
      network: {
        mode: spec.network?.mode ?? networkMode(c.network),
        allow: spec.network?.allow ?? [...c.network.allow],
        deny_ports: [...c.network.deny_ports],
        max_connections: c.network.max_connections,
        max_mb: c.network.max_mb,
      },
      lifetime_s:
        spec.lifetime_s ??
        (spec.kind === "plugin"
          ? 0
          : sessionLike
            ? Math.round(c.sessions.lifetime_minutes * 60)
            : Math.ceil(c.max_timeout_ms / 1000) + 600),
      idle_s:
        spec.idle_s ??
        (sessionLike
          ? Math.round(c.sessions.idle_minutes * 60)
          : Math.ceil(c.max_timeout_ms / 1000) + 600),
      lease_s: c.transfer.lease_secs,
      mounts: { tools: spec.mounts?.tools ?? false, ext: spec.mounts?.ext ?? false },
      env: { ...(spec.env ?? {}) },
      label: spec.label ?? null,
    };
  }

  /**
   * Opens a job on the first computer that takes it. `folder`: what of the workspace it holds
   * (remembered with it). Throws `SandboxClientError` when none does.
   */
  async open(
    spec: SandboxJobSpec,
    options: { signal?: AbortSignal; folder?: string | null; name?: string | null } = {},
  ): Promise<RemoteJob> {
    await this.refresh(options.signal === undefined ? {} : { signal: options.signal });
    const list = this.#candidates(spec.hosts);
    const reasons: { code: "no_machine" | "not_accepting" | "busy"; reason: string }[] = [];
    const body = this.createBody(spec);
    for (const endpoint of list) {
      const refused = this.#refusal(endpoint, spec);
      if (refused !== null) {
        reasons.push(refused);
        continue;
      }
      const id = newId().toLowerCase();
      const unit = this.#source.reserve?.(endpoint, { what: spec.kind });
      try {
        const view = await callJson(this.#source, endpoint, `/v1/jobs/${id}`, JobViewSchema, {
          method: "PUT",
          json: body,
          timeoutMs: TIMEOUTS.create,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        unit?.accepted();
        const job = this.#adopt(id, view, endpoint, spec.payer, 0, body.limits.cpus);
        if (unit) this.#units.set(job.id, unit);
        const now = this.#clock.now();
        this.#remember({
          id: job.id,
          host: endpoint.host,
          service: endpoint.service,
          kind: spec.kind,
          name: options.name ?? spec.label ?? null,
          folder: options.folder ?? null,
          payer: encodePayer(spec.payer),
          for: spec.for,
          state: "open",
          ended_reason: null,
          manifest: null,
          cpu_ms: 0,
          created_at: now,
          updated_at: now,
          expires_at: view.expires_at,
        });
        return job;
      } catch (error) {
        unit?.done({ ok: false });
        if (error instanceof SandboxHttpError && error.code === "bad_reply") {
          // The job may exist there under Core's id all the same: it is not left to its lease.
          void call(this.#source, endpoint, `/v1/jobs/${id}`, {
            method: "DELETE",
            timeoutMs: TIMEOUTS.close,
          }).catch(() => undefined);
        }
        if (options.signal?.aborted) throw error;
        if (error instanceof SandboxHttpError) {
          if (error.code === "not_accepting") {
            reasons.push({ code: "not_accepting", reason: `${endpoint.host}:不接` });
            continue;
          }
          if (error.code === "busy") {
            reasons.push({ code: "busy", reason: `${endpoint.host}:滿了` });
            continue;
          }
          if (error.code === "unavailable") {
            reasons.push({
              code: "no_machine",
              reason: `${endpoint.host}:${error.extra.reason ?? error.message}`,
            });
            continue;
          }
          if (error.code === "bad_request" || error.code === "too_large") {
            // The same body would be refused everywhere.
            throw new SandboxClientError("unavailable", error.message, { cause: error });
          }
        }
        if (!notSent(error)) this.#source.failed(endpoint, error);
        reasons.push({ code: "no_machine", reason: `${endpoint.host}:沒有回應` });
        log.warn(
          { host: endpoint.host, err: errorMessage(error) },
          "a sandbox computer refused a job",
        );
      }
    }
    if (list.length === 0) {
      for (const m of this.machines()) {
        if (m.reason !== null)
          reasons.push({ code: "no_machine", reason: `${m.host}:${m.reason}` });
      }
    }
    const codes = reasons.map((r) => r.code);
    const code =
      codes.length > 0 && codes.every((c) => c === "not_accepting")
        ? "not_accepting"
        : codes.includes("busy")
          ? "busy"
          : "no_machine";
    throw new SandboxClientError(
      code,
      refusalText(
        code,
        spec.for,
        reasons.filter((r) => r.code === "no_machine").map((r) => r.reason),
      ),
    );
  }

  #remember(row: SandboxJobRow): void {
    try {
      this.#jobs?.insert(row);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot remember a sandbox job");
    }
  }

  /**
   * A job object for `view` of the job Core sent as `id`, its events polled; `cpus` what Core
   * asked (bounds its charges). Throws when the view is of another job.
   */
  #adopt(
    id: string,
    view: JobView,
    endpoint: Endpoint,
    payer: WorkPayer | null,
    charged: number,
    cpus: number,
  ): RemoteJob {
    const host = endpoint.host;
    const service = endpoint.service;
    const link: JobLink = {
      source: this.#source,
      endpoint: () => this.#endpointOf(host, service, endpoint) ?? endpoint,
      clock: this.#clock,
      partBytes: this.#config.transfer.part_mb * MIB,
      maxTransferBytes: this.#config.transfer.max_mb * MIB,
      output: {
        keep_bytes: this.#config.caps.max_output_bytes,
        kill_bytes: this.#config.caps.kill_output_bytes,
        stream_bytes: 256 * 1024,
      },
      collect: {
        max_files: this.#config.caps.max_files_out,
        max_bytes: this.#config.caps.max_files_out_bytes,
      },
      charge: (job, deltaMs) => this.#charge(job, deltaMs),
      ended: (job, reason) => this.#ended(job, reason),
    };
    const job = new RemoteJob(view, { id, host, service, payer, link, charged, cpus });
    const key = keyOf(endpoint);
    let poller = this.#pollers.get(key);
    if (!poller) {
      poller = { key, host, service, jobs: new Map(), cursor: null, running: false };
      this.#pollers.set(key, poller);
    }
    poller.jobs.set(job.id, job);
    this.#startPoll(poller);
    return job;
  }

  #charge(job: RemoteJob, deltaMs: number): void {
    const now = this.#clock.now();
    try {
      this.#jobs?.update(job.id, { cpu_ms: job.charged, updated_at: now });
    } catch {
      // Remembering the total is a convenience for a restart.
    }
    const quota = this.#quota();
    if (quota === null || job.payer === null) return;
    quota.charge(job.payer, now, deltaMs / 1000);
    if (quota.capped(job.payer, now) !== null) this.#stopPayer(job.payer.person);
  }

  /**
   * A person over their CPU seconds: every run of theirs stops, and their browser and plugin
   * jobs close, since those have no run to stop: a page mining in web workers would go on using
   * a friend's computer until its idle close. Their sessions stay open (their files are kept);
   * only the runs in them stop.
   */
  #stopPayer(person: string): void {
    for (const poller of this.#pollers.values()) {
      for (const job of [...poller.jobs.values()]) {
        if (job.payer?.person !== person) continue;
        if (job.kind === "browser" || job.kind === "plugin") void job.close("quota");
        else if (job.busy) job.stopAll("quota");
      }
    }
  }

  #ended(job: RemoteJob, reason: string): void {
    const now = this.#clock.now();
    try {
      this.#jobs?.end(job.id, reason, now);
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot mark a sandbox job ended");
    }
    const unit = this.#units.get(job.id);
    this.#units.delete(job.id);
    unit?.done({ ok: true, run_ms: job.runMs });
    for (const poller of this.#pollers.values()) poller.jobs.delete(job.id);
  }

  #startPoll(poller: Poller): void {
    if (poller.running || this.#closing.signal.aborted) return;
    poller.running = true;
    void this.#poll(poller).finally(() => {
      poller.running = false;
      if (poller.jobs.size > 0 && !this.#closing.signal.aborted) this.#startPoll(poller);
    });
  }

  async #poll(poller: Poller): Promise<void> {
    let failures = 0;
    while (poller.jobs.size > 0 && !this.#closing.signal.aborted) {
      const endpoint = this.#endpointOf(poller.host, poller.service, null);
      if (endpoint === null) {
        // The computer is gone from the registry: its jobs are lost once their lease is over.
        failures++;
        await this.#wait(failures);
        if (failures > 10) {
          for (const job of [...poller.jobs.values()]) job.end("lost");
        }
        continue;
      }
      const query = new URLSearchParams({
        wait_ms: String(this.#pollWaitMs),
        max_bytes: String(MIB),
        ...(poller.cursor === null ? {} : { after: poller.cursor }),
      });
      try {
        const page = await callJson(
          this.#source,
          endpoint,
          `/v1/events?${query.toString()}`,
          EventsPageSchema,
          {
            method: "GET",
            timeoutMs: this.#pollWaitMs + 15_000,
            maxBytes: Math.max(
              EVENTS_MAX_BYTES,
              MIB +
                execReplyBytes(
                  { keep_bytes: this.#config.caps.max_output_bytes },
                  {
                    max_files: this.#config.caps.max_files_out,
                    max_bytes: this.#config.caps.max_files_out_bytes,
                  },
                ),
            ),
            signal: this.#closing.signal,
          },
        );
        const first = poller.cursor === null;
        poller.cursor = page.cursor;
        for (const event of page.events) poller.jobs.get(event.job)?.handle(event);
        // Events may be gone (another start of the service, Core away too long): ask each job.
        if (page.reset && !first) {
          await Promise.all([...poller.jobs.values()].map((job) => job.refresh()));
        }
        failures = 0;
      } catch (error) {
        if (this.#closing.signal.aborted) return;
        failures++;
        log.debug({ host: poller.host, err: errorMessage(error) }, "sandbox events did not come");
        await this.#wait(failures);
      }
    }
  }

  async #wait(failures: number): Promise<void> {
    await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)), this.#closing.signal).catch(
      () => undefined,
    );
  }

  async #renewLeases(): Promise<void> {
    const jobs = [...this.#pollers.values()].flatMap((p) => [...p.jobs.values()]);
    await Promise.all(jobs.map((job) => job.lease()));
  }

  /**
   * After a restart of Core: the job of `row` if its computer still has it, else `null` (the row
   * is marked ended, `lost`).
   */
  async reattach(row: SandboxJobRow, payer: WorkPayer | null): Promise<RemoteJob | null> {
    const endpoint = this.#endpointOf(row.host, row.service, null);
    let view: JobView | null = null;
    if (endpoint !== null) {
      try {
        view = await callJson(this.#source, endpoint, `/v1/jobs/${row.id}`, JobViewSchema, {
          method: "GET",
          timeoutMs: TIMEOUTS.view,
        });
      } catch {
        view = null;
      }
      // A view of another job says nothing of this one.
      if (view !== null && view.id !== row.id) view = null;
    }
    if (endpoint === null || view === null || view.ended !== null) {
      this.#jobs?.end(row.id, view?.ended?.reason ?? "lost", this.#clock.now());
      return null;
    }
    // What it was opened with is not remembered; jobs kept across a restart are sessions, which
    // take the configured CPUs.
    const job = this.#adopt(row.id, view, endpoint, payer, row.cpu_ms, this.#config.limits.cpus);
    return job;
  }

  /** Jobs of a former Core that nobody will use again (runs, plugins, browsers): closed. */
  async dropLeftovers(rows: readonly SandboxJobRow[]): Promise<void> {
    await Promise.all(
      rows.map(async (row) => {
        const endpoint = this.#endpointOf(row.host, row.service, null);
        if (endpoint !== null) {
          await call(this.#source, endpoint, `/v1/jobs/${row.id}`, {
            method: "DELETE",
            timeoutMs: TIMEOUTS.close,
          }).catch(() => undefined);
        }
        this.#jobs?.end(row.id, "closed", this.#clock.now());
      }),
    );
  }

  /** Stops the polls and the lease timer; open jobs stay to their lease (sessions survive a restart). */
  close(): void {
    this.#closing.abort();
    clearInterval(this.#lease);
    this.#unwatch();
    this.#listeners.clear();
  }
}

/** A `SandboxJob` this client opened. */
export function isRemoteJob(job: SandboxJob): job is RemoteJob {
  return job instanceof RemoteJob;
}
