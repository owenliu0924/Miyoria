// Jobs (docs/design/v6-sandbox.md §2, §3.4, §13): one long-lived container each, with its own
// folders, its own internal network and its own egress proxy. This file is the state machine:
// opening (with the machine's reservations), the lease, idle and lifetime, ending and tearing
// down, and taking jobs back after the service restarted. What runs inside a job is in
// execs.ts and procs.ts; files in and out in uploads.ts and syncs.ts.

import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type {
  ExecResult,
  ExecView,
  JobCreate,
  JobUsage,
  JobView,
  ManifestEntry,
  SandboxEndReason,
  SandboxImage,
  SandboxLimits,
} from "@miyoria/contracts/workers";
import { sleep } from "@miyoria/runtime/kernel";
import type { Clock } from "@miyoria/types";
import {
  buildRunArgs,
  KEEPER_COMMAND,
  killAllArgs,
  LABEL,
  LABEL_INSTANCE,
  LABEL_KIND,
  NAME_PREFIX,
  removeArgs,
  runningArgs,
  WORKSPACE_DIR,
} from "../args.js";
import {
  addressesInSubnets,
  DEFAULT_DENY_PORTS,
  EGRESS_ALIAS,
  type EgressStats,
  egressNetworkName,
  egressProxyName,
  egressReadyArgs,
  egressStatsArgs,
  jobEgressProxyArgs,
  LABEL_JOB,
  networkConnectArgs,
  networkCreateArgs,
  networkGatewayModeArgs,
  networkRemoveArgs,
  networkSubnetsArgs,
  parseEgressStats,
  proxyEnv,
} from "../egress.js";
import type { DockerRunner } from "../runner.js";
import { CpuMeter } from "./cpu.js";
import { measure, removeTree } from "./disk.js";
import type { EventRing, NewEvent } from "./events.js";
import { accepts, type SandboxPolicy } from "./policy.js";
import type { ProcSpawner } from "./spawner.js";
import {
  type DockerControl,
  decode,
  log,
  MIB,
  requestHash,
  ServiceError,
  START_TIMEOUT_MS,
  succeeded,
  why,
} from "./util.js";
import { applyLimits, checkJobCreate } from "./validate.js";

/** The port the proxy listens on inside its container. */
export const PROXY_PORT = 3128;
/** How long a job's end is remembered (`GET` answers 410 with it, Core is told once). */
const ENDED_KEPT_MS = 60 * 60_000;
const SWEEP_MS = 15_000;
const PROXY_READY_TRIES = 40;
const PROXY_READY_WAIT_MS = 250;

/** What every part of the service shares. */
export interface ServiceContext {
  docker: DockerControl;
  runner: DockerRunner;
  spawner: ProcSpawner;
  events: EventRing;
  clock: Clock;
  instance: string;
  jobsDir: string;
  /** The programs' `uid:gid`; the keeper's is another one. */
  user: string;
  keeper: string;
  policy(): SandboxPolicy;
  /** The image tag a job of `role` gets now; `null` with why not. */
  image(role: SandboxImage): { tag: string | null; reason: string };
  /** The tag the egress proxy runs (it needs node). */
  proxyImage(): string | null;
  /** This machine's own addresses and Docker's gateways (the proxy refuses them). */
  denyAddresses(): readonly string[];
  /** How long a kill gets before the CLI is dropped. */
  killGraceMs: number;
}

/** A folder layout of one job (§2.2). */
export interface JobDirs {
  root: string;
  work: string;
  workspace: string;
  home: string;
  code: string;
  tools: string;
  ext: string;
  incoming: string;
  outgoing: string;
  execs: string;
}

export function jobDirs(jobsDir: string, id: string): JobDirs {
  const root = join(jobsDir, id);
  return {
    root,
    work: join(root, "work"),
    workspace: join(root, "workspace"),
    home: join(root, "home"),
    code: join(root, "code"),
    tools: join(root, "tools"),
    ext: join(root, "ext"),
    incoming: join(root, "incoming"),
    outgoing: join(root, "outgoing"),
    execs: join(root, "execs"),
  };
}

