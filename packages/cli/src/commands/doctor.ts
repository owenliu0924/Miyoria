// `miyoria doctor`: checks everything needed to run, one line per check. Core's own checks (config,
// profile, LLM, Discord, database) come first; then, for every service enabled in host.toml, what
// its descriptor says it needs (docs/design/v5-hostd.md §9). `--fix` does only the safe part: sync a
// missing or stale environment and download missing or wrong `install.files` (listed and asked
// once). `--print-hashes <service>` prints the checksums of the files a machine has, for the
// descriptor.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative } from "node:path";
import type { HostInfo } from "@miyoria/contracts/host";
import { databaseUrl, loadProfile, resolveDatabaseUrl } from "@miyoria/core/light";
import {
  type CatalogEntry,
  HostdClient,
  type LoadedHostConfig,
  loadCatalog,
  presentFileHashes,
  probePort,
  tcpConnect,
} from "@miyoria/hostd";
import { Config, configureLogging, errorMessage } from "@miyoria/runtime/kernel";
import { cliVersion } from "../assets.js";
import { t } from "../i18n/index.js";
import {
  buildChecks,
  type DeepDeps,
  type DeepInput,
  type Finding,
  fail as failFinding,
  ok as okFinding,
  portChecks,
  tempChecks,
  writableProbe,
} from "../stack/checks.js";
import { repoRoot } from "../stack/config.js";
import {
  type HostCheckInput,
  healthChecks,
  hostdChecks,
  listenersOf,
  serviceChecks,
  vramChecks,
} from "../stack/host-checks.js";
import { defaultRunner } from "../stack/system.js";
import { dim, green, note, println, red, yellow } from "../ui.js";
import {
  catalogRoot,
  HostCommandError,
  type HostTarget,
  hostTarget,
  loadHost,
  rpcText,
} from "./host.js";
import {
  confirmFiles,
  filesToFetch,
  openInstaller,
  printFiles,
  printInstall,
  progressPrinter,
  type ServiceDeps,
} from "./services.js";

/** Discord application flags for the message content intent. */
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const GATEWAY_PRESENCE = 1 << 12;
const GATEWAY_PRESENCE_LIMITED = 1 << 13;
const GATEWAY_GUILD_MEMBERS = 1 << 14;
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;

export class DoctorError extends Error {
  override readonly name = "DoctorError";
}

export interface DoctorOptions {
  /** Also check the install: imports, ports, health, builds, GPU memory, temp files. */
  deep?: boolean;
  /** Only the install checks; no LLM, Discord or database round trips. Implies `deep`. */
  stackOnly?: boolean;
  /** Sync missing or stale environments and download missing files, then check. */
  fix?: boolean;
  /** `--host-config`: the host.toml of this machine (default: next to the config file). */
  hostConfig?: string;
  /** Replaces the system seams in tests. */
  deps?: DeepDeps;
  /** The installer's seams (tests), and how the download question is answered. */
  services?: ServiceDeps;
  /** Print the SHA-256 and size of this service's files on this machine, and nothing else. */
  printHashes?: string;
}

function realDeps(): DeepDeps {
  return {
    platform: process.platform,
    run: defaultRunner,
    probe: probePort,
    fetchImpl: fetch,
    env: process.env,
    tmpdir: tmpdir(),
    version: cliVersion(),
    connect: tcpConnect,
  };
}

function printFinding(f: Finding): void {
  const mark = f.level === "ok" ? green("✓") : f.level === "warn" ? yellow("!") : red("✗");
  println(`${mark} ${f.what}  ${f.detail}`);
  for (const line of f.fix ?? []) println(dim(t.doctor.fix(line)));
}

/** The host.toml side of the checks: loaded once, with the daemon's answer. */
interface HostSide {
  target: HostTarget;
  host: LoadedHostConfig;
  entries: CatalogEntry[];
  root: string;
  daemon: HostInfo | null;
}

