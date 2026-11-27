// Extensions in sandbox jobs, against a fake `SandboxClient` whose procs are programs started on
// this machine from the folder that was "uploaded": the folder goes in, the program is started
// as a proc with the job's paths, the extension's JSON-RPC handshake and a tool call cross the
// proc's channel, a lost job restarts the module in a new one, credentials go only to trusted
// computers, and without a computer it runs here (or not at all, as the owner chose).

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  Config,
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
  type SandboxFor,
  type SandboxJob,
  type SandboxJobSpec,
  type SandboxProc,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { discover, ExtensionLauncherKey, type LaunchSpec } from "../src/index.js";
import {
  inExtDir,
  type SandboxLauncherOptions,
  sandboxArgv,
  sandboxEnv,
  sandboxLauncher,
  sandboxNetwork,
  sandboxPlan,
} from "../src/sandbox-launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const EXT_DIR = join(FIXTURES, "test-ext");
const EXT = "ext.test.fixture";
const ECHO_DIR = join(FIXTURES, "sandbox-echo");

type Available = ReturnType<SandboxClient["available"]>;

interface Machine {
  host: string;
  plugins: boolean;
}

/** What a real job needs from this machine to start node (never a variable of Core's). */
function platformEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

class FakeProc implements SandboxProc {
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly #child;
  #lost = false;

