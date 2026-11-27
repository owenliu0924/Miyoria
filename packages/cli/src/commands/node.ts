// Commands that run a node in this process (`core`, `chat`, `stage`, `ext dev`) and the offline
// profile / extension tools. The full core is imported lazily so `init` / `config` start fast.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type CoreLogLevel,
  loadProfile,
  logFilter,
  logLevel,
  type MachineSource,
  machineSource,
  type ResolvedProfile,
} from "@miyoria/core/light";
import { Config, configureLogging, getLogger } from "@miyoria/runtime/kernel";
import { isJsonObject, RunningProfileKey } from "@miyoria/types";
import { PACKAGE_ROOT } from "../assets.js";
import { t } from "../i18n/index.js";
import { profileLine } from "../profile.js";
import { fail, ok, println, warn } from "../ui.js";

export class NodeCommandError extends Error {
  override readonly name = "NodeCommandError";
}

/** Loads `miyoria.toml` (after `.env` was loaded by `main`). */
export async function loadConfig(configPath: string): Promise<Config> {
  if (!existsSync(configPath)) {
    throw new NodeCommandError(t.node.noConfig(configPath));
  }
  return Config.load(configPath);
}

function setLogLevel(config: Config, fallback?: CoreLogLevel): void {
  if (process.env.MIYORIA_LOG_LEVEL) return;
  configureLogging({ level: fallback ?? logLevel(logFilter(config)) });
}

/**
 * Points `MIYORIA_PANEL_DIR` at the panel bundled with the npm package (`dist/panel`) when
 * neither the variable nor `[modules.api] panel_dir` leads to a built panel.
 */
function preferBundledPanel(config: Config): void {
  if (process.env.MIYORIA_PANEL_DIR?.trim()) return;
  const section = config.module("api").config;
  const configured =
    isJsonObject(section) && typeof section.panel_dir === "string"
      ? section.panel_dir
      : "apps/panel/dist";
  if (configured.trim() === "" || existsSync(join(configured, "index.html"))) return;
  const bundled = join(PACKAGE_ROOT, "dist", "panel");
  if (existsSync(join(bundled, "index.html"))) process.env.MIYORIA_PANEL_DIR = bundled;
}

/**
 * Where a core for `profile` resolves its relative paths, whether the profile has its own data,
 * and for one that does, where the install's machines are (docs/design/v5-profiles.md); without a
 * profile, the config file's folder as always.
 */
function profileOptions(
  configPath: string,
  profile: ResolvedProfile | undefined,
): { baseDir: string; ownProfile: boolean; machines: MachineSource | null } {
  return {
    baseDir: profile?.baseDir ?? dirname(resolve(configPath)),
    ownProfile: profile?.own ?? false,
    machines: profile === undefined ? null : machineSource(profile, (name) => process.env[name]),
  };
}

export async function core(configPath: string, profile?: ResolvedProfile): Promise<void> {
  const config = await loadConfig(configPath);
  setLogLevel(config);
  preferBundledPanel(config);
  const { buildCore, runUntilSignal } = await import("@miyoria/core");
  const node = await buildCore(config, profileOptions(configPath, profile));
  if (profile !== undefined) {
    getLogger("cli").info(
      { profile: profile.id, own: profile.own, config: profile.configPath },
      `running ${profileLine(profile, node.services.get(RunningProfileKey)?.character ?? profile.id)}`,
    );
  }
  await runUntilSignal(node);
}

export async function chat(
  configPath: string,
  name: string,
  withDiscord: boolean,
  profile?: ResolvedProfile,
): Promise<void> {
  const config = await loadConfig(configPath);
  // Keep the terminal readable: only warnings unless MIYORIA_LOG_LEVEL says otherwise.
  setLogLevel(config, "warn");
  const { buildCore, runUntilSignal } = await import("@miyoria/core");
  const node = await buildCore(config, {
    ...profileOptions(configPath, profile),
    cliChatName: name,
    discord: withDiscord,
    api: false,
  });
  println(t.node.chatting(node.profileDisplayName));
  await runUntilSignal(node);
}

export async function stage(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  setLogLevel(config);
  const { runStageNode, shutdownSignal } = await import("@miyoria/core");
  const controller = new AbortController();
  void shutdownSignal().then(() => controller.abort());
  const bundled = join(PACKAGE_ROOT, "dist", "overlay");
  await runStageNode(config, {
    baseDir: dirname(resolve(configPath)),
    signal: controller.signal,
    // The npm package ships the overlay; from the repo the default `apps/overlay/dist` applies.
    ...(!existsSync("apps/overlay/dist/index.html") && existsSync(join(bundled, "index.html"))
      ? { overlayDir: bundled }
      : {}),
  });
}

export interface StageObsSetupFlags {
  dryRun: boolean;
  relayout: boolean;
  /** `--here`: build in OBS's current scene collection. */
  here: boolean;
  /** `--no-profile`: keep OBS's current profile. */
  noProfile: boolean;
  /** `--profile-settings`: set the video size and replay buffer in an existing profile too. */
  profileSettings: boolean;
  /** `--collection` / `--profile` (`null` = `[stage.obs]`'s, else `Miyoria`). */
  collection: string | null;
  profile: string | null;
}

