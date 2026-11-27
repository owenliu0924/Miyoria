// The sandbox service that `miyoria sandbox serve` runs on a computer that takes jobs
// (docs/design/v6-sandbox.md §1): a `node:http` server over the Docker CLI. It checks Docker and
// its images every 30 seconds and says in `/health` whether it can take work (`ready`, with the
// reason in words), reads the owner's `[sandbox]` of `host.toml` every 60 seconds, and after a
// restart takes back the jobs whose containers still run and removes everything else of its own.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import {
  SANDBOX_API_VERSION,
  type SandboxImage,
  type SandboxInfo,
} from "@miyoria/contracts/workers";
import { type Clock, systemClock } from "@miyoria/types";
import { keeperUser, versionArgs } from "../args.js";
import { ISOLATED_GATEWAY_DOCKER, isolatesGateway } from "../egress.js";
import { type DockerRunner, ProcessDockerRunner } from "../runner.js";
import { resolveUser } from "../sandbox.js";
import { acceptedTokens, isLoopback } from "./auth.js";
import { EventRing } from "./events.js";
import { type ImageStatus, imageStatus } from "./images.js";
import { JobManager, type ServiceContext } from "./jobs.js";
import { type HostConfigParser, PolicyFile, type PolicyReading } from "./policy.js";
import { createSandboxServer } from "./server.js";
import { ProcessSpawner, type ProcSpawner } from "./spawner.js";
import { DockerControl, decode, log, MIB, succeeded, why } from "./util.js";

export { buildImage, imageHash, imageSource, imageStatus, imageTag } from "./images.js";
export type { HostConfigParser, SandboxPolicy } from "./policy.js";
export { policyOf } from "./policy.js";

export interface SandboxServiceOptions {
  /** `HOST`. */
  host: string;
  /** `PORT` (0: any; `url` says which). */
  port: number;
  /** `SANDBOX_HOST_TOML`. */
  hostToml: string;
  /** `SANDBOX_STATE`. */
  state: string;
  /** `SANDBOX_IMAGE_DIR`. */
  imageDir: string;
  /** `MIYORIA_SERVICE_TOKEN`. */
  token: string | null;
  /** `MIYORIA_HOST_TOKEN`. */
  hostToken: string | null;
  /** Default `"docker"`. */
  docker?: string;
  /** Tests inject a fake one. */
  runner?: DockerRunner;
  spawner?: ProcSpawner;
  clock?: Clock;
  /**
   * Reads `host.toml` (hostd's `parseHostConfig`; the CLI hands it in). Without it the defaults
   * of `[sandbox]` hold, which take no member's or plugin's work.
   */
  parseHostConfig?: HostConfigParser;
  /** Tags used instead of the built ones (tests: `python:3.12-slim`, `node:24-slim`). */
  images?: Partial<Record<SandboxImage | "proxy", string>>;
  /** The programs' uid on Linux (default this process's); tests set it. */
  hostUser?: { uid: number; gid: number } | null;
  /** Addresses the proxies refuse besides the built-in table (default: this machine's own). */
  denyAddresses?: () => readonly string[];
  /** How often Docker and the images are checked; default 30 s. */
  checkEveryMs?: number;
  /** Default 5 s. */
  killGraceMs?: number;
  version?: string;
}

export interface RunningSandboxService {
  readonly url: string;
  /** Stops answering. Jobs stay: the next start takes them back (§13.3). */
  close(): Promise<void>;
  /** Checks Docker, the images and `host.toml` now (tests). */
  refresh(): Promise<void>;
  /** Ends the jobs that are over their time or the owner's rules now (tests; it runs every 15 s). */
  sweep(): Promise<void>;
}

interface DockerStatus {
  available: boolean;
  server_version: string | null;
  error: string | null;
  cgroup: "v2" | "v1" | null;
}

/** This service's id (labels) for as long as its state folder lives. */
async function instanceOf(state: string): Promise<string> {
  const file = join(state, "instance.json");
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { instance?: unknown };
    if (typeof raw.instance === "string" && /^[0-9a-f]{16}$/.test(raw.instance))
      return raw.instance;
  } catch {
    // First start.
  }
  const instance = randomBytes(8).toString("hex");
  await writeFile(file, JSON.stringify({ instance, created_at: Date.now() }));
  return instance;
}

/**
 * This machine's own addresses and the networks they are on, and Docker's bridge networks: the
 * proxy refuses them on top of the private ranges, because on some machines they are public (a
 * global IPv6 prefix, a public LAN), and they lead to this machine's and its neighbours' services.
 */