/** One exec, while it runs and after. */
export interface ExecRecord {
  id: string;
  hash: string;
  state: ExecView["state"];
  started_at: number;
  result: ExecResult | null;
  /** Stops it; the reason is its `killed_reason`. */
  kill(reason: NonNullable<ExecResult["killed_reason"]>): void;
  done: Promise<void>;
  logFile: string;
}

/** One background program of a browser or plugin job (procs.ts). */
export interface ProcHandle {
  id: string;
  hash: string;
  running: boolean;
  stop(): Promise<void>;
}

/** What `job.json` keeps (§13.3: a restarted service takes the job back from it). */
interface JobFile {
  id: string;
  instance: string;
  request: JobCreate;
  hash: string;
  limits: SandboxLimits;
  image_tag: string;
  network: string | null;
  proxy: string | null;
  created_at: number;
  last_used_at: number;
  touched_at: number;
  exec: string | null;
  procs: string[];
}

/** A simple lock: one state change of a job at a time. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const before = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export class Job {
  readonly lock = new Mutex();
  readonly execs = new Map<string, ExecRecord>();
  readonly procs = new Map<string, ProcHandle>();
  readonly uploads = new Map<string, { hash: string; result: unknown }>();
  readonly syncs = new Map<
    string,
    { hash: string; result: unknown; manifest: Map<string, ManifestEntry>; tar: string | null }
  >();
  /** What Core has of `/workspace` (the last upload's manifest, then each received sync's). */
  base = new Map<string, ManifestEntry>();
  state: JobView["state"] = "starting";
  ended: { reason: SandboxEndReason; at: number } | null = null;
  current: ExecRecord | null = null;
  /** An exec id from before a restart: its result is lost. */
  lostExec: string | null = null;
  diskBytes = 0;
  egress: EgressStats = {
    bytes_in: 0,
    bytes_out: 0,
    open: 0,
    total: 0,
    refused: { address: 0, port: 0, cap: 0 },
    limited: false,
  };
  /** Set when the job is to end once its exec is done (a stricter host policy, the disk). */
  endAfterExec: SandboxEndReason | null = null;
  /** Frozen by `whileQuiet`: no `docker exec` reaches it then (the CPU waits for the next tick). */
  paused = false;
  #teardown: Promise<void> | null = null;
  readonly container: string;
  readonly cpu: CpuMeter;

  constructor(
    readonly ctx: ServiceContext,
    readonly id: string,
    readonly request: JobCreate,
    readonly hash: string,
    readonly limits: SandboxLimits,
    readonly imageTag: string,
    readonly dirs: JobDirs,
    public network: string | null,
    public proxy: string | null,
    public createdAt: number,
    public lastUsedAt: number,
    public touchedAt: number,
  ) {
    this.container = `${NAME_PREFIX}${id}`;
    this.cpu = new CpuMeter(ctx.docker, this.container, ctx.keeper, () => ctx.clock.now());
  }

  get live(): boolean {
    return this.state !== "ended";
  }

  get running(): boolean {
    return this.current !== null || [...this.procs.values()].some((p) => p.running);
  }

  /** Any request that names the job renews its lease. */
  touch(): void {
    this.touchedAt = this.ctx.clock.now();
  }

  /**
   * Something ran or moved: the idle clock starts again. Never the lease: what the program in the
   * container prints would otherwise keep a job alive whose Core is gone (§3.5: only Core's own
   * requests renew it, through `touch`, which every request naming the job makes).
   */
  used(): void {
    this.lastUsedAt = this.ctx.clock.now();
  }

  expiresAt(): number {
    const r = this.request;
    const times = [this.touchedAt + r.lease_s * 1000];
    if (r.lifetime_s > 0) times.push(this.createdAt + r.lifetime_s * 1000);
    if (r.idle_s > 0) times.push(this.lastUsedAt + r.idle_s * 1000);
    return Math.min(...times);
  }

  /** Why the job is over its time now, or `null`; a running exec is never ended for idling. */
  expired(now: number): SandboxEndReason | null {
    const r = this.request;
    if (now >= this.touchedAt + r.lease_s * 1000) return "lease";
    if (r.lifetime_s > 0 && now >= this.createdAt + r.lifetime_s * 1000) return "lifetime";
    if (r.idle_s > 0 && !this.running && now >= this.lastUsedAt + r.idle_s * 1000) return "idle";
    return null;
  }

  usage(): JobUsage {
    return {
      cpu_ms: this.cpu.totalMs,
      cpu_source: this.cpu.source,
      wall_ms: Math.max(0, (this.ended?.at ?? this.ctx.clock.now()) - this.createdAt),
      disk_bytes: this.diskBytes,
      egress: {
        bytes_in: this.egress.bytes_in,
        bytes_out: this.egress.bytes_out,
        connections: this.egress.total,
        refused: { ...this.egress.refused },
      },
    };
  }

  view(): JobView {
    return {
      id: this.id,
      kind: this.request.kind,
      state: this.state,
      ended: this.ended,
      image_tag: this.imageTag,
      limits: this.limits,
      created_at: this.createdAt,
      last_used_at: this.lastUsedAt,
      expires_at: this.expiresAt(),
      usage: this.usage(),
      exec: this.current?.id ?? null,
      procs: [...this.procs.values()].filter((p) => p.running).map((p) => p.id),
    };
  }

  emit(event: NewEvent): void {
    this.ctx.events.push(event);
  }

  /** `end` has begun. */
  get ending(): boolean {
    return this.#teardown !== null;
  }

  setState(state: JobView["state"]): void {
    if (this.state === state || this.state === "ended" || this.ending) return;
    this.state = state;
    this.emit({ job: this.id, kind: "state", state });
  }

  /** Refuses when the job ended (410 with the end). */
  assertLive(): void {
    if (this.ended !== null) {
      throw new ServiceError("gone", "the job has ended", { ended: this.ended });
    }
  }

  async persist(): Promise<void> {
    if (!this.live) return;
    const file: JobFile = {
      id: this.id,
      instance: this.ctx.instance,
      request: this.request,
      hash: this.hash,
      limits: this.limits,
      image_tag: this.imageTag,
      network: this.network,
      proxy: this.proxy,
      created_at: this.createdAt,
      last_used_at: this.lastUsedAt,
      touched_at: this.touchedAt,
      exec: this.current?.id ?? null,
      procs: [...this.procs.keys()],
    };
    const path = join(this.dirs.root, "job.json");
    await writeFile(`${path}.tmp`, JSON.stringify(file))
      .then(() => rename(`${path}.tmp`, path))
      .catch((error: unknown) =>
        log.warn({ job: this.id, err: String(error) }, "cannot write job.json"),
      );
  }

  /** Reads the proxy's counters (`/tmp/egress.json` in its container). */
  async readEgress(): Promise<void> {
    if (this.proxy === null) return;
    const out = await this.ctx.docker.text(egressStatsArgs(this.proxy));
    const stats = out === null ? null : parseEgressStats(out);
    if (stats !== null) this.egress = stats;
  }

  /** `/work`, `/workspace` and `/home` together. */
  async measureDisk(): Promise<{ bytes: number; over: boolean }> {
    const reading = await measure([this.dirs.work, this.dirs.workspace, this.dirs.home]);
    this.diskBytes = reading.bytes;
    return {
      bytes: reading.bytes,
      // What could not be read is not known to be small: over, never under-counted.
      over:
        reading.truncated || reading.unreadable > 0 || reading.bytes > this.limits.disk_mb * MIB,
    };
  }

  /**
   * Ends the job once (`reason` is the first one given): the running exec and the procs stop, the
   * last CPU and egress readings are taken, the container, proxy, network and folders go, and an
   * `ended` event says so.
   */
  end(reason: SandboxEndReason): Promise<void> {
    if (this.#teardown !== null) return this.#teardown;
    this.#teardown = (async () => {
      const killed =
        reason === "closed"
          ? "aborted"
          : reason === "disk"
            ? "disk"
            : reason === "lifetime"
              ? "timeout"
              : "lost";
      const exec = this.current;
      if (exec !== null) {
        exec.kill(killed);
        await Promise.race([exec.done, sleep(this.ctx.killGraceMs + 5_000)]).catch(() => undefined);
      }
      for (const proc of this.procs.values()) await proc.stop().catch(() => undefined);
      await this.cpu.read().catch(() => undefined);
      await this.readEgress().catch(() => undefined);
      this.ended = { reason, at: this.ctx.clock.now() };
      this.state = "ended";
      this.emit({ job: this.id, kind: "state", state: "ended" });
      this.emit({ job: this.id, kind: "ended", reason, usage: this.usage() });
      log.info(
        { job: this.id, kind: this.request.kind, reason, cpu_ms: this.cpu.totalMs },
        "sandbox job ended",
      );
      await teardown(this.ctx, this.container, this.proxy, this.network, this.dirs.root);
    })();
    return this.#teardown;
  }
}

