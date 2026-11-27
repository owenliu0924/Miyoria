// Extensions in a sandbox job (docs/design/v6-agent-split.md §2 P8 and §3.8, v6-sandbox.md §2.1,
// §3.7 and §16 item 3). An extension that should run in a sandbox gets a `plugin` job on a
// computer of the cluster whose owner takes plugins: its folder goes to `/ext` (read-only), its
// program runs there as a long-lived proc, and the proc's byte channel carries its JSON-RPC, so
// the host's side does not know it is on another computer. The MCP servers it bundles run as
// more procs in the same job and end with it.
//
// Where a program may not go, and why:
// - Credentials (the owner's `secrets`, and any variable of its environment whose name says it
//   holds one) go only to Core's own computer or `trusted_hosts`: a computer that merely takes
//   plugins or members' work belongs to someone else, who can read a job's environment.
// - Nothing that describes Core's computer goes in (its PATH, HOME, TEMP, user name...): the job
//   has its own, and they only say how Core's machine is laid out.
// - A game adapter and anything granted `input` stay here by default (`defaultRunIn`): they work
//   on this machine's game and keyboard.
// When no computer takes the job, the extension runs here (`fallback = "host"`, the default) or
// does not start (`"fail"`), and the log says why.

import { isAbsolute, relative, sep } from "node:path";
import { errorMessage, getLogger, sleep } from "@miyoria/runtime/kernel";
import {
  newId,
  type SandboxClient,
  type SandboxJob,
  type SandboxJobSpec,
  type SandboxProc,
} from "@miyoria/types";
import { BASE_ENV, looksLikeSecret } from "./env.js";
import {
  type ChildLike,
  type ExtensionLauncher,
  LaunchError,
  type LaunchSpec,
  localLauncher,
} from "./launch.js";

const log = getLogger("ext_host.sandbox");

export interface SandboxLauncherOptions {
  /**
   * The cluster's sandbox computers (`SandboxClientKey`). A function when the client is provided
   * later than the launcher, or comes and goes with the sandbox module; `null` / `undefined`
   * from it: there is none now, everything runs here.
   */
  client: SandboxClient | (() => SandboxClient | null | undefined) | null;
  /** `[modules.sandbox.transfer] trusted_hosts`: computers an extension's credentials may go to. */
  trustedHosts: readonly string[];
  /**
   * Core's own computer in the cluster: credentials may always go there. A function is read at
   * each launch (the app reads the registry: hosts connect after Core starts); it may name
   * several (a hostd and a static entry on the same machine).
   */
  coreHost?: CoreHost;
  /** No computer takes it: run here (default) or let the extension fail to start. */
  fallback?: "host" | "fail";
  /** Where `host` programs run; default `localLauncher()`. */
  local?: ExtensionLauncher;
  /**
   * Restarts the module of an extension that fell back to this machine once a computer takes
   * plugins again (the app passes the supervisor's restart of `ext.<id>`). Without it such an
   * extension stays here until it restarts for another reason.
   */
  restart?: (extension: string) => void | Promise<void>;
  /**
   * Within this long after the launcher was made, a launch that finds no computer at all waits
   * for one until the end of that time: at boot the cluster's computers connect a little after
   * Core starts its extensions. Default 10 s; 0 never waits.
   */
  bootWaitMs?: number;
  /** Fewest milliseconds between two `restart`s of one extension (default 60 s). */
  restartEveryMs?: number;
  /** Proc ids (tests); default `newId()` in lower case, the form the service takes. */
  procId?: () => string;
  now?: () => number;
}

/** Core's own computer: a name, or what the registry says now. */
export type CoreHost = string | null | (() => string | readonly string[] | null);