export async function stageObsSetup(configPath: string, flags: StageObsSetupFlags): Promise<void> {
  if (flags.here && flags.collection !== null) {
    throw new NodeCommandError(t.node.hereOrCollection);
  }
  if (flags.noProfile && (flags.profile !== null || flags.profileSettings)) {
    throw new NodeCommandError(t.node.noProfileConflict);
  }
  const config = await loadConfig(configPath);
  configureLogging({ level: "warn" });
  const { describeObsSetupStep: describeStep, setupStageObs } = await import("@miyoria/core");
  const { dryRun } = flags;
  const result = await setupStageObs(config, {
    baseDir: dirname(resolve(configPath)),
    dryRun,
    relayout: flags.relayout,
    collection: flags.here ? null : (flags.collection ?? undefined),
    profile: flags.noProfile ? null : (flags.profile ?? undefined),
    profileSettings: flags.profileSettings,
    onStep: (step) => println(t.node.obsStep(describeStep(step), dryRun)),
  });
  const { steps, place } = result;
  const changes = steps.filter((s) => s.op !== "write_mask" && s.op !== "filter");
  const where = t.node.obsWhere(result.collection, result.profile);
  if (result.layoutUnknown) {
    println(t.node.layoutUnknown(result.collection));
  }
  if (dryRun) {
    const same = place.length === 0 && changes.length === 0 && !result.layoutUnknown;
    ok(t.node.obsPreview(same ? null : place.length + steps.length, where));
  } else {
    ok(
      place.length === 0 && changes.length === 0
        ? t.node.obsUnchanged(where)
        : t.node.obsBuilt(where, place.length + steps.length),
    );
  }
  for (const note of result.notes) warn(note);
  if (result.createdProfile) {
    warn(t.node.newProfileEmpty(result.profile));
  }
  // The name of the source `stage` makes for the model (packages/stage/src/obs-setup.ts).
  warn(t.node.vtubeTransparent("VTube Studio 透明"));
  // The Stage checks OBS's collection with this: suggest it, the config file is the owner's.
  const lines: string[] = [];
  if (!flags.here && result.configured.collection !== result.collection) {
    lines.push(`collection = ${JSON.stringify(result.collection)}`);
  }
  if (!flags.noProfile && result.configured.profile !== result.profile) {
    lines.push(`profile = ${JSON.stringify(result.profile)}`);
  }
  if (lines.length > 0) {
    println();
    println(t.node.addToStageObs);
    println("  [stage.obs]");
    for (const line of lines) println(`  ${line}`);
  }
  if (
    flags.here &&
    result.configured.collection !== null &&
    result.configured.collection !== result.collection
  ) {
    warn(t.node.collectionMismatch(result.configured.collection, result.collection));
  }
}

export async function profileValidate(
  configPath: string,
  running?: ResolvedProfile,
): Promise<void> {
  const config = await loadConfig(configPath);
  const profile = await loadProfile(config, profileOptions(configPath, running).baseDir);
  ok(
    t.node.profileSummary(
      `${profile.character.name} · ${profile.displayName}`,
      profile.id,
      profile.sections.length,
      profile.examples.length,
      Boolean(profile.voice),
      Boolean(profile.avatar),
    ),
  );
}

// ---- extensions --------------------------------------------------------------------------

export async function extNew(name: string, dir: string): Promise<void> {
  const { extensionsCli } = await import("@miyoria/core");
  // Inside the monorepo link the local SDK; elsewhere use the published one.
  const sdk = existsSync(join(process.cwd(), "packages/sdk/package.json"))
    ? "workspace:*"
    : "^0.3.0";
  const path = await extensionsCli.newExtension(dir, name, { sdk, id: null });
  ok(t.node.created(path));
}

export async function extList(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const { extensionsCli } = await import("@miyoria/core");
  for (const e of await extensionsCli.list(config, process.cwd())) {
    const id = e.manifest?.id ?? "?";
    const version = e.manifest?.version ?? "?";
    const mark = e.problems.length > 0 ? "✗" : e.enabled && e.runs_on_core ? "●" : "○";
    println(`${mark} ${id} ${version}  ${e.dir}`);
    for (const p of e.problems) println(`    ${p}`);
  }
}

export async function extInstall(configPath: string, source: string): Promise<void> {
  const config = await loadConfig(configPath);
  const { extensionsCli } = await import("@miyoria/core");
  const installed = await extensionsCli.install(config, process.cwd(), source);
  ok(t.node.installed(installed.id, installed.dir));
  for (const w of installed.warnings) warn(w);
}

export async function extValidate(dir: string): Promise<void> {
  const { extensionsCli } = await import("@miyoria/core");
  const v = await extensionsCli.validate(dir);
  for (const w of v.warnings) warn(w);
  for (const e of v.errors) fail(e);
  if (v.errors.length > 0) throw new NodeCommandError(t.node.errors(v.errors.length));
  ok(t.node.manifestValid);
}

export async function extDev(configPath: string): Promise<void> {
  const loaded = await loadConfig(configPath);
  const raw = structuredClone(loaded.raw);
  if (isJsonObject(raw)) {
    const modules = isJsonObject(raw.modules) ? raw.modules : {};
    const extensions = isJsonObject(modules.extensions) ? modules.extensions : {};
    extensions.dev = true;
    modules.extensions = extensions;
    raw.modules = modules;
  }
  const config = Config.fromValue(raw);
  setLogLevel(config);
  const { buildCore, runUntilSignal } = await import("@miyoria/core");
  const node = await buildCore(config, { baseDir: dirname(resolve(configPath)) });
  await runUntilSignal(node);
}

/** Reads `file`, or stdin for `-`. */
export async function readInput(file: string): Promise<string> {
  if (file !== "-") return readFileSync(file, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}