async function loadHostSide(target: HostTarget): Promise<HostSide> {
  const host = loadHost(target);
  const root = catalogRoot(target.hostToml);
  const catalog = loadCatalog(root);
  const entries = Object.entries(host.config.services)
    .filter(([, s]) => s.enabled)
    .map(([name]) => catalog.services.get(name))
    .filter((e): e is CatalogEntry => e !== undefined);
  let daemon: HostInfo | null = null;
  try {
    const client = await HostdClient.connect(host.state.root);
    if (client !== null) daemon = await client.call<HostInfo>("host.info");
  } catch {
    daemon = null;
  }
  return { target, host, entries, root, daemon };
}

function hostInput(side: HostSide, deps: DeepDeps, options: DoctorOptions): HostCheckInput {
  return {
    host: side.host,
    entries: side.entries,
    deps,
    ...(options.services?.install !== undefined ? { install: options.services.install } : {}),
    root: side.root,
    daemon: side.daemon,
    deep: options.deep === true || options.stackOnly === true,
  };
}

/**
 * `--fix`: sync what is missing or stale and download the missing or wrong `install.files` (listed
 * with sizes and licences and asked once). Returns the failures.
 */
async function applyFixes(side: HostSide, deps: DeepDeps, options: DoctorOptions): Promise<number> {
  const input = hostInput(side, deps, options);
  const { inspectService } = await import("@miyoria/hostd");
  let failures = 0;
  const needs = await filesToFetch(side.entries, side.host);
  let download = false;
  try {
    download = await confirmFiles(
      needs,
      side.host,
      options.services ?? {},
      "miyoria doctor --fix --yes",
    );
  } catch (error) {
    if (!(error instanceof HostCommandError)) throw error;
    println(`${red("✗")} ${error.message}`);
    failures += 1;
  }
  const installer = await openInstaller(side.target, side.host, options.services);
  let any = false;
  for (const entry of side.entries) {
    const found = inspectService(entry, side.host, {
      ...input.install,
      root: side.root,
      platform: deps.platform,
      env: deps.env,
    });
    const envNeedsSync = found.runtime.kind === "managed" && found.runtime.state?.state !== "ready";
    const getFiles = download && needs.some((n) => n.service === entry.name);
    if (!envNeedsSync && !getFiles) continue;
    any = true;
    println(`\n${t.doctor.fixing(entry.name)}`);
    try {
      const result = await installer.install(
        { service: entry.name, only_stale: true, ...(getFiles ? {} : { no_files: true }) },
        progressPrinter(),
      );
      const bad = printInstall(result, { brief: true });
      if (getFiles) printFiles(result);
      if (bad) failures += 1;
    } catch (error) {
      failures += 1;
      println(`${red("✗")} ${entry.name}  ${rpcText(error, entry.name)}`);
    }
  }
  if (!any) println(dim(`\n${t.doctor.nothingToFix}`));
  return failures;
}

/**
 * `--print-hashes <service>`: the SHA-256 and size of the service's files on this machine, in
 * `service.toml` syntax, to fill in an `[[install.files]]` entry that waits for them. Its
 * `install.manual` items are included (a folder file by file), so a file placed by hand can move
 * to the automatic list. It reads files only.
 */
export async function printHashes(target: HostTarget, service: string): Promise<void> {
  const host = loadHost(target);
  const root = catalogRoot(target.hostToml);
  const entry = loadCatalog(root).services.get(service);
  if (entry === undefined) throw new DoctorError(t.doctor.unknownService(service));
  const { files, skipped } = await presentFileHashes(entry, host, root);
  const descriptor = relative(root, entry.file).replaceAll("\\", "/");
  println(`# ${service}:這台電腦上現有檔案的 SHA-256 和大小`);
  println(
    `# 把 sha256 和 size 抄進 ${descriptor} 對應的 [[install.files]];hf 的 revision 要另外查 commit`,
  );
  for (const f of files) {
    println("");
    println(`# ${f.file}${f.from === "install.files" ? "" : `(install.manual ${f.from})`}`);
    println(`path = ${JSON.stringify(f.path)}`);
    println(`sha256 = "${f.sha256}"`);
    println(`size = ${f.size}`);
  }
  for (const s of skipped) {
    println("");
    println(`# 略過 ${s.path}:${s.why}`);
  }
  if (files.length === 0) println("\n# 這台電腦上沒有這個服務的檔案");
}

