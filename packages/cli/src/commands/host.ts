// `miyoria hostd | up | down | restart | status | logs`: this machine's services, through its hostd
// (docs/design/v5-hostd.md §10). `up` starts the daemon in the background when none answers;
// `up --foreground` and `hostd` run it in this terminal. Everything else only talks to it.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  HOST_ERROR_CODE,
  type HostGpuArbiterStatus,
  type HostInfo,
  type HostLinkState,
  type HostServiceControlResult,
  type HostServiceEvent,
  type HostServiceList,
  type HostServiceState,
  type HostServiceStatus,
  type HostShutdownResult,
} from "@miyoria/contracts/host";
import {
  Daemon,
  fileTail,
  HOST_CONFIG_FILE,
  HostdClient,
  HostdRunningError,
  HostRpcError,
  type LoadedHostConfig,
  loadHostConfig,
} from "@miyoria/hostd";
import { cliVersion, PACKAGE_ROOT } from "../assets.js";
import { t } from "../i18n/index.js";
import { repoRoot } from "../stack/config.js";
import { bold, dim, fail, green, note, ok, println, red, section, warn, yellow } from "../ui.js";
import { loadConfig } from "./node.js";
import * as remote from "./remote.js";

export class HostCommandError extends Error {
  override readonly name = "HostCommandError";
}

/** The Core config and the `host.toml` a command works on, both absolute. */
export interface HostTarget {
  configPath: string;
  hostToml: string;
}

/** `--host-config`, else `host.toml` in the config file's folder. */
export function hostTarget(configPath: string, hostConfig?: string): HostTarget {
  const config = resolve(configPath);
  return {
    configPath: config,
    hostToml: resolve(hostConfig ?? join(dirname(config), HOST_CONFIG_FILE)),
  };
}

/**
 * Where the descriptors are: the source checkout around the workspace, else the one around this
 * CLI, else the installed package, which carries the catalog at the same relative paths
 * (`workers/*`, `services/*`, `packages/core` ...; scripts/build.mjs copies them).
 */
export function catalogRoot(hostToml: string, packageRoot: string = PACKAGE_ROOT): string {
  return repoRoot(hostToml) ?? repoRoot(join(packageRoot, "package.json")) ?? packageRoot;
}

/**
 * How this CLI was started (`{miyoria}`): `node dist/main.js` when installed, `node <tsx flags>
 * src/main.ts` from source.
 */
export function selfCommand(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? ""];
}

export function loadHost(target: HostTarget): LoadedHostConfig {
  if (!existsSync(target.hostToml)) {
    throw new HostCommandError(t.host.noHostToml(target.hostToml));
  }
  return loadHostConfig(target.hostToml);
}

