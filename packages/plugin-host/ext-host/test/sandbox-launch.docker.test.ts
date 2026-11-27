// An extension in a real sandbox job: the fixture extension's folder goes to the sandbox service
// on real Docker, its program runs there as a proc, it registers its tools over the proc's
// channel and one of them is called (docs/design/v6-agent-split.md §2 P8).
//
// What it needs, and skips without:
// - Docker answering (`docker version`), as `packages/workspace/sandbox/test/docker.integration.test.ts`;
//   CI's Linux has it.
// - The sandbox image built on this machine (`miyoria sandbox build`), and
//   `MIYORIA_SANDBOX_IMAGE_TESTS=1`: the service refuses jobs while its image is missing.
// With both, the sandbox service and client (P2, P3) and hostd's `parseHostConfig` must load: a
// missing one fails the suite instead of skipping it, so CI cannot pass by running nothing.
//
// The service, the client and the parser are loaded by path at run time: `@miyoria/plugin-host`
// depends on neither `@miyoria/workspace` nor `@miyoria/hostd`, and this keeps their sources out
// of this package's typecheck.
//
// On failure it prints what each side saw: the module's state and every reason it failed with,
// where the launcher placed it, the refusals the client gave, the jobs and procs it opened (the
// proc's exit and its stdout and stderr as Core received them), the service's own view of them
// and the jobs' container logs.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  Config,
  type Endpoint,
  type EndpointSource,
  EventBus,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/runtime/kernel";
import {
  AuthorizerKey,
  BaseAuthorizer,
  Principals,
  type SandboxClient,
  type SandboxJob,
  type SandboxProc,
} from "@miyoria/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, ExtensionLauncherKey } from "../src/index.js";
import { type SandboxLauncher, sandboxLauncher } from "../src/sandbox-launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const SANDBOX = resolve(HERE, "../../../workspace/sandbox/src");
const HOSTD = resolve(HERE, "../../../hostd/src");
const EXT = "ext.test.fixture";
const TOKEN = "e2e-token";
/** How long the extension gets to be running: a job starts in seconds on CI. */
const RUNNING_WITHIN_MS = 30_000;
/** Kept of each stream of a proc for the failure message. */
const KEEP_CHARS = 8_000;

function dockerAvailable(): boolean {
  if (process.env.MIYORIA_SKIP_DOCKER_TESTS === "1") return false;
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 15_000,
    windowsHide: true,
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() !== "";
}

/** `docker ...`'s output, or what went wrong (diagnosis only). */
function docker(...args: string[]): string {
  const run = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  return run.status === 0 ? out : `(docker ${args[0]} failed: ${run.error?.message ?? out})`;
}

const loadErrors: string[] = [];