/** Prints the install findings; returns how many failed. */
async function installReport(
  config: Config,
  configPath: string,
  deps: DeepDeps,
  side: HostSide | null,
  options: DoctorOptions,
): Promise<number> {
  const deep = options.deep === true || options.stackOnly === true;
  const findings: Finding[] = [];
  const collect = async (label: string, group: () => Promise<Finding[]> | Finding[]) => {
    try {
      findings.push(...(await group()));
    } catch (error) {
      findings.push({
        level: "warn",
        what: t.doctor.check,
        detail: t.doctor.interrupted(label, error instanceof Error ? error.message : String(error)),
      });
    }
  };
  if (side !== null) {
    if (side.entries.length === 0) {
      note(t.doctor.noServicesEnabled);
    }
    const input = hostInput(side, deps, options);
    const groups = t.doctor.groups;
    await collect(groups.hostd, () => hostdChecks(input));
    await collect(groups.services, () => serviceChecks(input));
    if (deep) {
      await collect(groups.ports, () => portChecks({ deps }, listenersOf(input)));
      await collect(groups.health, () => healthChecks(input));
      await collect(groups.vram, () => vramChecks(input));
      await collect(groups.state, () => {
        const code = writableProbe(
          existsSync(side.host.state.root) ? side.host.state.root : dirname(side.host.state.root),
        );
        return [
          code === null
            ? okFinding(t.doctor.stateFolder, t.doctor.stateWritable(side.host.state.root))
            : failFinding(
                t.doctor.stateFolder,
                t.doctor.stateNotWritable(side.host.state.root, code),
                [t.doctor.stateFix],
              ),
        ];
      });
    }
  }
  if (deep) {
    const input: DeepInput = {
      config,
      configDir: dirname(configPath),
      root: repoRoot(configPath),
      deps,
    };
    await collect(t.doctor.groups.builds, () => buildChecks(input));
    await collect(t.doctor.groups.temp, () => tempChecks(input));
  }
  for (const f of findings) printFinding(f);
  return findings.filter((f) => f.level === "fail").length;
}