function coreHosts(given: CoreHost | undefined): string[] {
  const value = typeof given === "function" ? given() : given;
  if (value === null || value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

/** Where an extension's main program runs now. */
export type Placement =
  | { kind: "host"; reason: string | null }
  | { kind: "sandbox"; host: string; job: string };

export interface SandboxLauncher extends ExtensionLauncher {
  launchInSame(extension: string, spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike>;
  /** Where `extension` runs now; `null` while it is not running. */
  placement(extension: string): Placement | null;
  /** Stops watching the computers; running programs are left alone. */
  close(): void;
}

/** What an extension's program becomes in a job, or why it cannot go into one. */
export type SandboxPlan =
  | {
      ok: true;
      argv: string[];
      env: Record<string, string>;
      /** Variables left out (names only), and why. */
      dropped: { name: string; why: string }[];
      network: NonNullable<SandboxJobSpec["network"]>;
      /** Variables that hold credentials, by name. */
      credentials: string[];
      /** The computers it may go to; `undefined`: any that takes plugins. */
      hosts?: string[];
    }
  | { ok: false; why: string };

/** Commands the sandbox image has on its PATH (workers/sandbox/image/Dockerfile). */
const IMAGE_COMMANDS: ReadonlySet<string> = new Set([
  "node",
  "npm",
  "npx",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "uvx",
  "bash",
  "sh",
]);

/** Of `BASE_ENV`, what still means something in a job. */
const KEEP_BASE: ReadonlySet<string> = new Set(["TZ", "NO_COLOR", "FORCE_COLOR"]);
const HOST_ONLY: ReadonlySet<string> = new Set(
  BASE_ENV.map((n) => n.toUpperCase()).filter((n) => !KEEP_BASE.has(n)),
);

/** Set by the job itself; the service refuses a request that sets them (service/validate.ts). */
const RESERVED_ENV: ReadonlySet<string> = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "PIP_USER",
  "NPM_CONFIG_PREFIX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_ENV = 32;
const MAX_ENV_VALUE = 4096;
/** Never dropped for room: without them it is not an extension. */
const PROTOCOL_ENV: readonly string[] = ["MIYORIA_RPC", "MIYORIA_EXTENSION_ID"];

/** A host name the egress proxy's allowlist takes (`ALLOWED_HOST` of the sandbox config). */
const ALLOWED_HOST =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const MAX_ALLOW = 32;

/** How often a launch at boot looks for the client again. */
const CLIENT_POLL_MS = 200;

/** Not sent with the folder: history, not the extension. */
const SKIP_UPLOAD = (path: string) => path === ".git" || path.startsWith(".git/");

/** `path` as seen inside the job when it is in the extension's folder `dir`, else `null`. */
export function inExtDir(dir: string, path: string): string | null {
  if (!isAbsolute(path)) return null;
  const rel = relative(dir, path);
  if (rel === "") return "/ext";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return `/ext/${rel.split(sep).join("/")}`;
}

/** The program `program` names inside the job, or `null` when the image cannot have it. */
function jobCommand(dir: string, program: string): string | null {
  const mapped = inExtDir(dir, program);
  if (mapped !== null) return mapped;
  const base = (program.split(/[\\/]/u).pop() ?? program)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/u, "");
  if (IMAGE_COMMANDS.has(base)) return base;
  // A path on this Windows machine outside the extension: not in a Linux job.
  if (/^[A-Za-z]:|\\/u.test(program)) return null;
  return program;
}

/** argv inside the job, or why there is none. */
export function sandboxArgv(spec: LaunchSpec): string[] | string {
  const args = spec.args.map((a) => inExtDir(spec.dir, a) ?? a);
  switch (spec.runtime) {
    case "node":
      // Whatever node this machine uses (`[modules.extensions.runtimes]`), the job has its own.
      return ["node", ...args];
    case "deno":
    case "bun":
      return `the sandbox image has no ${spec.runtime}`;
    case "binary": {
      const program = jobCommand(spec.dir, spec.program);
      if (program === null) return `\`${spec.program}\` is a program of this machine`;
      return [program, ...args];
    }
  }
}

/** The job's network: the hosts it declared (and was granted), or open when it declared none. */
export function sandboxNetwork(granted: readonly string[]): {
  network: NonNullable<SandboxJobSpec["network"]>;
  dropped: string[];
} {
  if (granted.length === 0 || granted.includes("*"))
    return { network: { mode: "open" }, dropped: [] };
  const allow: string[] = [];
  const dropped: string[] = [];
  for (const entry of granted) {
    // `host:port` (deno's --allow-net form): the proxy decides ports, the host is what counts.
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//u, "")
      .replace(/\/.*$/u, "")
      .replace(/:\d+$/u, "");
    if (ALLOWED_HOST.test(host) && allow.length < MAX_ALLOW) {
      if (!allow.includes(host)) allow.push(host);
    } else dropped.push(entry);
  }
  // Every declared host unusable: it asked for a short list, not for everything.
  return { network: allow.length === 0 ? { mode: "none" } : { mode: "allowlist", allow }, dropped };
}

/**
 * The proc's environment: what the extension would get here minus what only describes this
 * machine, plus the granted secrets; within the service's bounds.
 */
export function sandboxEnv(
  env: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
): { env: Record<string, string>; dropped: { name: string; why: string }[] } {
  const dropped: { name: string; why: string }[] = [];
  const candidates: [string, string][] = [];
  for (const [name, value] of Object.entries({ ...env, ...secrets })) {
    const upper = name.toUpperCase();
    if (HOST_ONLY.has(upper)) continue;
    if (RESERVED_ENV.has(upper)) dropped.push({ name, why: "set by the sandbox" });
    else if (!ENV_NAME.test(name)) dropped.push({ name, why: "not a name the sandbox takes" });
    else if (value.length > MAX_ENV_VALUE || value.includes("\0"))
      dropped.push({ name, why: "value too long" });
    else candidates.push([name, value]);
  }
  const out: Record<string, string> = {};
  // The protocol variables first, then the owner's secrets, then the rest: what is cut for room
  // is what matters least.
  const rank = (name: string) =>
    PROTOCOL_ENV.includes(name) ? 0 : Object.hasOwn(secrets, name) ? 1 : 2;
  candidates.sort((a, b) => rank(a[0]) - rank(b[0]));
  for (const [name, value] of candidates) {
    if (Object.keys(out).length >= MAX_ENV) {
      dropped.push({ name, why: `more than ${MAX_ENV} variables` });
      continue;
    }
    out[name] = value;
  }
  return { env: out, dropped };
}

/** Where `spec` may run in a job and as what (pure: the launcher and the tests use it). */
export function sandboxPlan(
  spec: LaunchSpec,
  o: { trustedHosts: readonly string[]; coreHost?: CoreHost },
): SandboxPlan {
  const argv = sandboxArgv(spec);
  if (typeof argv === "string") return { ok: false, why: argv };
  const { env, dropped } = sandboxEnv(spec.env, spec.secrets);
  const credentials = [
    ...new Set([
      ...Object.keys(spec.secrets).filter((n) => Object.hasOwn(env, n)),
      ...Object.keys(env).filter(looksLikeSecret),
    ]),
  ].sort();
  const { network, dropped: hosts } = sandboxNetwork(spec.network);
  for (const host of hosts) dropped.push({ name: host, why: "not a host name the proxy allows" });
  if (credentials.length === 0) return { ok: true, argv, env, dropped, network, credentials };
  const allowed = [
    ...new Set([...coreHosts(o.coreHost), ...o.trustedHosts].filter((h) => h !== "")),
  ];
  if (allowed.length === 0) {
    return {
      ok: false,
      why: `it holds credentials (${credentials.join(", ")}), which go only to Core's own computer or [modules.sandbox.transfer] trusted_hosts, and none is set`,
    };
  }
  return { ok: true, argv, env, dropped, network, credentials, hosts: allowed };
}

/** `proc` as the host's child; `onGone` once it has ended (also when its job did). */
function procChild(proc: SandboxProc, job: SandboxJob, onGone: () => void): ChildLike {
  const exited = Promise.race([
    proc.exited,
    job.ended.then(() => ({ code: null, signal: "lost" })),
  ]);
  void exited.then(onGone);
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited,
    kill: () => {
      void proc.kill().catch(() => undefined);
    },
    where: { kind: "sandbox", host: job.host, job: job.id },
  };
}

/** A `SandboxClientError`'s code, without depending on the package that defines it. */
function refusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

interface Running {
  child: ChildLike;
  placement: Placement;
  job: SandboxJob | null;
  /** It is here only because no computer took it then: move it when one does. */
  retry: boolean;
}

/**
 * The launcher that puts `run_in = "sandbox"` extensions into sandbox jobs (and runs `host` ones
 * here). The app provides it as `ExtensionLauncherKey` once the sandbox module provides its
 * client (docs/design/v6-agent-split.md §4, `modules.ts`).
 */
export function sandboxLauncher(o: SandboxLauncherOptions): SandboxLauncher {
  return new SandboxLauncherImpl(o);
}

class SandboxLauncherImpl implements SandboxLauncher {
  readonly #o: SandboxLauncherOptions;
  readonly #local: ExtensionLauncher;
  readonly #now: () => number;
  readonly #bootUntil: number;
  readonly #procId: () => string;
  readonly #running = new Map<string, Running>();
  readonly #listeners = new Set<() => void>();
  readonly #restarted = new Map<string, number>();
  #watched: { client: SandboxClient; off: () => void } | null = null;

  constructor(o: SandboxLauncherOptions) {
    this.#o = o;
    this.#local = o.local ?? localLauncher();
    this.#now = o.now ?? Date.now;
    this.#bootUntil = this.#now() + (o.bootWaitMs ?? 10_000);
    this.#procId = o.procId ?? (() => newId().toLowerCase());
  }

  placement(extension: string): Placement | null {
    return this.#running.get(extension)?.placement ?? null;
  }

  close(): void {
    this.#watched?.off();
    this.#watched = null;
  }

  #client(): SandboxClient | null {
    const given = this.#o.client;
    const client = typeof given === "function" ? (given() ?? null) : given;
    if (client !== this.#watched?.client) {
      this.#watched?.off();
      this.#watched =
        client === null ? null : { client, off: client.watch(() => this.#machinesChanged(client)) };
    }
    return client;
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #place(extension: string, running: Running): void {
    this.#running.set(extension, running);
    this.#changed();
    void running.child.exited.then(() => {
      if (this.#running.get(extension) === running) {
        this.#running.delete(extension);
        this.#changed();
      }
    });
  }

  /** A computer may take plugins now: extensions here only for want of one go back. */
  #machinesChanged(client: SandboxClient): void {
    const restart = this.#o.restart;
    if (restart === undefined || !client.available("plugin").ok) return;
    const every = this.#o.restartEveryMs ?? 60_000;
    for (const [extension, running] of this.#running) {
      if (running.placement.kind !== "host" || !running.retry) continue;
      const last = this.#restarted.get(extension);
      if (last !== undefined && this.#now() - last < every) continue;
      this.#restarted.set(extension, this.#now());
      running.retry = false;
      log.info({ ext: extension }, "a computer takes plugins again; moving the extension there");
      void Promise.resolve()
        .then(() => restart(extension))
        .catch((error: unknown) =>
          log.warn({ ext: extension, err: errorMessage(error) }, "restarting the extension failed"),
        );
    }
  }

  async launch(spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike> {
    if (signal.aborted) throw new LaunchError(`starting \`${spec.extension}\`: aborted`);
    if (spec.runIn === "host") {
      const child = await this.#local.launch(spec, signal);
      this.#place(spec.extension, {
        child,
        placement: { kind: "host", reason: null },
        job: null,
        retry: false,
      });
      return child;
    }
    const client = await this.#clientSoon(signal);
    // No sandbox in the cluster at all is how most installs run, not a fallback worth a warning.
    if (client === null) return this.#here(spec, signal, "there is no sandbox", false, true);
    const plan = sandboxPlan(spec, this.#o);
    if (!plan.ok) return this.#here(spec, signal, plan.why, false);
    const free = await this.#available(client, signal);
    if (!free.ok) return this.#here(spec, signal, free.reason, true);

    let job: SandboxJob;
    try {
      job = await client.open(
        {
          kind: "plugin",
          image: "default",
          for: "plugin",
          payer: null,
          label: spec.extension,
          network: plan.network,
          // Lives as long as the extension: the module's stop closes it.
          lifetime_s: 0,
          mounts: { ext: true },
          ...(plan.hosts === undefined ? {} : { hosts: plan.hosts }),
        },
        { signal },
      );
    } catch (error) {
      if (signal.aborted) throw new LaunchError(`starting \`${spec.extension}\`: aborted`);
      const code = refusalCode(error);
      return this.#here(spec, signal, errorMessage(error), code !== "unavailable");
    }

    try {
      const sent = await job.upload(
        "ext",
        { dir: spec.dir, skip: SKIP_UPLOAD },
        { replace: true, signal },
      );
      if (sent.skipped.length > 0) {
        // Links (a pnpm workspace's node_modules), devices, clashing names: what arrives is not
        // the extension, and it would fail in some way far from here.
        const shown = sent.skipped
          .slice(0, 5)
          .map((s) => `${s.path} (${s.why})`)
          .join(", ");
        await job.close().catch(() => undefined);
        return this.#here(
          spec,
          signal,
          `parts of its folder do not go into a sandbox: ${shown}${sent.skipped.length > 5 ? ", ..." : ""}`,
          false,
        );
      }
      if (plan.dropped.length > 0) {
        log.warn(
          { ext: spec.extension, dropped: plan.dropped },
          "not passed into the extension's sandbox",
        );
      }
      const proc = await job.proc(this.#procId(), { argv: plan.argv, cwd: "/ext", env: plan.env });
      // The job ends with the program: its bundled servers with it, and a restart opens a new
      // job (v6-sandbox.md §13.2).
      const child = procChild(proc, job, () => void job.close().catch(() => undefined));
      const onAbort = () => {
        child.kill();
        void job.close().catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void child.exited.then(() => signal.removeEventListener("abort", onAbort));
      this.#place(spec.extension, {
        child,
        placement: { kind: "sandbox", host: job.host, job: job.id },
        job,
        retry: false,
      });
      log.info(
        {
          ext: spec.extension,
          host: job.host,
          job: job.id,
          network: plan.network.mode,
          credentials: plan.credentials,
        },
        "extension started in a sandbox",
      );
      return child;
    } catch (error) {
      await job.close().catch(() => undefined);
      if (signal.aborted) throw new LaunchError(`starting \`${spec.extension}\`: aborted`);
      return this.#here(spec, signal, errorMessage(error), true);
    }
  }

  /**
   * The client, waiting for it at boot: the sandbox module provides it when it starts, which
   * may be after the first extensions do, and an extension started here then would stay here.
   */
  async #clientSoon(signal: AbortSignal): Promise<SandboxClient | null> {
    for (;;) {
      const client = this.#client();
      const left = this.#bootUntil - this.#now();
      if (client !== null || left <= 0 || signal.aborted) return client;
      try {
        await sleep(Math.min(CLIENT_POLL_MS, left), signal);
      } catch {
        return this.#client();
      }
    }
  }

  /** A computer that takes plugins, waiting for one at boot. */
  async #available(
    client: SandboxClient,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (;;) {
      const free = client.available("plugin");
      const left = this.#bootUntil - this.#now();
      if (free.ok || free.code !== "no_machine" || left <= 0 || signal.aborted) return free;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        const off = client.watch(done);
        signal.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(timer);
          off();
          signal.removeEventListener("abort", done);
          resolve();
        }
      });
    }
  }

  /** Not in a sandbox: here, or not at all, as the owner chose. */
  async #here(
    spec: LaunchSpec,
    signal: AbortSignal,
    why: string,
    retry: boolean,
    quiet = false,
  ): Promise<ChildLike> {
    if ((this.#o.fallback ?? "host") === "fail") {
      throw new LaunchError(`\`${spec.extension}\` should run in a sandbox, but ${why}`);
    }
    const fields = { ext: spec.extension, reason: why };
    if (quiet) log.info(fields, "extension runs on this machine, not in a sandbox");
    else log.warn(fields, "extension runs on this machine, not in a sandbox");
    const child = await this.#local.launch(spec, signal);
    this.#place(spec.extension, {
      child,
      placement: { kind: "host", reason: why },
      job: null,
      retry,
    });
    return child;
  }

  /** Until `extension`'s main program runs somewhere (or `signal` aborts). */
  async #started(extension: string, signal: AbortSignal): Promise<Running> {
    for (;;) {
      const running = this.#running.get(extension);
      if (running !== undefined) return running;
      if (signal.aborted) throw new LaunchError(`starting a program of \`${extension}\`: aborted`);
      await new Promise<void>((resolve) => {
        const done = () => {
          this.#listeners.delete(done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.#listeners.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  async launchInSame(extension: string, spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike> {
    const here = () =>
      this.#local.launchInSame
        ? this.#local.launchInSame(extension, spec, signal)
        : this.#local.launch(spec, signal);
    if (spec.runIn === "host") return here();
    // Where the extension is, which is only known once it started.
    const running = await this.#started(extension, signal);
    if (running.job === null) return here();
    const job = running.job;
    const plan = sandboxPlan(spec, this.#o);
    if (!plan.ok) {
      throw new LaunchError(`a program of \`${extension}\` cannot run in its sandbox: ${plan.why}`);
    }
    if (plan.hosts !== undefined && !plan.hosts.includes(job.host)) {
      throw new LaunchError(
        `a program of \`${extension}\` holds credentials that may not go to ${job.host}`,
      );
    }
    const proc = await job.proc(this.#procId(), { argv: plan.argv, cwd: "/ext", env: plan.env });
    const child = procChild(proc, job, () => undefined);
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    void child.exited.then(() => signal.removeEventListener("abort", onAbort));
    return child;
  }
}