/** Removes what a job had on Docker and on disk. Failures are logged, never thrown. */
export async function teardown(
  ctx: ServiceContext,
  container: string | null,
  proxy: string | null,
  network: string | null,
  root: string | null,
): Promise<void> {
  const names = [container, proxy].filter((n): n is string => n !== null);
  if (names.length > 0) await ctx.docker.run(removeArgs(names));
  if (network !== null) {
    const removed = await ctx.docker.run(networkRemoveArgs(network));
    if (!succeeded(removed) && !/no such network|not found/i.test(why(removed))) {
      log.warn({ network, err: why(removed) }, "cannot remove a job's network");
    }
  }
  if (root !== null) {
    await removeTree(root).catch((error: unknown) =>
      log.warn({ root, err: String(error) }, "cannot remove a job's folder"),
    );
  }
}

/** The environment of a job's container: fixed values, the proxy, then the request's own. */
export function containerEnv(request: JobCreate): Record<string, string> {
  return {
    HOME: "/home/sandbox",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    PATH: "/home/sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin",
    PIP_USER: "1",
    NPM_CONFIG_PREFIX: "/home/sandbox/.local",
    ...(request.network.mode === "none" ? {} : proxyEnv(PROXY_PORT)),
    ...request.env,
  };
}

/** `docker run -d` of a job's container (§2.3). */
export function jobRunArgs(ctx: ServiceContext, job: Job): string[] {
  const r = job.request;
  return buildRunArgs({
    name: job.container,
    image: job.imageTag,
    labels: {
      [LABEL]: "1",
      [LABEL_INSTANCE]: ctx.instance,
      [LABEL_JOB]: job.id,
      [LABEL_KIND]: r.kind,
    },
    workDir: job.dirs.work,
    codeDir: job.dirs.code,
    toolsDir: r.mounts.tools ? job.dirs.tools : null,
    workspaceDir: job.dirs.workspace,
    homeDir: job.dirs.home,
    extDir: r.kind === "plugin" || r.mounts.ext ? job.dirs.ext : null,
    cgroupns: "private",
    tmpExec: true,
    shmMb: r.kind === "browser" ? 256 : null,
    runtime: ctx.policy().runtime,
    workdir: WORKSPACE_DIR,
    network: job.network ?? "none",
    user: ctx.keeper,
    limits: {
      cpus: job.limits.cpus,
      memory_mb: job.limits.memory_mb,
      pids_limit: job.limits.pids,
      tmpfs_mb: job.limits.tmp_mb,
      max_file_size_bytes: job.limits.file_mb * MIB,
      nofile: job.limits.nofile,
    },
    command: KEEPER_COMMAND,
    env: containerEnv(r),
    detached: true,
  });
}