function daemonFor(target: HostTarget, onShutdown?: () => void): Daemon {
  return new Daemon({
    hostConfig: target.hostToml,
    catalogRoot: catalogRoot(target.hostToml),
    configPath: target.configPath,
    miyoria: selfCommand(),
    version: cliVersion(),
    ...(onShutdown !== undefined ? { onShutdown } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolves on Ctrl+C or a termination request. */
function untilSignal(extra?: (stop: () => void) => void): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      done();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    extra?.(finish);
  });
}

// ---- output ------------------------------------------------------------------------------

const TAIL_LINES = 12;

function printTail(lines: readonly string[], logFile?: string): void {
  for (const line of lines.slice(-TAIL_LINES)) println(dim(`    | ${line}`));
  if (logFile !== undefined) println(dim(t.host.logFile(logFile)));
}

function printEvent(
  event: HostServiceEvent,
  logs: string,
  urlOf: (name: string) => string | undefined,
): void {
  const name = bold(event.service);
  const reason = event.reason ?? "";
  switch (event.state) {
    case "starting":
      if (event.previous !== "backoff") note(t.host.starting(event.service));
      return;
    case "running":
      ok(`${name}  ${urlOf(event.service) ?? t.host.running}`);
      return;
    case "foreign":
      warn(`${name}  ${reason}`);
      return;
    case "disabled":
      warn(`${name}  ${t.host.disabled(reason)}`);
      return;
    case "backoff":
    case "failed":
      fail(`${event.service}  ${reason}`);
      printTail(event.log_tail ?? [], join(logs, `${event.service}.log`));
      return;
    case "stopped":
      println(`${red("■")} ${event.service}${reason !== "" ? dim(`  ${reason}`) : ""}`);
      return;
    default:
      return;
  }
}

/** States `up` stops waiting at. */
const SETTLED: ReadonlySet<HostServiceState> = new Set([
  "running",
  "foreign",
  "failed",
  "backoff",
  "disabled",
  "stopped",
  "external",
]);

/** Waits for each service to come up or fail and prints it; returns the ones that did not come up. */
export async function watchStarts(
  client: HostdClient,
  names: readonly string[],
  logs: string,
  timeoutMs: number | null,
): Promise<{ failed: string[]; pending: string[] }> {
  const started = Date.now();
  const left = new Set(names);
  const failed: string[] = [];
  while (left.size > 0 && (timeoutMs === null || Date.now() - started < timeoutMs)) {
    const { services } = await client.call<HostServiceList>("service.list");
    for (const name of [...left]) {
      const s = services.find((x) => x.name === name);
      if (s === undefined) {
        left.delete(name);
        continue;
      }
      if (!SETTLED.has(s.state)) continue;
      left.delete(name);
      const secs = dim(t.host.elapsed(((Date.now() - started) / 1000).toFixed(1)));
      switch (s.state) {
        case "running":
          ok(`${bold(name)}  ${s.url ?? t.host.running}  ${secs}`);
          break;
        case "foreign":
          warn(`${bold(name)}  ${s.reason ?? t.host.foreignDefault}`);
          break;
        case "disabled":
          warn(`${bold(name)}  ${t.host.disabled(s.reason ?? "")}`);
          break;
        case "external":
          note(t.host.externalNotStarted(name));
          break;
        case "stopped":
          warn(
            `${bold(name)}  ${t.host.stopped}${s.reason !== undefined ? t.host.suffix(s.reason) : ""}`,
          );
          break;
        default: {
          failed.push(name);
          fail(`${name}  ${s.reason ?? s.state}`);
          const { lines } = await client
            .call<{ lines: string[] }>("service.logs", { service: name, lines: TAIL_LINES })
            .catch(() => ({ lines: [] as string[] }));
          printTail(lines, join(logs, `${name}.log`));
        }
      }
    }
    if (left.size > 0) await sleep(300);
  }
  return { failed, pending: [...left] };
}

/**
 * The text of an error from hostd. A refusal hostd sends with a code is worded here, in the
 * language of this run, when the service it is about is known; otherwise hostd's own message.
 */
export function rpcText(error: unknown, service?: string): string {
  if (error instanceof HostRpcError && service !== undefined) {
    const m = t.host.rpc;
    switch (error.code) {
      case HOST_ERROR_CODE.UnknownService:
        return m.unknownService(service);
      case HOST_ERROR_CODE.NotInstalled:
        return m.notInstalled(service);
      case HOST_ERROR_CODE.Guarded: {
        const states = (error.data as { states?: unknown } | undefined)?.states;
        if (!Array.isArray(states)) return m.guardUnknown(service);
        const words = states.map((s) => (s === "singing" ? m.singing : s === "live" ? m.live : s));
        return m.guarded(service, t.common.list(words));
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// ---- hostd -------------------------------------------------------------------------------

/**
 * `miyoria hostd`: the daemon in this terminal until Ctrl+C or `down`. It starts no service by
 * itself unless `start` (`--start`, what the logon entry passes) asks for the enabled ones.
 */
export async function hostd(target: HostTarget, options: { start?: boolean } = {}): Promise<void> {
  let shutdown: () => void = () => {};
  const daemon = daemonFor(target, () => shutdown());
  try {
    await daemon.start();
  } catch (error) {
    if (error instanceof HostdRunningError) {
      if (options.start === true) {
        // The logon entry found a daemon already there (someone ran `up` first). Its job is
        // done once the enabled services are asked to start; ending in an error would make a
        // supervisor such as systemd start this again and again.
        await startEnabledThrough(target, error.info.pid);
        return;
      }
      throw new HostCommandError(t.host.alreadyRunningHere(error.info.pid));
    }
    throw error;
  }
  const host = daemon.hostConfig;
  // Detached, stdout is the log file: the state lines are for a terminal only.
  if (process.stdout.isTTY) {
    println(t.host.daemonRunning(process.pid, daemon.port, host.workspace));
    daemon.onEvent((e) =>
      printEvent(
        e,
        host.state.logs,
        (name) => daemon.report({ withTokens: false }).services.find((s) => s.name === name)?.url,
      ),
    );
  }
  if (options.start === true) {
    // The logon entry (`host autostart`): bring back what host.toml enables, as `up` would.
    try {
      await daemon.startAll();
    } catch (error) {
      fail(t.host.startServicesFailed(rpcText(error)));
    }
  }
  await untilSignal((stop) => {
    shutdown = stop;
  });
  await daemon.stop();
}

/** Asks the daemon that already runs for this workspace to start what host.toml enables. */
async function startEnabledThrough(target: HostTarget, pid: number): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    warn(t.host.runningNoApi(pid));
    return;
  }
  const { services: listed } = await client.call<HostServiceList>("service.list");
  const names = enabledNames(host, listed);
  for (const service of names) {
    await client
      .call<HostServiceControlResult>("service.start", { service })
      .catch((error: unknown) => warn(`${service}  ${rpcText(error, service)}`));
  }
  note(t.host.askedToStart(pid, t.common.services(names.length)));
}

// ---- up ------------------------------------------------------------------------------------

export interface UpOptions {
  services: string[];
  foreground?: boolean;
  timeoutSecs?: number;
  noWait?: boolean;
  /**
   * Once `core` of this machine answers: links this machine to it (`cluster.selfLink`; passed in
   * because that module imports this one). Absent with `--no-link`.
   */
  selfLink?: (host: LoadedHostConfig) => Promise<void>;
}

/** The services `up` starts without names: every one `host.toml` enables, in start order. */
function enabledNames(host: LoadedHostConfig, listed: readonly HostServiceStatus[]): string[] {
  return listed
    .filter((s) => s.kind !== "external" && host.config.services[s.name]?.enabled !== false)
    .map((s) => s.name);
}

/** The daemon of the workspace; started detached (no window) when none answers. */
async function ensureDaemon(target: HostTarget, host: LoadedHostConfig): Promise<HostdClient> {
  const running = await HostdClient.connect(host.state.root);
  if (running !== null) {
    note(t.host.alreadyRunning(running.info.pid));
    return running;
  }
  mkdirSync(host.state.logs, { recursive: true });
  const logFile = join(host.state.logs, "hostd.log");
  const [program, ...leading] = selfCommand() as [string, ...string[]];
  const fd = openSync(logFile, "a");
  let exitCode: number | null = null;
  let spawnError: string | null = null;
  try {
    const child = spawn(
      program,
      [...leading, "hostd", "-c", target.configPath, "--host-config", target.hostToml],
      {
        cwd: host.workspace,
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env: process.env,
      },
    );
    child.on("exit", (code) => {
      exitCode = code ?? -1;
    });
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const client = await HostdClient.connect(host.state.root, 1000);
    if (client !== null) {
      ok(t.host.startedInBackground(client.info.pid, logFile));
      return client;
    }
    if (exitCode !== null || spawnError !== null) break;
    await sleep(250);
  }
  fail(
    spawnError !== null
      ? t.host.cannotStart(spawnError)
      : exitCode !== null
        ? t.host.exitedEarly(exitCode)
        : t.host.noAnswer(t.common.seconds(30)),
  );
  printTail(fileTail(logFile, TAIL_LINES), logFile);
  throw new HostCommandError(t.host.didNotStart);
}

export async function up(target: HostTarget, options: UpOptions): Promise<void> {
  const host = loadHost(target);
  if (options.foreground) {
    await foreground(target, host, options);
    return;
  }
  const client = await ensureDaemon(target, host);
  const { services: listed } = await client.call<HostServiceList>("service.list");
  const names = options.services.length > 0 ? options.services : enabledNames(host, listed);
  if (names.length === 0) {
    warn(t.host.nothingToStart(target.hostToml));
    return;
  }
  section(t.host.startingChain(names.join(" → ")));
  const asked: string[] = [];
  let refused = 0;
  for (const service of names) {
    try {
      await client.call<HostServiceControlResult>("service.start", { service });
      asked.push(service);
    } catch (error) {
      refused += 1;
      fail(rpcText(error, service));
    }
  }
  if (options.noWait) {
    note(t.host.handedOver);
    if (refused > 0) throw new HostCommandError(t.host.couldNotStart(t.common.services(refused)));
    return;
  }
  const timeoutMs = options.timeoutSecs !== undefined ? options.timeoutSecs * 1000 : null;
  const { failed, pending } = await watchStarts(client, asked, host.state.logs, timeoutMs);
  if (pending.length > 0) {
    warn(t.host.stillStarting(t.common.list(pending)));
  }
  if (options.selfLink !== undefined && asked.includes("core") && !pending.includes("core")) {
    const { services } = await client.call<HostServiceList>("service.list");
    if (services.find((s) => s.name === "core")?.state === "running") {
      await options.selfLink(host);
    }
  }
  const bad = failed.length + refused;
  if (bad > 0) throw new HostCommandError(t.host.servicesDidNotStart(t.common.services(bad)));
  if (pending.length === 0) println(`\n${t.host.allReady(green(t.host.allReadyMark))}`);
}

/** `up --foreground`: the supervisor inside this terminal; Ctrl+C stops everything. */
async function foreground(
  target: HostTarget,
  host: LoadedHostConfig,
  options: UpOptions,
): Promise<void> {
  let shutdown: () => void = () => {};
  const daemon = daemonFor(target, () => shutdown());
  try {
    await daemon.start();
  } catch (error) {
    if (error instanceof HostdRunningError) {
      throw new HostCommandError(t.host.alreadyInBackground(error.info.pid));
    }
    throw error;
  }
  daemon.onEvent((e) =>
    printEvent(
      e,
      host.state.logs,
      (name) => daemon.report({ withTokens: false }).services.find((s) => s.name === name)?.url,
    ),
  );
  const listed = daemon.report({ withTokens: false }).services;
  const names = options.services.length > 0 ? options.services : enabledNames(host, listed);
  section(t.host.foregroundStart(names.join(" → ") || t.common.none));
  const operator = { kind: "operator" } as const;
  for (const service of names) {
    try {
      await daemon.call("service.start", { service }, operator);
    } catch (error) {
      fail(rpcText(error, service));
    }
  }
  let stopping = false;
  if (options.selfLink !== undefined && names.includes("core")) {
    // Core takes a while: link in the background once it answers, without holding Ctrl+C back.
    const link = options.selfLink;
    void (async () => {
      const until = Date.now() + 5 * 60_000;
      while (!stopping && Date.now() < until) {
        const state = daemon.report({ withTokens: false }).services.find((s) => s.name === "core");
        if (state?.state === "running") {
          await link(host);
          return;
        }
        if (state?.state === "failed") return;
        await sleep(500);
      }
    })();
  }
  await untilSignal((stop) => {
    shutdown = stop;
  });
  stopping = true;
  section(t.host.stoppingServices);
  await daemon.stop();
}

// ---- down / restart --------------------------------------------------------------------------

export async function down(
  target: HostTarget,
  options: { services: string[]; force?: boolean },
): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    warn(t.host.notRunningNothingToStop);
    return;
  }
  const force = options.force === true;
  if (options.services.length === 0) {
    let result: HostShutdownResult;
    try {
      result = await client.call<HostShutdownResult>(
        "host.shutdown",
        { force },
        { timeoutMs: 600_000 },
      );
    } catch (error) {
      if (error instanceof HostRpcError && error.code === HOST_ERROR_CODE.Guarded) {
        throw new HostCommandError(t.host.noneStopped(error.message));
      }
      throw error;
    }
    for (const name of result.stopped) println(`${red("■")} ${name}`);
    ok(t.host.daemonStopped);
    return;
  }
  let errors = 0;
  for (const service of options.services) {
    try {
      const r = await client.call<HostServiceControlResult>(
        "service.stop",
        { service, force },
        { timeoutMs: 120_000 },
      );
      if (r.state === "stopped") println(`${red("■")} ${service}`);
      else if (r.state === "foreign") warn(t.host.foreignNotStopped(service));
      else if (r.state === "external") warn(t.host.externalNotStopped(service));
      else warn(`${service}${t.host.suffix(r.state)}`);
    } catch (error) {
      errors += 1;
      fail(rpcText(error, service));
    }
  }
  if (errors > 0) throw new HostCommandError(t.host.servicesDidNotStop(t.common.services(errors)));
}

export async function restart(
  target: HostTarget,
  options: { service: string; force?: boolean; timeoutSecs?: number },
): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    throw new HostCommandError(t.host.restartNotRunning(options.service));
  }
  try {
    await client.call<HostServiceControlResult>(
      "service.restart",
      { service: options.service, force: options.force === true },
      { timeoutMs: 120_000 },
    );
  } catch (error) {
    if (error instanceof HostRpcError) {
      throw new HostCommandError(rpcText(error, options.service));
    }
    throw error;
  }
  note(t.host.restarted(options.service));
  const timeoutMs = options.timeoutSecs !== undefined ? options.timeoutSecs * 1000 : null;
  const { failed } = await watchStarts(client, [options.service], host.state.logs, timeoutMs);
  if (failed.length > 0) throw new HostCommandError(t.host.serviceDidNotStart(options.service));
}