export async function run(configPath: string, options: DoctorOptions = {}): Promise<void> {
  // The checks print their own lines; module logs would only interleave with them.
  if (!process.env.MIYORIA_LOG_LEVEL) configureLogging({ level: "warn" });
  if (options.printHashes !== undefined) {
    await printHashes(hostTarget(configPath, options.hostConfig), options.printHashes);
    return;
  }
  let failures = 0;
  const report = (ok: boolean, what: string, detail: string) => {
    if (!ok) failures++;
    println(`${ok ? green("✓") : red("✗")} ${what}  ${detail}`);
  };
  const baseDir = dirname(configPath);

  let config: Config;
  try {
    config = await Config.load(configPath);
    report(true, t.doctor.configFile, configPath);
  } catch (error) {
    report(false, t.doctor.configFile, t.doctor.configFailed(errorMessage(error)));
    throw new DoctorError(t.doctor.cannotContinue);
  }

  const deps = options.deps ?? realDeps();
  const target = hostTarget(configPath, options.hostConfig);
  let side: HostSide | null = null;
  if (existsSync(target.hostToml)) {
    try {
      side = await loadHostSide(target);
    } catch (error) {
      report(false, "host.toml", errorMessage(error));
    }
  } else {
    note(t.doctor.noHostToml(target.hostToml));
  }

  if (options.fix && side !== null) {
    println(`\n${t.doctor.fixingTitle}`);
    failures += await applyFixes(side, deps, options);
    side = await loadHostSide(target);
  } else if (options.fix) {
    note(t.doctor.fixNeedsHostToml);
  }

  const runsCore = side === null || side.entries.some((e) => e.name === "core");
  if (options.stackOnly || !runsCore) {
    println(`\n${t.doctor.servicesTitle}`);
    failures += await installReport(config, configPath, deps, side, options);
    if (failures > 0) throw new DoctorError(t.doctor.failed(failures));
    println(`\n${options.stackOnly ? t.doctor.stackPassed : t.doctor.machineReady}`);
    return;
  }

  let profile: Awaited<ReturnType<typeof loadProfile>> | null = null;
  try {
    profile = await loadProfile(config, baseDir);
    report(
      true,
      t.doctor.profile,
      t.doctor.profileOk(profile.displayName, profile.sections.length),
    );
  } catch (error) {
    report(false, t.doctor.profile, errorMessage(error));
  }

  // The full core (every module package) is only loaded for the checks that need it.
  const core = await import("@miyoria/core");
  const { collectResponse, modelRefString, userMessage } = await import("@miyoria/llm/llm");

  if (profile) {
    try {
      const router = core.llmModule(config, profile).buildRouter();
      const chain = router.chain("chat");
      const started = performance.now();
      const stream = await router.stream(
        "chat",
        { messages: [userMessage("請只回答 OK")], max_tokens: 16 },
        AbortSignal.timeout(60_000),
      );
      const response = await collectResponse(stream);
      const first = chain[0] ? modelRefString(chain[0]) : "";
      report(
        true,
        "LLM",
        t.doctor.llmOk(first, response.text.trim(), t.common.int(performance.now() - started)),
      );
    } catch (error) {
      report(false, "LLM", errorMessage(error));
    }
  }

  const discord = config.module("platform.discord.bot");
  const section = discord.config;
  const token =
    section !== null &&
    typeof section === "object" &&
    !Array.isArray(section) &&
    typeof section.token === "string"
      ? section.token
      : "";
  if (!discord.enabled) report(true, "Discord", t.doctor.disabled);
  else if (token === "") report(false, "Discord", t.doctor.noDiscordToken);
  else {
    try {
      report(true, "Discord", await checkDiscord(token, fetch, wantsPresence(section)));
    } catch (error) {
      report(false, "Discord", errorMessage(error));
    }
  }

  const url = resolveDatabaseUrl(databaseUrl(config), baseDir);
  try {
    const store = await core.openStore(url);
    await store.close();
    report(true, t.doctor.database, redactUrl(url));
  } catch (error) {
    report(false, t.doctor.database, t.doctor.databaseFailed(redactUrl(url), errorMessage(error)));
  }

  if (side !== null || options.deep) {
    println(`\n${t.doctor.servicesTitle}`);
    failures += await installReport(config, configPath, deps, side, options);
  }

  if (failures > 0) throw new DoctorError(t.doctor.failed(failures));
  println(`\n${t.doctor.allPassed}`);
}

/**
 * `presenceIntents`: the bot asks for Presence and Server Members too (`presence_intents`, on by
 * default); Discord refuses the connection when they are not switched on in the Developer Portal.
 */
export async function checkDiscord(
  token: string,
  fetchImpl: typeof fetch = fetch,
  presenceIntents = false,
): Promise<string> {
  const response = await fetchImpl("https://discord.com/api/v10/applications/@me", {
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new DoctorError(t.doctor.discordStatus(response.status));
  const app = (await response.json()) as {
    name?: string;
    bot?: { username?: string };
    flags?: number;
  };
  const name = app.bot?.username ?? app.name ?? "?";
  const flags = app.flags ?? 0;
  if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) === 0) {
    throw new DoctorError(t.doctor.noMessageContent(name));
  }
  if (presenceIntents) {
    const missing = [
      (flags & (GATEWAY_PRESENCE | GATEWAY_PRESENCE_LIMITED)) === 0 ? "Presence Intent" : null,
      (flags & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED)) === 0
        ? "Server Members Intent"
        : null,
    ].filter((x): x is string => x !== null);
    if (missing.length > 0) {
      throw new DoctorError(t.doctor.missingIntents(name, t.common.list(missing)));
    }
  }
  return t.doctor.bot(name);
}

function wantsPresence(section: unknown): boolean {
  return !(
    section !== null &&
    typeof section === "object" &&
    !Array.isArray(section) &&
    (section as { presence_intents?: unknown }).presence_intents === false
  );
}

export function redactUrl(url: string): string {
  const scheme = url.indexOf("://");
  const at = url.lastIndexOf("@");
  return scheme !== -1 && at > scheme ? `${url.slice(0, scheme)}://***${url.slice(at)}` : url;
}