/** Reserved resources of the jobs that are not over. */
export interface Reserved {
  jobs: number;
  cpus: number;
  memory_mb: number;
  disk_mb: number;
}

export class JobManager {
  readonly #jobs = new Map<string, Job>();
  #sweep: ReturnType<typeof setInterval> | null = null;

  constructor(readonly ctx: ServiceContext) {}

  get(id: string): Job | null {
    return this.#jobs.get(id) ?? null;
  }

  /** A job that is live, or 404 / 410. Touches it (lease). */
  live(id: string): Job {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new ServiceError("not_found", "no such job");
    job.assertLive();
    job.touch();
    return job;
  }

  all(): Job[] {
    return [...this.#jobs.values()];
  }

  reserved(): Reserved {
    const out: Reserved = { jobs: 0, cpus: 0, memory_mb: 0, disk_mb: 0 };
    for (const job of this.#jobs.values()) {
      if (!job.live) continue;
      out.jobs += 1;
      out.cpus += job.limits.cpus;
      out.memory_mb += job.limits.memory_mb;
      out.disk_mb += job.limits.disk_mb;
    }
    return out;
  }

  /** Execs running now (`/health`'s `running`). */
  runningExecs(): number {
    return this.all().filter((j) => j.live && j.current !== null).length;
  }

  /**
   * `PUT /v1/jobs/{id}`: 201 with the new job, 200 when the same request came before, 409 when
   * the id was used for another one (§3.4).
   */
  async create(id: string, request: JobCreate): Promise<{ status: 200 | 201; view: JobView }> {
    const hash = requestHash(request);
    const existing = this.#jobs.get(id);
    if (existing !== undefined) {
      if (existing.hash !== hash)
        throw new ServiceError("conflict", "this job id was used for another job");
      existing.touch();
      return { status: 200, view: existing.view() };
    }
    checkJobCreate(request);
    const policy = this.ctx.policy();
    if (!accepts(policy, request.for)) {
      throw new ServiceError(
        "not_accepting",
        request.for === "member"
          ? "這台電腦的主人沒有開放替成員跑程式"
          : "這台電腦的主人沒有開放插件在這裡跑",
      );
    }
    const limits = applyLimits(request.limits, policy);
    const reserved = this.reserved();
    const busy = (message: string) => new ServiceError("busy", message, { retry_after_ms: 5_000 });
    if (reserved.jobs >= policy.concurrency)
      throw busy(`this machine runs at most ${policy.concurrency} jobs at once`);
    if (reserved.cpus + limits.cpus > policy.cpus + 1e-9)
      throw busy("not enough CPUs left on this machine");
    if (reserved.memory_mb + limits.memory_mb > policy.memory_mb)
      throw busy("not enough memory left on this machine");
    if (reserved.disk_mb + limits.disk_mb > policy.disk_mb)
      throw busy("not enough disk left on this machine");
    if (request.payer !== null) {
      // One person cannot take every place on a friend's machine.
      const perPayer = Math.max(1, Math.ceil(policy.concurrency / 2));
      const theirs = this.all().filter((j) => j.live && j.request.payer === request.payer).length;
      if (theirs >= perPayer)
        throw busy("this person already has as many jobs here as one person may");
    }
    const image = this.ctx.image(request.image);
    if (image.tag === null)
      throw new ServiceError("unavailable", image.reason, { reason: image.reason });
    const proxyImage = request.network.mode === "none" ? null : this.ctx.proxyImage();
    if (request.network.mode !== "none" && proxyImage === null) {
      throw new ServiceError("unavailable", "沙箱映像檔還沒建好:在這台執行 miyoria sandbox build");
    }

    const now = this.ctx.clock.now();
    const dirs = jobDirs(this.ctx.jobsDir, id);
    const job = new Job(
      this.ctx,
      id,
      request,
      hash,
      limits,
      image.tag,
      dirs,
      request.network.mode === "none" ? null : egressNetworkName(this.ctx.instance, id),
      request.network.mode === "none" ? null : egressProxyName(this.ctx.instance, id),
      now,
      now,
      now,
    );
    // Reserved before the slow part, so two requests at once cannot both take the last place.
    this.#jobs.set(id, job);
    job.emit({ job: id, kind: "state", state: "starting" });
    try {
      await this.#start(job, proxyImage);
    } catch (error) {
      this.#jobs.delete(id);
      await teardown(this.ctx, job.container, job.proxy, job.network, dirs.root);
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "docker_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    job.setState("ready");
    await job.persist();
    log.info(
      { job: id, kind: request.kind, for: request.for, image: image.tag },
      "sandbox job started",
    );
    return { status: 201, view: job.view() };
  }

  async #start(job: Job, proxyImage: string | null): Promise<void> {
    const { ctx } = this;
    const d = job.dirs;
    await mkdir(ctx.jobsDir, { recursive: true, mode: 0o700 });
    // Other users of this machine cannot reach into a job (on Linux its files are this user's).
    await chmod(ctx.jobsDir, 0o700).catch(() => undefined);
    await mkdir(d.root, { mode: 0o700 });
    for (const dir of [
      d.work,
      d.workspace,
      d.home,
      d.code,
      d.tools,
      d.ext,
      d.incoming,
      d.outgoing,
      d.execs,
    ]) {
      await mkdir(dir);
    }
    // The program's uid differs from this process's on Docker Desktop: what it writes is open.
    for (const dir of [d.work, d.workspace, d.home]) await chmod(dir, 0o777);
    for (const dir of [d.code, d.tools, d.ext]) await chmod(dir, 0o755);
    await job.persist();
    const fail = (what: string, result: Parameters<typeof why>[0]) =>
      new ServiceError("docker_failed", `cannot ${what}: ${why(result)}`);

    if (job.network !== null && job.proxy !== null && proxyImage !== null) {
      const created = await ctx.docker.run(networkCreateArgs(job.network, ctx.instance, job.id));
      if (!succeeded(created)) throw fail("create the job's network", created);
      const leak = await networkLeak(ctx.docker, job.network);
      if (leak !== null) throw new ServiceError("docker_failed", leak);
      const r = job.request.network;
      const started = await ctx.docker.run(
        jobEgressProxyArgs({
          name: job.proxy,
          instance: ctx.instance,
          job: job.id,
          image: proxyImage,
          port: PROXY_PORT,
          egress: {
            mode: r.mode === "allowlist" ? "allowlist" : "open",
            allow: r.allow,
            denyPorts: [
              ...new Set([...r.deny_ports, ...(r.mode === "open" ? DEFAULT_DENY_PORTS : [])]),
            ],
            maxConnections: r.max_connections,
            maxBytes: r.max_mb * MIB,
            denyAddresses: ctx.denyAddresses(),
          },
        }),
        { timeoutMs: START_TIMEOUT_MS },
      );
      if (!succeeded(started)) throw fail("start the egress proxy", started);
      const connected = await ctx.docker.run(networkConnectArgs(job.network, job.proxy));
      if (!succeeded(connected))
        throw fail(`put the proxy on the network as ${EGRESS_ALIAS}`, connected);
      let ready = false;
      for (let i = 0; i < PROXY_READY_TRIES && !ready; i++) {
        ready = succeeded(await ctx.docker.run(egressReadyArgs(job.proxy, PROXY_PORT)));
        if (!ready) await sleep(PROXY_READY_WAIT_MS);
      }
      if (!ready)
        throw new ServiceError("docker_failed", "the egress proxy did not start listening");
    }

    const started = await ctx.docker.run(jobRunArgs(ctx, job), { timeoutMs: START_TIMEOUT_MS });
    if (!succeeded(started)) throw fail("start the job's container", started);
    if ((await containerState(ctx.docker, job.container)) !== "running") {
      throw new ServiceError("docker_failed", "the job's container stopped right after it started");
    }
  }

  /** `DELETE /v1/jobs/{id}`: ends it and answers with the last view. */
  async close(id: string): Promise<JobView> {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new ServiceError("not_found", "no such job");
    await job.end("closed");
    return job.view();
  }

  /** Every 15 s: times, the host policy, containers that went away, forgotten ends. */
  start(): void {
    let sweeping = false;
    // One sweep at a time: ending a job can take longer than the interval.
    this.#sweep ??= setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      void this.sweep()
        .catch((error: unknown) => log.error({ err: String(error) }, "sandbox sweep failed"))
        .finally(() => {
          sweeping = false;
        });
    }, SWEEP_MS);
  }

  stop(): void {
    if (this.#sweep !== null) clearInterval(this.#sweep);
    this.#sweep = null;
  }

  async sweep(): Promise<void> {
    const now = this.ctx.clock.now();
    const policy = this.ctx.policy();
    for (const job of this.all()) {
      if (!job.live) {
        if (job.ended !== null && now - job.ended.at > ENDED_KEPT_MS) this.#jobs.delete(job.id);
        continue;
      }
      if (job.state === "starting") continue;
      const expired = job.expired(now);
      if (expired !== null) {
        await job.end(expired);
        continue;
      }
      if (!accepts(policy, job.request.for)) {
        // Stricter rules of the owner: a job with an exec running ends right after it.
        if (job.current === null) await job.end("host_policy");
        else job.endAfterExec = "host_policy";
        continue;
      }
      if (
        job.current === null &&
        (await containerState(this.ctx.docker, job.container)) === "gone"
      ) {
        await job.end("lost");
        continue;
      }
      await job.persist();
    }
  }

  /**
   * After a restart (§13.3): jobs whose container still runs and whose lease holds are taken
   * back, every program process in them killed first (the CLI that ran it died with the old
   * service, the process may not have). Everything else of this instance goes: containers,
   * proxies, networks and folders of jobs that are not taken back.
   */
  async recover(): Promise<{ adopted: string[]; removed: number }> {
    const { ctx } = this;
    const now = ctx.clock.now();
    const adopted: string[] = [];
    let names: string[] = [];
    try {
      names = await readdir(ctx.jobsDir);
    } catch {
      // No job yet.
    }
    for (const name of names) {
      const root = join(ctx.jobsDir, name);
      const file = await readJobFile(root);
      if (file === null || file.id !== name || file.instance !== ctx.instance) {
        await removeTree(root).catch(() => undefined);
        continue;
      }
      const dirs = jobDirs(ctx.jobsDir, name);
      const job = new Job(
        ctx,
        file.id,
        file.request,
        file.hash,
        file.limits,
        file.image_tag,
        dirs,
        file.network,
        file.proxy,
        file.created_at,
        file.last_used_at,
        file.touched_at,
      );
      const keep =
        job.expired(now) === null &&
        accepts(ctx.policy(), file.request.for) &&
        (await containerState(ctx.docker, job.container)) === "running" &&
        (job.proxy === null || (await containerState(ctx.docker, job.proxy)) === "running") &&
        // A job from before networks were isolated would keep a way to this machine.
        (job.network === null || (await networkLeak(ctx.docker, job.network)) === null) &&
        succeeded(await ctx.docker.run(killAllArgs(job.container, ctx.user)));
      if (!keep) {
        await teardown(ctx, job.container, job.proxy, job.network, root);
        continue;
      }
      job.state = "ready";
      job.lostExec = file.exec;
      await removeTree(dirs.incoming)
        .then(() => mkdir(dirs.incoming))
        .catch(() => undefined);
      await removeTree(dirs.outgoing)
        .then(() => mkdir(dirs.outgoing))
        .catch(() => undefined);
      this.#jobs.set(job.id, job);
      for (const proc of file.procs) {
        job.emit({ job: job.id, proc, kind: "proc_exit", code: null, signal: "lost" });
      }
      await job.cpu.read();
      await job.persist();
      adopted.push(job.id);
    }
    const removed = await this.removeOrphans(new Set(adopted));
    if (adopted.length > 0 || removed > 0)
      log.info({ adopted, removed }, "sandbox jobs after a restart");
    return { adopted, removed };
  }

  /** Containers and networks of this instance that belong to no live job. */
  async removeOrphans(keep: ReadonlySet<string>): Promise<number> {
    const { docker, instance } = this.ctx;
    let removed = 0;
    const filters = [
      "--filter",
      `label=${LABEL}=1`,
      "--filter",
      `label=${LABEL_INSTANCE}=${instance}`,
    ];
    const containers = await docker.text([
      "ps",
      "-a",
      ...filters,
      "--format",
      `{{.ID}} {{.Label "${LABEL_JOB}"}}`,
    ]);
    const doomed: string[] = [];
    for (const line of (containers ?? "").split(/\r?\n/)) {
      const [cid, job] = line.trim().split(/\s+/);
      if (cid && /^[0-9a-f]{12,64}$/.test(cid) && !(job && keep.has(job))) doomed.push(cid);
    }
    if (doomed.length > 0 && succeeded(await docker.run(removeArgs(doomed))))
      removed += doomed.length;
    const networks = await docker.text([
      "network",
      "ls",
      ...filters,
      "--format",
      `{{.Name}} {{.Label "${LABEL_JOB}"}}`,
    ]);
    for (const line of (networks ?? "").split(/\r?\n/)) {
      const [net, job] = line.trim().split(/\s+/);
      if (!net?.startsWith(NAME_PREFIX) || (job && keep.has(job))) continue;
      if (succeeded(await docker.run(networkRemoveArgs(net)))) removed += 1;
    }
    return removed;
  }
}