// ---- status ------------------------------------------------------------------------------

/** A span of milliseconds as a duration (`12 s`, `5 min`). */
function span(ms: number): string {
  return t.common.duration(ms / 1000);
}

/** Milliseconds ago (`5 min ago`). */
function before(ms: number): string {
  return t.common.ago(ms / 1000);
}

/** The label column of `status` (hostd, GPU, arbiter): the widest label and two spaces. */
function labelWidth(): number {
  const { hostd, gpu, arbiter } = t.host.labels;
  return Math.max(...[hostd, gpu, arbiter].map(displayWidth)) + 2;
}

function labelled(label: string, text: string): string {
  return `${label}${" ".repeat(Math.max(0, labelWidth() - displayWidth(label)))}${text}`;
}

/** A line under a labelled one, starting where its text starts. */
function continued(text: string): string {
  return `${" ".repeat(labelWidth())}${text}`;
}

/**
 * Who decides how the card is shared, for `status`: nothing when the daemon says nothing about
 * it (an older one), one line for the mode, one per lease, and the last decision.
 */
export function arbiterLines(
  arbiter: HostGpuArbiterStatus | undefined,
  now = Date.now(),
): string[] {
  if (arbiter === undefined) return [];
  const label = t.host.labels.arbiter;
  if (arbiter.mode === "worker") return [labelled(label, dim(t.host.arbiterWorker))];
  if (!arbiter.active) {
    const reason = arbiter.reason === undefined ? "" : t.host.suffix(arbiter.reason);
    return [labelled(label, `${yellow(t.host.arbiterInactive)}${reason}`)];
  }
  const lines = [
    labelled(label, t.host.arbiterActive(arbiter.policy ?? null, arbiter.leases.length)),
  ];
  for (const lease of arbiter.leases) {
    const what = [lease.mode, lease.code].filter((part) => part !== null).join(" / ");
    lines.push(
      continued(
        t.host.lease(
          bold(lease.holder),
          lease.stage,
          what === "" ? null : what,
          span(now - lease.since),
          lease.evicted.length > 0 ? t.common.list(lease.evicted) : null,
        ),
      ),
    );
  }
  const last = arbiter.last;
  if (last !== null) {
    lines.push(
      dim(
        continued(
          t.host.lastDecision(last.stage, last.mode, last.code, before(now - last.at), last.reason),
        ),
      ),
    );
  }
  return lines;
}