  constructor(
    readonly start: { argv: string[]; cwd?: string; env?: Record<string, string> },
    dir: string,
  ) {
    const [program, ...args] = start.argv.map((a) =>
      a.startsWith("/ext/") ? join(dir, a.slice("/ext/".length)) : a,
    );
    this.#child = spawn(program === "node" ? process.execPath : (program as string), args, {
      cwd: dir,
      env: { ...platformEnv(), ...(start.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.on("error", () => undefined);
    this.stdin = this.#child.stdin;
    this.stdout = this.#child.stdout;
    this.stderr = this.#child.stderr;
    this.exited = new Promise((resolve) => {
      this.#child.once("exit", (code, signal) =>
        resolve(this.#lost ? { code: null, signal: "lost" } : { code, signal }),
      );
    });
  }

  async kill(): Promise<void> {
    this.#child.kill();
  }

  lose(): void {
    this.#lost = true;
    this.#child.kill();
  }
}

class FakeJob implements SandboxJob {
  readonly kind = "plugin" as const;
  readonly ended: Promise<{ reason: string }>;
  readonly uploads: { target: string; dir: string }[] = [];
  readonly procs: FakeProc[] = [];
  closed = false;
  #end: (r: { reason: string }) => void = () => {};
  #dir: string | null = null;

  constructor(
    readonly id: string,
    readonly host: string,
    readonly spec: SandboxJobSpec,
    readonly skipped: { path: string; why: string }[] = [],
  ) {
    this.ended = new Promise((resolve) => {
      this.#end = resolve;
    });
  }

  async upload(target: "workspace" | "tools" | "ext" | "work", source: { dir: string }) {
    this.uploads.push({ target, dir: source.dir });
    if (target === "ext") this.#dir = source.dir;
    return { files: 2, bytes: 100, skipped: this.skipped };
  }

  exec(): never {
    throw new Error("a plugin job runs no execs");
  }

  async proc(
    id: string,
    start: { argv: string[]; cwd?: "/work" | "/workspace" | "/ext"; env?: Record<string, string> },
  ) {
    if (this.closed) throw new Error("the job has ended");
    if (!/^[0-9a-z]{26}$/u.test(id)) throw new Error(`bad proc id ${id}`);
    if (this.#dir === null) throw new Error("nothing uploaded");
    const proc = new FakeProc(start, this.#dir);
    this.procs.push(proc);
    return proc;
  }

  async usage() {
    return { cpu_ms: 0, wall_ms: 0, disk_bytes: 0 };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.procs) await p.kill();
    this.#end({ reason: "closed" });
  }

  /** The computer went away: its programs are gone, the job with them. */
  lose(): void {
    this.closed = true;
    for (const p of this.procs) p.lose();
    this.#end({ reason: "lost" });
  }
}

class FakeClient implements SandboxClient {
  computers: Machine[];
  /** Hosts that offer the service but are not ready (their service still checking Docker). */
  starting: string[] = [];
  readonly jobs: FakeJob[] = [];
  readonly listeners = new Set<() => void>();
  skipped: { path: string; why: string }[] = [];
  refuse: Available | null = null;
  #n = 0;

  constructor(machines: Machine[] = [{ host: "friend-pc", plugins: true }]) {
    this.computers = machines;
  }

  available(forWho: SandboxFor): Available {
    if (this.refuse !== null) return this.refuse;
    if (this.computers.length === 0)
      return { ok: false, code: "no_machine", reason: "現在沒有能跑程式的電腦。" };
    if (forWho === "plugin" && !this.computers.some((m) => m.plugins))
      return { ok: false, code: "not_accepting", reason: "不接插件的工作" };
    return { ok: true };
  }

  async open(spec: SandboxJobSpec): Promise<SandboxJob> {
    const machine = this.computers.find(
      (m) => m.plugins && (spec.hosts === undefined || spec.hosts.includes(m.host)),
    );
    if (machine === undefined) {
      throw Object.assign(new Error("現在沒有能跑程式的電腦。"), { code: "no_machine" });
    }
    this.#n += 1;
    const job = new FakeJob(`job${this.#n}`, machine.host, spec, this.skipped);
    this.jobs.push(job);
    return job;
  }

  /** Every computer that offers the service, as the cluster's client lists them. */
  machines(): { host: string; ready: boolean }[] {
    return [
      ...this.computers.map((m) => ({ host: m.host, ready: true })),
      ...this.starting.map((host) => ({ host, ready: false })),
    ];
  }

  watch(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  change(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** A program that echoes its stdin (`fixtures/sandbox-echo`). */
function echoSpec(extra: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    extension: "made.up",
    dir: ECHO_DIR,
    runtime: "binary",
    program: process.execPath,
    args: [join(ECHO_DIR, "echo.mjs")],
    cwd: ECHO_DIR,
    env: { MIYORIA_RPC: "stdio", MIYORIA_EXTENSION_ID: "made.up" },
    network: [],
    secrets: {},
    runIn: "sandbox",
    ...extra,
  };
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("condition not met in time");
}

const launchers: { close(): void }[] = [];
const ended: FakeJob[][] = [];
afterEach(async () => {
  for (const l of launchers.splice(0)) l.close();
  for (const jobs of ended.splice(0)) for (const j of jobs) await j.close();
});

function launcher(client: FakeClient | null, o: Partial<SandboxLauncherOptions> = {}) {
  const l = sandboxLauncher({ client, trustedHosts: [], bootWaitMs: 0, ...o });
  launchers.push(l);
  if (client) ended.push(client.jobs);
  return l;
}

describe("what goes into a job", () => {
  it("maps the extension's folder to /ext and the runtime to the image's", () => {
    expect(inExtDir(EXT_DIR, join(EXT_DIR, "dist", "index.js"))).toBe("/ext/dist/index.js");
    expect(inExtDir(EXT_DIR, EXT_DIR)).toBe("/ext");
    expect(inExtDir(EXT_DIR, HERE)).toBeNull();
    expect(inExtDir(EXT_DIR, "index.js")).toBeNull();
    const node = echoSpec({ runtime: "node", program: "C:/tools/node.exe" });
    expect(sandboxArgv(node)).toEqual(["node", "/ext/echo.mjs"]);
    expect(sandboxArgv(echoSpec())).toEqual(["node", "/ext/echo.mjs"]);
    expect(sandboxArgv(echoSpec({ program: "npx.cmd", args: ["-y", "made-up-server"] }))).toEqual([
      "npx",
      "-y",
      "made-up-server",
    ]);
    expect(sandboxArgv(echoSpec({ program: join(ECHO_DIR, "bin", "srv") }))).toEqual([
      "/ext/bin/srv",
      "/ext/echo.mjs",
    ]);
    expect(sandboxArgv(echoSpec({ program: "C:\\Games\\tool.exe" }))).toMatch(/this machine/u);
    expect(sandboxArgv(echoSpec({ runtime: "deno" }))).toMatch(/no deno/u);
  });

  it("leaves out what describes Core's machine and what the job sets itself", () => {
    const { env, dropped } = sandboxEnv(
      {
        PATH: "/core/bin",
        Path: "C:\\core",
        HOME: "/home/core",
        TEMP: "C:\\temp",
        USERNAME: "owner",
        TZ: "Asia/Taipei",
        MIYORIA_RPC: "stdio",
        MIYORIA_EXTENSION_ID: "made.up",
        MADE_URL: "https://made.example",
        lower_case: "x",
        HTTP_PROXY: "http://core-proxy",
      },
      { MADE_TOKEN: "t" },
    );
    expect(env).toEqual({
      TZ: "Asia/Taipei",
      MIYORIA_RPC: "stdio",
      MIYORIA_EXTENSION_ID: "made.up",
      MADE_URL: "https://made.example",
      MADE_TOKEN: "t",
    });
    expect(dropped.map((d) => d.name).sort()).toEqual(["HTTP_PROXY", "lower_case"]);
  });

  it("keeps the protocol and the secrets when there are more variables than a job takes", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`MADE_V${i}`, "v"]));
    const { env, dropped } = sandboxEnv(
      { ...many, MIYORIA_RPC: "stdio", MIYORIA_EXTENSION_ID: "made.up" },
      { MADE_TOKEN: "t" },
    );
    expect(Object.keys(env)).toHaveLength(32);
    expect(env).toMatchObject({
      MIYORIA_RPC: "stdio",
      MIYORIA_EXTENSION_ID: "made.up",
      MADE_TOKEN: "t",
    });
    expect(dropped).toHaveLength(11);
  });

  it("the hosts it declared, or the open network when it declared none", () => {
    expect(sandboxNetwork([])).toEqual({ network: { mode: "open" }, dropped: [] });
    expect(
      sandboxNetwork(["API.made.example:443", "https://cdn.made.example/x", "localhost"]),
    ).toEqual({
      network: { mode: "allowlist", allow: ["api.made.example", "cdn.made.example"] },
      dropped: ["localhost"],
    });
    expect(sandboxNetwork(["localhost:8080"]).network).toEqual({ mode: "none" });
  });

  it("credentials go only to Core's own computer and the trusted ones", () => {
    const plain = sandboxPlan(echoSpec(), { trustedHosts: ["trusted-pc"] });
    expect(plain).toMatchObject({ ok: true, credentials: [] });
    expect(plain.ok && plain.hosts).toBeUndefined();
    const secret = echoSpec({ secrets: { MADE_KEY: "k" } });
    expect(
      sandboxPlan(secret, { trustedHosts: ["trusted-pc"], coreHost: "core-pc" }),
    ).toMatchObject({
      ok: true,
      credentials: ["MADE_KEY"],
      hosts: ["core-pc", "trusted-pc"],
    });
    // Core's own computer as the registry knows it at the launch.
    let local: string[] = [];
    const fromRegistry = { trustedHosts: [], coreHost: () => local };
    expect(sandboxPlan(secret, fromRegistry)).toMatchObject({ ok: false });
    local = ["core-pc"];
    expect(sandboxPlan(secret, fromRegistry)).toMatchObject({ ok: true, hosts: ["core-pc"] });
    // A token the owner passed by its exact name is a credential too.
    const passed = echoSpec({ env: { ...echoSpec().env, MADE_TOKEN: "t" } });
    expect(sandboxPlan(passed, { trustedHosts: [] })).toMatchObject({ ok: false });
  });
});

describe("the sandbox launcher", { timeout: 30_000 }, () => {
  it("sends the folder in, starts the program as a proc and carries its pipes", async () => {
    const client = new FakeClient();
    const l = launcher(client);
    const child = await l.launch(echoSpec(), new AbortController().signal);
    const [job] = client.jobs;
    expect(job?.spec).toMatchObject({
      kind: "plugin",
      image: "default",
      for: "plugin",
      payer: null,
      label: "made.up",
      lifetime_s: 0,
      network: { mode: "open" },
    });
    expect(job?.spec.hosts).toBeUndefined();
    expect(job?.uploads).toEqual([{ target: "ext", dir: ECHO_DIR }]);
    expect(job?.procs[0]?.start).toMatchObject({ argv: ["node", "/ext/echo.mjs"], cwd: "/ext" });
    expect(child.where).toEqual({ kind: "sandbox", host: "friend-pc", job: "job1" });
    expect(l.placement("made.up")).toEqual({ kind: "sandbox", host: "friend-pc", job: "job1" });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stdin.write("ping\n");
    await eventually(() => out.includes("ping"));
    child.kill();
    await child.exited;
    // The job ends with its program.
    await eventually(() => job?.closed === true);
    expect(l.placement("made.up")).toBeNull();
  });

  it("a run_in = host extension never asks for a computer", async () => {
    const client = new FakeClient();
    const l = launcher(client);
    const child = await l.launch(echoSpec({ runIn: "host" }), new AbortController().signal);
    expect(child.where).toEqual({ kind: "host" });
    expect(client.jobs).toHaveLength(0);
    child.kill();
    await child.exited;
  });

  it("credentials: only to the trusted computer; with none trusted it runs here", async () => {
    const client = new FakeClient([
      { host: "friend-pc", plugins: true },
      { host: "trusted-pc", plugins: true },
    ]);
    const l = launcher(client, { trustedHosts: ["trusted-pc"] });
    const spec = echoSpec({ secrets: { MADE_KEY: "k" } });
    const child = await l.launch(spec, new AbortController().signal);
    expect(child.where).toMatchObject({ kind: "sandbox", host: "trusted-pc" });
    expect(client.jobs[0]?.spec.hosts).toEqual(["trusted-pc"]);
    expect(client.jobs[0]?.procs[0]?.start.env).toMatchObject({ MADE_KEY: "k" });
    child.kill();
    await child.exited;

    const strict = launcher(client, { trustedHosts: [] });
    const here = await strict.launch(spec, new AbortController().signal);
    expect(here.where).toEqual({ kind: "host" });
    expect(strict.placement("made.up")).toMatchObject({ kind: "host", reason: /credentials/u });
    expect(client.jobs).toHaveLength(1);
    here.kill();
    await here.exited;
  });

  it("no computer: here with a warning, or a failed start when the owner said so", async () => {
    const client = new FakeClient([{ host: "friend-pc", plugins: false }]);
    const here = await launcher(client).launch(echoSpec(), new AbortController().signal);
    expect(here.where).toEqual({ kind: "host" });
    here.kill();
    await here.exited;
    await expect(
      launcher(client, { fallback: "fail" }).launch(echoSpec(), new AbortController().signal),
    ).rejects.toThrow(/should run in a sandbox, but 不接插件/u);
    const none = await launcher(null).launch(echoSpec(), new AbortController().signal);
    expect(none.where).toEqual({ kind: "host" });
    none.kill();
    await none.exited;
  });

  it("a folder that does not go in whole runs here, and its job is closed", async () => {
    const client = new FakeClient();
    client.skipped = [{ path: "node_modules/@made/sdk", why: "link" }];
    const l = launcher(client);
    const child = await l.launch(echoSpec(), new AbortController().signal);
    expect(child.where).toEqual({ kind: "host" });
    expect(l.placement("made.up")).toMatchObject({ reason: /node_modules\/@made\/sdk \(link\)/u });
    expect(client.jobs[0]?.closed).toBe(true);
    child.kill();
    await child.exited;
  });

  it("with no computer offering the service, starts here at once and moves when one comes", async () => {
    // The first deployment: the default boot wait (10 s), and nothing in the cluster.
    const client = new FakeClient([]);
    const restarted: string[] = [];
    const l = launcher(client, {
      bootWaitMs: 10_000,
      restart: (ext) => void restarted.push(ext),
    });
    const started = Date.now();
    const here = await l.launch(echoSpec(), new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(here.where).toEqual({ kind: "host" });
    client.computers = [{ host: "friend-pc", plugins: true }];
    client.change();
    await eventually(() => restarted.length > 0);
    expect(restarted).toEqual(["made.up"]);
    here.kill();
    await here.exited;
  });

  it("waits at boot for a computer that offers the service but is not ready, and moves a fallen-back extension when one takes plugins", async () => {
    const client = new FakeClient([]);
    client.starting = ["friend-pc"];
    const early = launcher(client, { bootWaitMs: 5000 });
    const pending = early.launch(echoSpec(), new AbortController().signal);
    await sleep(50);
    client.starting = [];
    client.computers = [{ host: "friend-pc", plugins: true }];
    client.change();
    const child = await pending;
    expect(child.where).toMatchObject({ kind: "sandbox", host: "friend-pc" });
    child.kill();
    await child.exited;

    const busy = new FakeClient();
    busy.refuse = { ok: false, code: "busy", reason: "滿了" };
    const restarted: string[] = [];
    const l = launcher(busy, { restart: (ext) => void restarted.push(ext) });
    const here = await l.launch(echoSpec(), new AbortController().signal);
    expect(here.where).toEqual({ kind: "host" });
    busy.change();
    expect(restarted).toEqual([]);
    busy.refuse = null;
    busy.change();
    busy.change();
    await eventually(() => restarted.length > 0);
    expect(restarted).toEqual(["made.up"]);
    here.kill();
    await here.exited;
  });

  it("waits at boot for the sandbox module to provide its client", async () => {
    const client = new FakeClient();
    ended.push(client.jobs);
    let given: FakeClient | null = null;
    const l = launcher(null, { client: () => given, bootWaitMs: 5000 });
    const pending = l.launch(echoSpec(), new AbortController().signal);
    await sleep(50);
    given = client;
    const child = await pending;
    expect(child.where).toMatchObject({ kind: "sandbox", host: "friend-pc" });
    child.kill();
    await child.exited;
  });

  it("a bundled server runs in the extension's job, waits for it, and ends with it", async () => {
    const client = new FakeClient();
    const l = launcher(client);
    const server = echoSpec({
      runtime: "binary",
      program: process.execPath,
      args: [join(ECHO_DIR, "echo.mjs")],
      env: {},
    });
    const stop = new AbortController();
    const early = l.launchInSame("made.up", server, stop.signal);
    await sleep(50);
    const main = await l.launch(echoSpec(), new AbortController().signal);
    const bundled = await early;
    expect(bundled.where).toEqual(main.where);
    const job = client.jobs[0];
    expect(job?.procs).toHaveLength(2);
    expect(job?.procs[1]?.start).toMatchObject({ argv: ["node", "/ext/echo.mjs"], cwd: "/ext" });
    main.kill();
    await bundled.exited;
    expect(job?.closed).toBe(true);

    // Waiting for an extension that is not running gives up with its signal.
    const gone = new AbortController();
    const waiting = l.launchInSame("made.up", server, gone.signal);
    gone.abort();
    await expect(waiting).rejects.toThrow(/aborted/u);
  });
});

class AllowAll extends BaseAuthorizer {
  allowsSubject(): boolean {
    return true;
  }
}

describe("an extension module in a sandbox", { timeout: 40_000 }, () => {
  const sups: Supervisor[] = [];
  afterEach(async () => {
    for (const sup of sups.splice(0)) await sup.stopAll();
  });

  async function harness(client: FakeClient) {
    const config = Config.fromToml(
      `[modules.extensions]\ndirs = [${JSON.stringify(EXT_DIR)}]\ninit_timeout_ms = 5000\ncall_timeout_ms = 3000\nshutdown_grace_ms = 300\n`,
    );
    const services = new ServiceRegistry();
    const tools = new ToolRegistry();
    const sup = new Supervisor({ bus: new EventBus(), services });
    sups.push(sup);
    services.provide("app", ToolRegistryKey, tools);
    services.provide("app", AuthorizerKey, new AllowAll());
    services.provide("app", SupervisorKey, sup);
    const actuators = new ActuatorRegistry({ services, tools, builtins: false });
    services.provide("app", ActuatorRegistryKey, actuators);
    services.provide("app", ExtensionLauncherKey, launcher(client));
    for (const m of discover(config, FIXTURES).modules) {
      await sup.register(m.module, m.config, m.enabled);
    }
    await sup.startAll();
    await eventually(() => sup.list().find((m) => m.id === EXT)?.state === "running");
    return { sup, actuators };
  }

  it("speaks its protocol over the proc and answers a tool call", async () => {
    const client = new FakeClient();
    const h = await harness(client);
    const job = client.jobs[0];
    expect(job?.uploads).toEqual([{ target: "ext", dir: EXT_DIR }]);
    expect(job?.procs[0]?.start.argv).toEqual(["node", "/ext/index.mjs"]);
    const env = job?.procs[0]?.start.env ?? {};
    expect(env).toMatchObject({ MIYORIA_RPC: "stdio", MIYORIA_EXTENSION_ID: "test.fixture" });
    expect(Object.keys(env).some((k) => k.toUpperCase() === "PATH")).toBe(false);
    const out = await h.actuators.invoke({
      principal: Principals.self(null),
      capability: "ext.test.fixture.echo.say",
      args: { text: "hi" },
      why: null,
      turn: null,
    });
    expect(out.status === "done" && out.result.text).toContain("echo: hi from self");
    await h.sup.disable(EXT);
    await eventually(() => job?.closed === true);
  });

  it("a lost job ends the program; the module restarts in a new job", async () => {
    const client = new FakeClient();
    const h = await harness(client);
    client.jobs[0]?.lose();
    await eventually(() => client.jobs.length === 2, 15_000);
    await eventually(() => h.sup.list().find((m) => m.id === EXT)?.state === "running", 15_000);
    expect(client.jobs[1]?.closed).toBe(false);
  });
});