/** A module by its path; what failed is kept for the suite to report. */
async function load(path: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    loadErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

type Start = (options: Record<string, unknown>) => Promise<{
  url: string;
  close(): Promise<void>;
  refresh(): Promise<void>;
}>;

const wanted = process.env.MIYORIA_SANDBOX_IMAGE_TESTS === "1" && dockerAvailable();
const service = wanted ? await load(join(SANDBOX, "service/index.ts")) : null;
const remote = wanted ? await load(join(SANDBOX, "remote/client.ts")) : null;
const config = wanted ? await load(join(SANDBOX, "config.ts")) : null;
const jobsStore = wanted ? await load(join(SANDBOX, "remote/jobs-store.ts")) : null;
const hostConfig = wanted ? await load(join(HOSTD, "host-config.ts")) : null;

/** Core's registry with one computer: the service on loopback, called directly. */
function loopback(url: string, token: string): EndpointSource {
  const endpoint: Endpoint = {
    capability: "sandbox",
    host: "this-pc",
    service: "sandbox",
    url,
    via: "direct",
    headers: { authorization: `Bearer ${token}` },
    healthy: true,
    version: null,
  };
  return {
    pick: () => endpoint,
    candidates: () => [endpoint],
    failed: () => {},
    request: (e, path, init = {}) =>
      fetch(new URL(path, e.url), {
        ...init,
        headers: { ...e.headers, ...Object.fromEntries(new Headers(init.headers)) },
      }),
    watch: () => () => {},
  };
}

class AllowAll extends BaseAuthorizer {
  allowsSubject(): boolean {
    return true;
  }
}

interface ProcSeen {
  id: string;
  argv: string[];
  cwd: string | null;
  env: string[];
  exit: { code: number | null; signal: string | null } | null;
  stdout: string;
  stderr: string;
}

interface JobSeen {
  id: string;
  host: string;
  upload: unknown;
  procs: ProcSeen[];
}

/** What Core's side of the sandbox did, for the failure message. */
interface Seen {
  refusals: string[];
  jobs: JobSeen[];
}

function keepTail(text: string): string {
  return text.length > KEEP_CHARS ? `...${text.slice(-KEEP_CHARS)}` : text;
}

/** `proc` with its output also written down as it passes. */
function teed(proc: SandboxProc, seen: ProcSeen): SandboxProc {
  const copy = (from: Readable, name: "stdout" | "stderr"): Readable => {
    const to = new PassThrough();
    from.on("data", (chunk: Buffer) => {
      seen[name] = keepTail(seen[name] + chunk.toString("utf8"));
      to.write(chunk);
    });
    from.on("end", () => to.end());
    from.on("error", (error) => to.destroy(error));
    return to;
  };
  const stdout = copy(proc.stdout, "stdout");
  const stderr = copy(proc.stderr, "stderr");
  void proc.exited.then((exit) => {
    seen.exit = exit;
  });
  return {
    stdin: proc.stdin,
    stdout,
    stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

function recordedJob(job: SandboxJob, seen: JobSeen): SandboxJob {
  return {
    get id() {
      return job.id;
    },
    get host() {
      return job.host;
    },
    get kind() {
      return job.kind;
    },
    get ended() {
      return job.ended;
    },
    upload: async (target, source, options) => {
      try {
        const sent = await job.upload(target, source, options);
        seen.upload = sent;
        return sent;
      } catch (error) {
        seen.upload = `failed: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
    },
    exec: (start, options) => job.exec(start, options),
    proc: async (id, start) => {
      const proc: ProcSeen = {
        id,
        argv: start.argv,
        cwd: start.cwd ?? null,
        // Names only: values may be credentials in other suites that copy this.
        env: Object.keys(start.env ?? {}).sort(),
        exit: null,
        stdout: "",
        stderr: "",
      };
      seen.procs.push(proc);
      return teed(await job.proc(id, start), proc);
    },
    usage: () => job.usage(),
    close: () => job.close(),
  };
}

/** `client` writing down what it opened and refused. */
function recorded(client: SandboxClient, seen: Seen): SandboxClient {
  const machines = (client as { machines?: () => unknown }).machines;
  return Object.assign(
    {
      available: (forWho: Parameters<SandboxClient["available"]>[0]) => {
        const free = client.available(forWho);
        if (!free.ok) seen.refusals.push(`available: ${free.code} ${free.reason}`);
        return free;
      },
      open: async (...args: Parameters<SandboxClient["open"]>) => {
        try {
          const job = await client.open(...args);
          const entry: JobSeen = { id: job.id, host: job.host, upload: null, procs: [] };
          seen.jobs.push(entry);
          return recordedJob(job, entry);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          seen.refusals.push(
            `open: ${String(code ?? "?")} ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      },
      watch: (onChange: () => void) => client.watch(onChange),
    },
    // The launcher asks the cluster's client whether a computer offers the service at all.
    typeof machines === "function" ? { machines: () => machines.call(client) } : {},
  );
}

describe.skipIf(!wanted)("an extension in a sandbox on real Docker", () => {
  let root: string;
  let running: Awaited<ReturnType<Start>>;
  let client: SandboxClient & { close?: () => unknown };
  let launcher: SandboxLauncher;
  let sup: Supervisor;
  let actuators: ActuatorRegistry;
  const seen: Seen = { refusals: [], jobs: [] };
  /** Every reason the module failed with, in order (a restart clears it from `list()`). */
  const reasons: string[] = [];

  /** The service's answer to `GET path`, as text. */
  const ask = async (path: string): Promise<string> => {
    try {
      const res = await fetch(new URL(path, running.url), {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      return `${res.status} ${keepTail(await res.text())}`;
    } catch (error) {
      return `(no answer: ${error instanceof Error ? error.message : String(error)})`;
    }
  };

  const diagnosis = async (): Promise<string> => {
    const jobs = [];
    for (const job of seen.jobs) {
      const procs = [];
      for (const proc of job.procs) {
        const base = `/v1/jobs/${job.id}/procs/${proc.id}`;
        procs.push({
          ...proc,
          service: {
            view: await ask(base),
            stdout: await ask(`${base}/stdout?after=0`),
            stderr: await ask(`${base}/stdout?after=0&stream=stderr`),
          },
        });
      }
      const containers = docker(
        "ps",
        "-a",
        "--filter",
        `label=miyoria.sandbox.job=${job.id}`,
        "--format",
        "{{.Names}}\t{{.Status}}",
      );
      const logs: Record<string, string> = {};
      for (const line of containers.split("\n")) {
        const name = line.split("\t")[0]?.trim() ?? "";
        if (/^miyoria-sbx-[a-z0-9-]+$/u.test(name)) {
          logs[name] = keepTail(docker("logs", "--tail", "100", name));
        }
      }
      jobs.push({ ...job, procs, service: await ask(`/v1/jobs/${job.id}`), containers, logs });
    }
    const module = sup.list().find((m) => m.id === EXT);
    return JSON.stringify(
      {
        module: module ? { state: module.state, reason: module.reason } : null,
        reasons,
        placement: launcher.placement("test.fixture"),
        refusals: seen.refusals,
        info: await ask("/v1/info"),
        jobs,
      },
      null,
      2,
    );
  };

  /** Until `check` holds; on timeout the error carries the diagnosis. */
  const eventually = async (what: string, check: () => boolean, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const reason = sup.list().find((m) => m.id === EXT)?.reason ?? null;
      if (reason !== null && reasons.at(-1) !== reason) reasons.push(reason);
      if (check()) return;
      await sleep(100);
    }
    throw new Error(`${what} within ${ms} ms; what each side saw:\n${await diagnosis()}`);
  };

  beforeAll(async () => {
    const startService = service?.startSandboxService;
    const Client = remote?.HttpSandboxClient;
    const schema = config?.SandboxConfigSchema as { parse(v: unknown): unknown } | undefined;
    const parseHostConfig = hostConfig?.parseHostConfig;
    if (
      typeof startService !== "function" ||
      typeof Client !== "function" ||
      schema === undefined ||
      typeof parseHostConfig !== "function"
    ) {
      throw new Error(
        `the sandbox service, its client or hostd did not load: ${loadErrors.join("; ")}`,
      );
    }
    root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-ext-sbx-"));
    const hostToml = join(root, "host.toml");
    writeFileSync(hostToml, 'name = "this-pc"\n\n[sandbox]\nplugins = true\n');
    running = await (startService as Start)({
      host: "127.0.0.1",
      port: 0,
      hostToml,
      // Without hostd's parser the service keeps `[sandbox]`'s defaults, which take no plugin.
      parseHostConfig,
      state: join(root, "state"),
      imageDir: resolve(HERE, "../../../../workers/sandbox/image"),
      token: TOKEN,
      hostToken: null,
    });
    // Docker, the images and host.toml are looked at before the first job is asked for.
    await running.refresh();
    const Jobs = jobsStore?.MemorySandboxJobs as (new () => unknown) | undefined;
    client = new (Client as new (o: Record<string, unknown>) => SandboxClient)({
      endpoints: loopback(running.url, TOKEN),
      config: schema.parse({}),
      ...(Jobs ? { jobs: new Jobs() } : {}),
    });
    launcher = sandboxLauncher({
      client: recorded(client, seen),
      trustedHosts: [],
      coreHost: "this-pc",
      fallback: "fail",
    });

    // A handshake that never answers fails (and says why) inside the wait below.
    const app = Config.fromToml(
      `[modules.extensions]\ndirs = [${JSON.stringify(join(FIXTURES, "test-ext"))}]\ninit_timeout_ms = 20000\ncall_timeout_ms = 15000\n`,
    );
    const services = new ServiceRegistry();
    const tools = new ToolRegistry();
    sup = new Supervisor({ bus: new EventBus(), services });
    services.provide("app", ToolRegistryKey, tools);
    services.provide("app", AuthorizerKey, new AllowAll());
    services.provide("app", SupervisorKey, sup);
    actuators = new ActuatorRegistry({ services, tools, builtins: false });
    services.provide("app", ActuatorRegistryKey, actuators);
    services.provide("app", ExtensionLauncherKey, launcher);
    for (const m of discover(app, FIXTURES).modules) {
      await sup.register(m.module, m.config, m.enabled);
    }
  }, 120_000);

  afterAll(async () => {
    await sup?.stopAll();
    launcher?.close();
    await client?.close?.();
    // A job the extension's stop did not close is not left on the runner.
    for (const job of seen.jobs) {
      await fetch(new URL(`/v1/jobs/${job.id}`, running.url), {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      }).catch(() => undefined);
    }
    await running?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("registers its tools from the job and answers a call", async () => {
    await sup.startAll();
    await eventually(
      "the extension was not running",
      () => sup.list().find((m) => m.id === EXT)?.state === "running",
      RUNNING_WITHIN_MS,
    );
    expect(launcher.placement("test.fixture")).toMatchObject({ kind: "sandbox", host: "this-pc" });
    const out = await actuators.invoke({
      principal: Principals.self(null),
      capability: "ext.test.fixture.echo.say",
      args: { text: "from a job" },
      why: null,
      turn: null,
    });
    if (out.status !== "done") {
      throw new Error(`the call did not finish: ${JSON.stringify(out)}\n${await diagnosis()}`);
    }
    expect(out.result.text).toContain("echo: from a job from self");
    await sup.disable(EXT);
    expect(launcher.placement("test.fixture")).toBeNull();
  }, 90_000);
});