/** The control link's state as `status` says it. */
export function linkText(state: HostLinkState | undefined): string {
  const link = t.host.link;
  switch (state) {
    case "connected":
      return green(link.connected);
    case "connecting":
      return yellow(link.connecting);
    case "unauthorized":
      return red(link.unauthorized);
    case "stopped":
      return dim(link.stopped);
    default:
      return dim(link.none);
  }
}

function stateColor(state: HostServiceState, text: string): string {
  switch (state) {
    case "running":
      return green(text);
    case "failed":
    case "backoff":
      return red(text);
    case "starting":
    case "stopping":
    case "foreign":
      return yellow(text);
    case "disabled":
    case "stopped":
      return dim(text);
    default:
      return text;
  }
}

/** Terminal columns of a text: CJK and full-width characters take two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && code <= 0xffdc ? 2 : 1;
  }
  return width;
}

/** The service table of `status`. The state column is hostd's own word for the state. */
export function serviceTable(services: readonly HostServiceStatus[], now = Date.now()): string[] {
  const c = t.host.columns;
  const head = [c.service, c.state, c.health, c.port, c.pid, c.restarts, c.since, c.reason];
  const states: Record<string, string> = t.host.states;
  const rows = services.map((s) => [
    s.name,
    states[s.state] ?? s.state,
    s.state === "running" || s.state === "external" || s.state === "foreign"
      ? s.healthy
        ? "✓"
        : "✗"
      : "-",
    s.port !== undefined ? String(s.port) : "-",
    s.pid !== undefined ? String(s.pid) : "-",
    String(s.restarts),
    before(now - s.since),
    s.reason ?? "",
  ]);
  const widths = head.map((_, i) =>
    Math.max(...[head, ...rows].map((r) => displayWidth(r[i] ?? ""))),
  );
  const pad = (text: string, i: number) =>
    text + " ".repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(text)));
  const lines = [dim(head.map((h, i) => (i === head.length - 1 ? h : pad(h, i))).join("  "))];
  rows.forEach((row, r) => {
    const state = services[r]?.state as HostServiceState;
    lines.push(
      row
        .map((cell, i) => {
          const text = i === row.length - 1 ? cell : pad(cell, i);
          return i === 1 ? stateColor(state, text) : text;
        })
        .join("  ")
        .trimEnd(),
    );
  });
  return lines;
}

