// `miyoria update`: pull, install, and rebuild what changed (SDK, extension `dist`, panel, overlay,
// Minecraft mod jar). Rebuilds are decided by file times, so an unchanged tree does nothing.
// Replacing the installed mod jar backs the old one up first and asks (`--yes` skips the question).
// Then the services (docs/design/v5-hostd.md §9): every enabled Python service whose install record
// differs from the lock, the extras or the descriptor is synced again, and every running service
// that was synced or whose folder changed in the pull is restarted, one at a time through the
// guard. A guarded service that is busy is reported and left running. Last, the model files of
// `[[install.files]]` that are missing or wrong are listed with sizes and licences and, after one
// question (`--yes` skips it), downloaded.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HOST_ERROR_CODE, type HostServiceList } from "@miyoria/contracts/host";
import {
  type CatalogEntry,
  HostdClient,
  HostRpcError,
  inspectService,
  loadCatalog,
  servicesChangedBy,
} from "@miyoria/hostd";
import type { Config } from "@miyoria/runtime/kernel";
import { t } from "../i18n/index.js";
import {
  type BuildTarget,
  buildTargets,
  checkTarget,
  findJdk21,
  installedModJars,
  minecraftModsDir,
  modFreshness,
  modInfo,
} from "../stack/builds.js";
import { repoRoot } from "../stack/config.js";
import { defaultRunner, type Runner, tailLines } from "../stack/system.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import {
  catalogRoot,
  HostCommandError,
  hostTarget,
  loadHost,
  rpcText,
  watchStarts,
} from "./host.js";
import { loadConfig } from "./node.js";
import {
  confirmFiles,
  filesToFetch,
  openInstaller,
  printFileNeeds,
  printFiles,
  printInstall,
  progressPrinter,
  type ServiceDeps,
} from "./services.js";

export class UpdateError extends Error {
  override readonly name = "UpdateError";
}

export interface UpdateOptions {
  /** Do not `git pull`. */
  noPull?: boolean;
  /** Rebuild everything, fresh or not. */
  force?: boolean;
  /** Only say what would run. */
  dryRun?: boolean;
  /** Do not build or install the Minecraft mod. */
  skipMod?: boolean;
  /** Sync the environments, but restart nothing. */
  noRestart?: boolean;
  /** `--host-config`: the host.toml of this machine (default: next to the config file). */
  hostConfig?: string;
}