async function ownAddresses(docker: DockerControl): Promise<string[]> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      const address = nic.address.split("%")[0] as string;
      out.add(address);
      if (nic.cidr) out.add(nic.cidr.replace(/%[^/]*/, ""));
    }
  }
  const bridges = await docker.text([
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{range .IPAM.Config}}{{.Gateway}} {{.Subnet}} {{end}}",
  ]);
  for (const word of (bridges ?? "").split(/\s+/)) {
    if (/^[0-9a-f:.]+(\/\d+)?$/i.test(word)) out.add(word);
  }
  return [...out].filter((a) => /^[0-9a-f:.]{2,45}(\/\d{1,3})?$/i.test(a));
}

export async function startSandboxService(
  options: SandboxServiceOptions,
): Promise<RunningSandboxService> {
  const accepted = acceptedTokens(options.token, options.hostToken);
  if (accepted.length === 0 && !isLoopback(options.host)) {
    throw new Error(
      "the sandbox service runs other people's programs: without MIYORIA_SERVICE_TOKEN it only listens on loopback",
    );
  }
  const state = resolve(options.state);
  await mkdir(state, { recursive: true });
  const instance = await instanceOf(state);
  const boot = randomBytes(8).toString("hex");
  const clock = options.clock ?? systemClock;
  const executable = options.docker ?? "docker";
  const runner = options.runner ?? new ProcessDockerRunner(executable);
  const docker = new DockerControl(runner);
  const events = new EventRing(boot);
  const user = resolveUser(
    "auto",
    options.hostUser === undefined
      ? typeof process.getuid === "function" && typeof process.getgid === "function"
        ? { uid: process.getuid(), gid: process.getgid() }
        : null
      : options.hostUser,
  );
  const policyFile = new PolicyFile(options.hostToml, options.parseHostConfig ?? null);
  let policy: PolicyReading = await policyFile.read();
  let policyAt = clock.now();
  let dockerStatus: DockerStatus = {
    available: false,
    server_version: null,
    error: "還在檢查 Docker",
    cgroup: null,
  };
  const images: Record<SandboxImage, ImageStatus | null> = { default: null, browser: null };
  let proxyTag: string | null = null;
  let deny: readonly string[] = [];
  let diskLow = false;
  let recovered = false;

  const imageFor = (role: SandboxImage): { tag: string | null; reason: string } => {
    const status = images[role];
    if (!dockerStatus.available) {
      return { tag: null, reason: `這台的 Docker 沒有回應(${dockerStatus.error ?? "?"})` };
    }
    if (!isolatesGateway(dockerStatus.server_version)) {
      // Older engines leave a job network's gateway on this machine, so a job would reach every
      // service it listens on: no job at all (not ready) rather than run that way.
      return {
        tag: null,
        reason: `這台的 Docker 是 ${dockerStatus.server_version ?? "?"},要 ${ISOLATED_GATEWAY_DOCKER} 以上才擋得住工作連回這台電腦;請更新 Docker`,
      };
    }
    if (status === null) return { tag: null, reason: "這台沒有這種沙箱映像檔" };
    if (status.usable !== null) return { tag: status.usable, reason: "" };
    return {
      tag: null,
      reason: status.building
        ? "沙箱映像檔正在建"
        : "沙箱映像檔還沒建好:在這台執行 miyoria sandbox build",
    };
  };

  const ctx: ServiceContext = {
    docker,
    runner,
    spawner: options.spawner ?? new ProcessSpawner(executable),
    events,
    clock,
    instance,
    jobsDir: join(state, "jobs"),
    user,
    keeper: keeperUser(user),
    policy: () => policy.policy,
    image: imageFor,
    proxyImage: () => proxyTag,
    denyAddresses: () => options.denyAddresses?.() ?? deny,
    killGraceMs: options.killGraceMs ?? 5_000,
  };
  const jobs = new JobManager(ctx);

  const readiness = (): { ready: boolean; reason?: string } => {
    if (policy.error !== null) {
      return { ready: false, reason: `host.toml 的 [sandbox] 讀不進來(${policy.error})` };
    }
    if (!dockerStatus.available) {
      return { ready: false, reason: `這台的 Docker 沒有回應(${dockerStatus.error ?? "?"})` };
    }
    const image = imageFor("default");
    if (image.tag === null) return { ready: false, reason: image.reason };
    if (diskLow) return { ready: false, reason: "磁碟剩不到 [sandbox] disk_mb 的 10%" };
    if (!recovered) return { ready: false, reason: "還在整理上次留下的工作" };
    return { ready: true };
  };

  const refresh = async (): Promise<void> => {
    if (clock.now() - policyAt >= 60_000) {
      policy = await policyFile.read();
      policyAt = clock.now();
    }
    const version = await docker.run(versionArgs());
    const text = decode(version.stdout).trim();
    const available = succeeded(version) && text !== "";
    let cgroup: DockerStatus["cgroup"] = null;
    if (available) {
      const info = await docker.text(["info", "--format", "{{.CgroupVersion}}"]);
      const v = info?.trim();
      cgroup = v === "2" ? "v2" : v === "1" ? "v1" : null;
    }
    if (available !== dockerStatus.available) {
      if (available) log.info({ version: text }, "docker is available");
      else log.warn({ err: why(version) }, "docker is not available; the sandbox is not ready");
    }
    dockerStatus = {
      available,
      server_version: available ? text : null,
      error: available ? null : why(version),
      cgroup,
    };
    if (!available) return;
    for (const role of ["default", "browser"] as const) {
      const fixed = options.images?.[role];
      if (fixed !== undefined) {
        const present = succeeded(
          await docker.run(["image", "inspect", "--format", "{{.Id}}", fixed]),
        );
        images[role] = {
          tag: fixed,
          present,
          building: false,
          stale: false,
          usable: present ? fixed : null,
        };
      } else {
        images[role] = await imageStatus(docker, options.imageDir, state, role).catch(() => null);
      }
    }
    proxyTag = options.images?.proxy ?? images.default?.usable ?? null;
    deny = await ownAddresses(docker).catch(() => deny);
    try {
      const fs = await statfs(state);
      diskLow = fs.bavail * fs.bsize < policy.policy.disk_mb * MIB * 0.1;
    } catch {
      diskLow = false;
    }
    if (!recovered) {
      await jobs.recover();
      recovered = true;
    }
  };

  let checking: Promise<void> | null = null;
  const check = () => {
    checking ??= refresh()
      .catch((error: unknown) => log.error({ err: String(error) }, "sandbox check failed"))
      .finally(() => {
        checking = null;
      });
    return checking;
  };

  const info = (): SandboxInfo => {
    const p = policy.policy;
    const reserved = jobs.reserved();
    const r = readiness();
    const imageInfo = (role: SandboxImage) => {
      const s = images[role];
      return {
        tag: s?.tag ?? "",
        present: s?.present ?? false,
        building: s?.building ?? false,
        stale: s?.stale ?? false,
      };
    };
    return {
      api: SANDBOX_API_VERSION,
      service_version: options.version ?? "0",
      boot,
      platform: process.platform,
      arch: process.arch,
      docker: { ...dockerStatus, runtime: p.runtime },
      images: { default: imageInfo("default"), browser: imageInfo("browser") },
      ready: r.ready,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      policy: {
        members: p.members,
        plugins: p.plugins,
        cpus: p.cpus,
        memory_mb: p.memory_mb,
        disk_mb: p.disk_mb,
        max_job_cpus: p.max_job_cpus,
        max_job_memory_mb: p.max_job_memory_mb,
      },
      load: {
        jobs: reserved.jobs,
        running: jobs.runningExecs(),
        queued: 0,
        cpus: reserved.cpus,
        memory_mb: reserved.memory_mb,
        disk_mb: reserved.disk_mb,
      },
    };
  };

  const server = createSandboxServer({
    jobs,
    events,
    accepted,
    info,
    health: () => {
      const running = jobs.runningExecs();
      const r = readiness();
      return {
        status: "ok",
        running,
        busy: running > 0,
        queued: 0,
        ready: r.ready,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
      };
    },
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = `http://${host}:${port}`;
  void check();
  jobs.start();
  const timer = setInterval(() => void check(), options.checkEveryMs ?? 30_000);
  log.info({ url, instance, state }, "sandbox service listening");

  return {
    url,
    sweep: () => jobs.sweep(),
    refresh: async () => {
      policyAt = Number.NEGATIVE_INFINITY;
      await check();
      await check();
    },
    close: async () => {
      clearInterval(timer);
      jobs.stop();
      events.wakeAll();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      await checking;
      for (const job of jobs.all()) await job.persist();
    },
  };
}