/** What `status` shows of this machine when its hostd answers: a section title and its lines. */
export function hostStatus(
  info: HostInfo,
  daemon: { pid: number; started_at: string; workspace: string },
  now = Date.now(),
): { title: string; lines: string[] } {
  const { labels } = t.host;
  const gpu = info.gpu;
  const lines = [
    labelled(
      labels.hostd,
      `${t.host.daemonLine(daemon.pid, span(now - Date.parse(daemon.started_at)), linkText(info.link))}  ${dim(daemon.workspace)}`,
    ),
    labelled(
      labels.gpu,
      gpu === null
        ? dim(t.host.gpuUnreadable)
        : t.host.gpuLine(
            gpu.name ?? "",
            t.common.int(gpu.used_mb),
            t.common.mb(gpu.total_mb),
            gpu.free_mb === undefined ? null : t.common.mb(gpu.free_mb),
            t.common.mb(gpu.reserve_mb),
          ),
    ),
    ...arbiterLines(info.arbiter, now),
    "",
    ...(info.services.length === 0 ? [dim(t.host.noServices)] : []),
    ...serviceTable(info.services, now),
  ];
  return { title: t.host.thisMachine(info.name), lines };
}

export interface StatusOptions {
  /** `--all`: after this machine's table, what shows every host of Core (`cluster.hostsSection`). */
  hosts?: (core: remote.Remote) => Promise<void>;
  /** `--json`: print `StatusJson` and nothing else on stdout. */
  json?: boolean;
  /** With `json`: include every host of Core (`--all`). */
  all?: boolean;
}