export interface UpdateDeps {
  run: Runner;
  /** Asked before replacing the installed mod jar. */
  confirm: (message: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  now: () => Date;
  /** The installer's seams for the services part (tests), and the download question. */
  services?: ServiceDeps;
}

export function defaultUpdateDeps(confirm: UpdateDeps["confirm"]): UpdateDeps {
  return {
    run: defaultRunner,
    confirm,
    env: process.env,
    platform: process.platform,
    now: () => new Date(),
  };
}

const BUILD_TIMEOUT_MS = 15 * 60_000;

function failureTail(stdout: string, stderr: string): string[] {
  return tailLines(`${stderr}\n${stdout}`, 12).map((l) => dim(`    | ${l}`));
}

/** `pnpm install` is due when the lockfile is newer than what the last install recorded. */
export function installNeeded(root: string): boolean {
  const record = join(root, "node_modules", ".modules.yaml");
  if (!existsSync(record)) return true;
  try {
    return statSync(join(root, "pnpm-lock.yaml")).mtimeMs > statSync(record).mtimeMs + 1000;
  } catch {
    return false;
  }
}

/** What a pull changed: the commit before and after. `null` when nothing was pulled. */
export interface PullResult {
  before: string;
  after: string;
}

async function pull(root: string, deps: UpdateDeps, dryRun: boolean): Promise<PullResult | null> {
  if (!existsSync(join(root, ".git"))) {
    note(t.update.notGit);
    return null;
  }
  if (dryRun) {
    note(t.update.wouldPull);
    return null;
  }
  const status = await deps.run("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 30_000 });
  if (status.missing) {
    warn(t.update.gitMissing);
    return null;
  }
  if (status.stdout.trim() !== "") {
    warn(t.update.dirtyTree);
    return null;
  }
  const head = () => deps.run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
  const before = (await head()).stdout.trim();
  const result = await deps.run("git", ["pull", "--ff-only"], { cwd: root, timeoutMs: 120_000 });
  if (result.code !== 0) {
    fail(t.update.pullFailed);
    for (const l of failureTail(result.stdout, result.stderr)) println(l);
    throw new UpdateError(t.update.pullAborted);
  }
  const after = (await head()).stdout.trim();
  const changed = after !== before;
  ok(changed ? t.update.pulled : t.update.alreadyCurrent);
  return changed ? { before, after } : null;
}

/** The files a pull changed, from `git diff --name-only`; `null` when git cannot say. */
async function changedFiles(
  root: string,
  pulled: PullResult,
  deps: UpdateDeps,
): Promise<string[] | null> {
  const r = await deps.run("git", ["diff", "--name-only", `${pulled.before}..${pulled.after}`], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (r.missing || r.code !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * The services a change set touches: those whose folder holds a changed file, and every Python
 * service when a file directly under `workers/` changed. hostd's, which a remote update uses too.
 */
export { servicesChangedBy };

export interface ServicePlanInput {
  /** Enabled services in start order, with what is true of each. */
  services: ReadonlyArray<{ name: string; stale: boolean; running: boolean; changed: boolean }>;
}

export interface ServiceUpdatePlan {
  /** Synced while it is not running. */
  syncStopped: string[];
  /** Running and stale: stopped (through the guard), synced, started. */
  syncAndRestart: string[];
  /** Running and only its folder changed: restarted. */
  restart: string[];
}

/** What `update` does to the services, before it does it. */
export function planServiceUpdate(input: ServicePlanInput): ServiceUpdatePlan {
  const plan: ServiceUpdatePlan = { syncStopped: [], syncAndRestart: [], restart: [] };
  for (const s of input.services) {
    if (s.stale && !s.running) plan.syncStopped.push(s.name);
    else if (s.stale) plan.syncAndRestart.push(s.name);
    else if (s.running && s.changed) plan.restart.push(s.name);
  }
  return plan;
}

async function install(root: string, deps: UpdateDeps, force: boolean, dryRun: boolean) {
  if (!force && !installNeeded(root)) {
    ok(t.update.depsCurrent);
    return;
  }
  if (dryRun) {
    note(t.update.wouldInstall);
    return;
  }
  note(t.update.installing);
  const r = await deps.run("pnpm", ["install"], { cwd: root, timeoutMs: BUILD_TIMEOUT_MS });
  if (r.code !== 0) {
    fail(t.update.installFailed);
    for (const l of failureTail(r.stdout, r.stderr)) println(l);
    throw new UpdateError(t.update.installAborted);
  }
  ok(t.update.depsInstalled);
}

/** Builds one target; a Vite build goes to `<dist>.next` and replaces `dist` only on success. */
export async function buildTarget(target: BuildTarget, deps: UpdateDeps): Promise<boolean> {
  const next = target.swapDir ? `${target.swapDir}.next` : null;
  const withOut = (a: string[]) => (next ? [...a, "--outDir", basename(next), "--emptyOutDir"] : a);
  note(t.update.building(target.label));
  let r = await deps.run(target.command, withOut(target.args), {
    cwd: target.cwd,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  if (r.code !== 0 && target.fallbackArgs) {
    // Antivirus holding esbuild's temp file is the usual cause; the retry skips the minifier.
    warn(t.update.buildRetry(target.label));
    r = await deps.run(target.command, withOut(target.fallbackArgs), {
      cwd: target.cwd,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  }
  if (r.code !== 0) {
    fail(t.update.buildFailed(target.label, r.timedOut));
    for (const l of failureTail(r.stdout, r.stderr)) println(l);
    if (next) rmSync(next, { recursive: true, force: true });
    return false;
  }
  if (next && target.swapDir) {
    if (!existsSync(join(next, "index.html"))) {
      fail(t.update.noIndexHtml(target.label));
      rmSync(next, { recursive: true, force: true });
      return false;
    }
    const previous = `${target.swapDir}.prev`;
    try {
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(target.swapDir)) renameSync(target.swapDir, previous);
      renameSync(next, target.swapDir);
      rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      fail(t.update.swapFailed(target.label, (error as Error).message));
      note(t.update.swapHint(next));
      return false;
    }
  }
  ok(t.update.built(target.label));
  return true;
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

async function updateMod(
  root: string,
  config: Config,
  deps: UpdateDeps,
  options: UpdateOptions,
): Promise<boolean> {
  const mod = modInfo(root);
  if (!mod) return true;
  let good = true;
  const state = modFreshness(mod);
  if (options.force || state.state !== "fresh") {
    if (options.dryRun) {
      note(t.update.wouldBuildMod);
    } else {
      const jdk = await findJdk21(deps.run, deps.env, deps.platform);
      if (!jdk.jdk21?.home) {
        fail(t.update.modNoJdk(t.stack.checks.jdkMissing(jdk.onPath)));
        println(dim(t.update.modJdkFix));
        return false;
      }
      note(t.update.buildingMod(jdk.jdk21.home));
      const gradle = deps.platform === "win32" ? "gradlew.bat" : "./gradlew";
      const r = await deps.run(gradle, ["build"], {
        cwd: mod.dir,
        env: { ...deps.env, JAVA_HOME: jdk.jdk21.home },
        timeoutMs: 20 * 60_000,
      });
      if (r.code !== 0 || !existsSync(mod.jar)) {
        fail(t.update.modBuildFailed);
        for (const l of failureTail(r.stdout, r.stderr)) println(l);
        return false;
      }
      ok(t.update.modBuilt);
    }
  } else {
    ok(t.update.modCurrent);
  }

  const mods = minecraftModsDir(config);
  if (!mods) return good;
  if (options.dryRun) {
    note(t.update.wouldCopyMod(mods));
    return good;
  }
  if (!existsSync(mod.jar)) return good;
  const installed = installedModJars(mods);
  if (installed.length === 1 && sameFile(installed[0] as string, mod.jar)) {
    ok(t.update.modSame);
    return good;
  }
  const backupDir = join(dirname(mods), "miyoria-backup", timestamp(deps.now()));
  const what =
    installed.length === 0
      ? t.update.askCopy(basename(mod.jar), mods)
      : t.update.askReplace(
          basename(mod.jar),
          mods,
          t.common.list(installed.map((p) => basename(p))),
          backupDir,
        );
  if (!(await deps.confirm(what))) {
    warn(t.update.modNotConfirmed);
    return good;
  }
  try {
    if (installed.length > 0) {
      mkdirSync(backupDir, { recursive: true });
      for (const p of installed) copyFileSync(p, join(backupDir, basename(p)));
    }
    copyFileSync(mod.jar, join(mods, basename(mod.jar)));
    // Two bridge jars would both claim the mod id; the old ones are in the backup.
    for (const p of installed) {
      if (basename(p) !== basename(mod.jar)) unlinkSync(p);
    }
    ok(t.update.modUpdated(installed.length > 0 ? backupDir : null));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    fail(
      t.update.copyFailed(code ?? (error as Error).message, code === "EBUSY" || code === "EPERM"),
    );
    good = false;
  }
  return good;
}

/**
 * The services part: sync the stale environments, then restart what changed, one at a time. Returns
 * the number of failures. Does nothing without a host.toml.
 */
export async function updateServices(
  configPath: string,
  options: UpdateOptions,
  deps: UpdateDeps,
  pulled: { root: string; files: string[] | null } | null,
): Promise<number> {
  const target = hostTarget(configPath, options.hostConfig);
  if (!existsSync(target.hostToml)) {
    note(t.update.noHostToml);
    return 0;
  }
  const host = loadHost(target);
  const root = catalogRoot(target.hostToml);
  const catalog = loadCatalog(root);
  const installDeps = { ...deps.services?.install, root };
  const enabled = Object.entries(host.config.services)
    .filter(([name, s]) => s.enabled && catalog.services.has(name))
    .map(([name]) => catalog.services.get(name) as CatalogEntry);

  const client = await HostdClient.connect(host.state.root);
  const listed: HostServiceList["services"] =
    client === null ? [] : (await client.call<HostServiceList>("service.list")).services;
  const running = new Set(
    listed.filter((s) => s.state === "running" || s.state === "starting").map((s) => s.name),
  );
  // Start order: the daemon's list when there is one, else host.toml's.
  const order = listed.length > 0 ? listed.map((s) => s.name) : enabled.map((e) => e.name);
  const changed =
    pulled?.files != null
      ? servicesChangedBy(pulled.files, enabled, pulled.root)
      : new Set<string>();

  const stale = new Set<string>();
  for (const entry of enabled) {
    const inspected = inspectService(entry, host, installDeps);
    if (inspected.runtime.kind !== "managed") continue;
    if (options.force || inspected.runtime.state?.state !== "ready") stale.add(entry.name);
  }
  // The model files of `[[install.files]]` that are missing or wrong: asked about after the
  // environments, once for all of them.
  const needs = await filesToFetch(enabled, host);
  const plan = planServiceUpdate({
    services: order
      .filter((name) => enabled.some((e) => e.name === name))
      .map((name) => ({
        name,
        stale: stale.has(name),
        running: running.has(name),
        changed: changed.has(name),
      })),
  });

  section(t.update.servicesSection);
  const nothing = plan.syncStopped.length + plan.syncAndRestart.length + plan.restart.length === 0;
  if (nothing && client === null && needs.length === 0) {
    ok(t.update.envsCurrent);
    return 0;
  }
  if (options.dryRun) {
    if (plan.syncStopped.length > 0) note(t.update.wouldSync(t.common.list(plan.syncStopped)));
    if (plan.syncAndRestart.length > 0) {
      note(t.update.wouldStopSyncStart(t.common.list(plan.syncAndRestart)));
    }
    if (plan.restart.length > 0) note(t.update.wouldRestart(t.common.list(plan.restart)));
    if (nothing) ok(t.update.envsCurrent);
    if (needs.length > 0) {
      printFileNeeds(needs, host.state.models);
      note(t.update.asksFirst);
    }
    return 0;
  }

  const installer = await openInstaller(target, host, deps.services);
  let failures = 0;
  const later: string[] = [];

  // Stopped services: one call; a running daemon also reads the descriptors again for them.
  const stopped = enabled.map((e) => e.name).filter((name) => !running.has(name));
  if (stopped.length > 0 && (plan.syncStopped.length > 0 || client !== null)) {
    try {
      const done = await installer.update(
        { services: stopped, ...(options.force ? { force: true } : {}) },
        progressPrinter(),
      );
      for (const r of done.services) {
        if (r.runtime.state === "current") continue;
        if (printInstall(r, { brief: true })) failures += 1;
      }
    } catch (error) {
      failures += 1;
      fail(rpcText(error));
    }
  }

  const syncOne = async (name: string): Promise<boolean> => {
    try {
      const result = await installer.install(
        { service: name, only_stale: !options.force, no_files: true },
        progressPrinter(),
      );
      return !printInstall(result, { brief: true });
    } catch (error) {
      fail(`${name}  ${rpcText(error, name)}`);
      return false;
    }
  };

  const logs = host.state.logs;
  const restartOne = async (name: string, how: "restart" | "stop-sync-start"): Promise<void> => {
    if (client === null) return;
    try {
      if (how === "restart") {
        await client.call(
          "service.restart",
          { service: name, force: false },
          { timeoutMs: 120_000 },
        );
      } else {
        // A running Python cannot be overwritten on Windows: stop it first, through the guard.
        await client.call("service.stop", { service: name, force: false }, { timeoutMs: 120_000 });
        if (!(await syncOne(name))) failures += 1;
        await client.call("service.start", { service: name });
      }
    } catch (error) {
      if (error instanceof HostRpcError && error.code === HOST_ERROR_CODE.Guarded) {
        warn(t.update.guarded(bold(name), error.message));
        later.push(name);
        return;
      }
      failures += 1;
      fail(`${name}  ${rpcText(error, name)}`);
      return;
    }
    const watched = await watchStarts(client, [name], logs, 10 * 60_000);
    if (watched.failed.length > 0) failures += 1;
  };

  for (const name of [...plan.syncAndRestart, ...plan.restart]) {
    if (options.noRestart) {
      if (plan.syncAndRestart.includes(name) && !(await syncOne(name))) failures += 1;
      later.push(name);
      continue;
    }
    await restartOne(name, plan.syncAndRestart.includes(name) ? "stop-sync-start" : "restart");
  }

  // The model files, after the environments: a service left busy above is left for later.
  const fileNeeds = needs.filter((n) => !later.includes(n.service));
  if (fileNeeds.length > 0) {
    let agreed = false;
    let refused = false;
    try {
      agreed = await confirmFiles(fileNeeds, host, deps.services ?? {}, "miyoria update --yes");
    } catch (error) {
      if (!(error instanceof HostCommandError)) throw error;
      fail(error.message);
      failures += 1;
      refused = true;
    }
    if (agreed) {
      for (const name of [...new Set(fileNeeds.map((n) => n.service))]) {
        try {
          const result = await installer.install(
            { service: name, only_stale: true },
            progressPrinter(),
          );
          const bad = printInstall(result, { brief: true });
          printFiles(result);
          if (bad) failures += 1;
        } catch (error) {
          failures += 1;
          fail(`${name}  ${rpcText(error, name)}`);
        }
      }
    } else if (!refused) {
      note(t.update.filesSkipped);
    }
  }

  if (later.length > 0) {
    const names = t.common.list(later);
    const commands = t.common.list(later.map((n) => `\`miyoria restart ${n}\``));
    warn(
      options.noRestart
        ? t.update.notRestarted(names, commands)
        : t.update.busyNotRestarted(names, commands),
    );
  }
  if (nothing) ok(t.update.envsCurrent);
  return failures;
}

export async function run(
  configPath: string,
  options: UpdateOptions,
  deps: UpdateDeps,
): Promise<void> {
  const root = repoRoot(configPath);
  if (!root) {
    // A packaged install: the package manager upgrades the code; the services part still runs.
    note(t.update.upgradeHint);
    const failures = await updateServices(configPath, options, deps, null);
    if (failures > 0) throw new UpdateError(t.update.incomplete(failures));
    return;
  }
  const config = await loadConfig(configPath);
  const configDir = dirname(resolve(configPath));
  if (options.dryRun) section(t.update.planTitle);

  let failures = 0;
  const pulled = options.noPull ? null : await pull(root, deps, options.dryRun === true);
  const files = pulled === null ? null : await changedFiles(root, pulled, deps);
  await install(root, deps, options.force === true, options.dryRun === true);

  for (const target of buildTargets(root, configDir, config)) {
    const f = checkTarget(target);
    const skip = !options.force && f.state === "missing" && target.configured === false;
    if (!options.force && (f.state === "fresh" || skip)) {
      ok(`${target.label}  ${skip ? t.update.unusedSkipped : f.detail}`);
      continue;
    }
    if (options.dryRun) {
      note(
        t.update.wouldBuild(
          target.label,
          f.state === "stale" ? f.detail : t.update.notBuilt,
          `${target.command} ${target.args.join(" ")}`,
        ),
      );
      continue;
    }
    if (!(await buildTarget(target, deps))) failures++;
  }

  if (!options.skipMod && !(await updateMod(root, config, deps, options))) failures++;

  failures += await updateServices(
    configPath,
    options,
    deps,
    pulled === null ? null : { root, files },
  );

  if (failures > 0) throw new UpdateError(t.update.incomplete(failures));
  if (!options.dryRun) {
    println(`\n${options.noRestart ? t.update.doneNoRestart : t.update.done}`);
  }
}