async function readJobFile(root: string): Promise<JobFile | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, "job.json"), "utf8")) as JobFile;
    return typeof raw.id === "string" && typeof raw.hash === "string" && raw.request ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Why a job's network leads to this machine, or `null` when it does not: it must have been made
 * with gateway mode `isolated`, and on Linux (where Docker's bridges are this machine's own
 * interfaces) none of this machine's addresses may lie in its subnets. Elsewhere Docker runs in a
 * VM whose bridges are not interfaces here, and an unrelated adapter (WSL's) can share a range.
 */
export async function networkLeak(
  docker: DockerControl,
  network: string,
  platform: NodeJS.Platform = process.platform,
  addresses: () => string[] = ownInterfaceAddresses,
): Promise<string | null> {
  const mode = await docker.run(networkGatewayModeArgs(network));
  if (!succeeded(mode)) return `cannot inspect the job's network: ${why(mode)}`;
  const value = decode(mode.stdout).trim();
  if (value !== "isolated") {
    return `the job's network has gateway mode "${value || "nat"}", not "isolated": Docker kept an address on this machine`;
  }
  if (platform !== "linux") return null;
  const subnets = (await docker.text(networkSubnetsArgs(network))) ?? "";
  const inside = addressesInSubnets(subnets.split(/\s+/).filter(Boolean), addresses());
  return inside.length === 0
    ? null
    : `this machine has ${inside.join(", ")} on the job's network (${subnets.trim()}): a program there would reach its services`;
}

function ownInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((n) => n.address));
}

/** Whether a container runs, stopped, or is not there (`unknown` when Docker did not say). */
export async function containerState(
  docker: DockerControl,
  name: string,
): Promise<"running" | "stopped" | "gone" | "unknown"> {
  const result = await docker.run(runningArgs(name));
  if (succeeded(result)) return decode(result.stdout).trim() === "true" ? "running" : "stopped";
  return /no such (container|object)/i.test(decode(result.stderr)) ? "gone" : "unknown";
}