/** One service of this machine in `status --json`. */
export interface StatusServiceJson {
  name: string;
  kind: string;
  provides: string[];
  /** hostd's state: stopped, starting, running, stopping, backoff, failed, external, foreign, disabled. */
  state: string;
  healthy: boolean;
  port: number | null;
  pid: number | null;
  url: string | null;
  restarts: number;
  /** When the state last changed (ISO 8601). */
  since: string;
  /** hostd's reason for a failed, backoff or disabled state (hostd's own text). */
  reason: string | null;
}

/** `status --json`: schema `miyoria.status/1`. */
export interface StatusJson {
  schema: "miyoria.status/1";
  host_toml: string;
  /** This machine; `null` without host.toml. */
  machine: {
    name: string;
    /** The services host.toml enables. */
    enabled: string[];
    /** The running hostd; `null` when it is not running. */
    hostd: {
      pid: number;
      started_at: string;
      workspace: string;
      version: string;
      /** The link to Core: connected, connecting, unauthorized, stopped or none. */
      link: string;
    } | null;
    gpu: {
      name: string | null;
      total_mb: number;
      used_mb: number;
      free_mb: number | null;
      reserve_mb: number;
    } | null;
    /** As hostd reports them; empty when hostd is not running. */
    services: StatusServiceJson[];
  } | null;
  /** The running Core; `null` when it does not answer or its config cannot be read. */
  core: {
    version: string;
    status: string;
    modules: Array<{ id: string; state: string; reason: string | null }>;
    llm_usage: Record<
      string,
      {
        calls: number;
        prompt_tokens: number;
        cached_prompt_tokens: number;
        completion_tokens: number;
      }
    >;
  } | null;
  /** With `--all`: every host Core knows (`ClusterHostView`); `null` when Core cannot list them. */
  hosts?: unknown[] | null;
}

/** This machine's part of `status --json`. */
export function machineJson(
  name: string,
  enabled: string[],
  info: HostInfo | null,
  daemon: { pid: number; started_at: string; workspace: string } | null,
): NonNullable<StatusJson["machine"]> {
  return {
    name: info?.name ?? name,
    enabled,
    hostd:
      info === null || daemon === null
        ? null
        : {
            pid: daemon.pid,
            started_at: daemon.started_at,
            workspace: daemon.workspace,
            version: info.version,
            link: info.link ?? "none",
          },
    gpu:
      info?.gpu == null
        ? null
        : {
            name: info.gpu.name ?? null,
            total_mb: info.gpu.total_mb,
            used_mb: info.gpu.used_mb,
            free_mb: info.gpu.free_mb ?? null,
            reserve_mb: info.gpu.reserve_mb,
          },
    services: (info?.services ?? []).map((s) => ({
      name: s.name,
      kind: s.kind,
      provides: s.provides,
      state: s.state,
      healthy: s.healthy,
      port: s.port ?? null,
      pid: s.pid ?? null,
      url: s.url ?? null,
      restarts: s.restarts,
      since: new Date(s.since).toISOString(),
      reason: s.reason ?? null,
    })),
  };
}

async function statusJson(target: HostTarget, options: StatusOptions): Promise<void> {
  const out: StatusJson = {
    schema: "miyoria.status/1",
    host_toml: target.hostToml,
    machine: null,
    core: null,
  };
  const host = existsSync(target.hostToml) ? loadHostConfig(target.hostToml) : null;
  if (host !== null) {
    const enabled = Object.entries(host.config.services)
      .filter(([, s]) => s.enabled)
      .map(([name]) => name);
    const client = await HostdClient.connect(host.state.root);
    const info = client === null ? null : await client.call<HostInfo>("host.info");
    out.machine = machineJson(host.config.name, enabled, info, client?.info ?? null);
  }
  let core: remote.Remote | null = null;
  try {
    core = remote.clientFor(await loadConfig(target.configPath));
  } catch (error) {
    if (host === null) throw error;
  }
  if (core !== null && (await remote.isRunning(core))) {
    const health = await core.rpc.health();
    const modules = await core.rpc.modules.list();
    const usage = await core.rpc.llm.usage();
    out.core = {
      version: health.version,
      status: health.status,
      modules: modules.map((m) => ({ id: m.id, state: m.state, reason: m.reason ?? null })),
      llm_usage: Object.fromEntries(
        Object.entries(usage)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([model, u]) => [
            model,
            {
              calls: u.calls,
              prompt_tokens: u.prompt_tokens,
              cached_prompt_tokens: u.cached_prompt_tokens,
              completion_tokens: u.completion_tokens,
            },
          ]),
      ),
    };
    if (options.all) out.hosts = await core.rpc.cluster.hosts().catch(() => null);
  } else if (options.all) {
    out.hosts = null;
  }
  println(JSON.stringify(out, null, 2));
}

export async function status(target: HostTarget, options: StatusOptions = {}): Promise<void> {
  if (options.json) {
    await statusJson(target, options);
    return;
  }
  const host = existsSync(target.hostToml) ? loadHostConfig(target.hostToml) : null;
  if (host === null) {
    note(t.host.noHostTomlNote(target.hostToml));
  } else {
    const client = await HostdClient.connect(host.state.root);
    if (client === null) {
      section(t.host.thisMachine(host.config.name));
      warn(t.host.notRunningStartHint);
      const enabled = Object.entries(host.config.services)
        .filter(([, s]) => s.enabled)
        .map(([name]) => name);
      println(
        t.host.enabledInHostToml(enabled.length > 0 ? t.common.list(enabled) : t.common.none),
      );
    } else {
      const view = hostStatus(await client.call<HostInfo>("host.info"), client.info);
      section(view.title);
      for (const line of view.lines) println(line);
    }
  }

  // Core, as the status command showed it before hostd.
  let core: remote.Remote;
  try {
    core = remote.clientFor(await loadConfig(target.configPath));
  } catch (error) {
    if (host === null) throw error;
    println(dim(`\n${t.host.coreSkipped(rpcText(error))}`));
    return;
  }
  if (!(await remote.isRunning(core))) {
    println(`\n${dim(t.host.coreNotAnswering)}`);
    return;
  }
  await options.hosts?.(core);
  section("Core");
  await remote.status(core);
}

// ---- logs --------------------------------------------------------------------------------

export async function logs(
  target: HostTarget,
  options: { service: string; follow?: boolean; lines: number; signal?: AbortSignal },
): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    const file = join(host.state.logs, `${options.service}.log`);
    if (!existsSync(file)) {
      throw new HostCommandError(t.host.notRunningNoLog(file));
    }
    for (const line of fileTail(file, options.lines)) println(line);
    if (options.follow) warn(t.host.notRunningNoFollow);
    return;
  }
  for await (const line of client.logs(options.service, {
    lines: options.lines,
    follow: options.follow === true,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })) {
    println(line);
  }
}
