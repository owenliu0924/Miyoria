// `miyoria init`: guided setup. The first question is what this machine is for (docs/design/
// v5-hostd.md §11): text chat only (Core, no GPU), text and voice (Core with the speech workers),
// or services for somebody else's Core. The first two write `miyoria.toml`, `.env`, the profile
// and a `host.toml` with the services of this machine; the third writes only `host.toml`. No
// address of a worker is written anywhere: Core finds the services through hostd.
//
// Safe to re-run: every question defaults to the current value, secrets are only replaced when
// typed, existing tokens are kept, missing files start from the bundled templates (and the bundled
// profile is copied), and nothing is written before the summary is confirmed.

import { join, relative, resolve } from "node:path";
import { type Catalog, HOST_CONFIG_FILE, loadCatalog } from "@miyoria/hostd";
import { bundledProfilesDir, exampleConfig, exampleEnv } from "../assets.js";
import { enabledServices, type HostTomlPlan, planHostToml, writeHostToml } from "../host-toml.js";
import { t } from "../i18n/index.js";
import type { Prompter } from "../prompt.js";
import * as settings from "../settings.js";
import { configSchema } from "../validate.js";
import { Workspace, type WorkspaceOptions } from "../workspace.js";
import { afterWrite, commit, type ExtraWrite } from "./config.js";
import { catalogRoot } from "./host.js";

/** What a machine is for: the answer of the first question. */
export type InitMode = "text" | "voice" | "service";

export const INIT_MODES: readonly InitMode[] = ["text", "voice", "service"];

/** The services `voice` adds besides Core (the voice node and singing come later). */
export const VOICE_SERVICES: readonly string[] = ["asr", "tts", "turn"];

/** Services that are not offered to somebody else's Core: Core and Stage run with the owner. */
const NOT_OFFERED: ReadonlySet<string> = new Set(["core", "stage", "voice-node"]);

export interface InitOptions {
  /** Skip the final confirmation. */
  yes?: boolean;
  /** Where bundled profiles come from (default: the package's). */
  bundledProfiles?: string | null;
  /** The real environment (tests). */
  processEnv?: ReadonlyMap<string, string>;
  /** Command prefix shown in the next steps (default: `commandPrefix()`, from how it was started). */
  command?: string;
  /** What this machine is for; absent: the first question asks. */
  mode?: InitMode;
  /** For `service`: the services this machine offers; absent: the question asks. */
  services?: string[];
  /** The `host.toml` to write (default: next to the config file). */
  hostToml?: string;
  /** Where the service descriptors are (default: where `miyoria add` looks). */
  catalogRoot?: string;
}

/** All questions of a machine that runs Core, editing `ws` in memory. Returns the generated tokens. */
export async function flow(p: Prompter, ws: Workspace): Promise<string[]> {
  // The answers are checked by the root schema, which loads every module package: start now.
  void configSchema();
  p.section(t.init.sections.profile);
  await settings.profileStep(p, ws);

  p.section(t.init.sections.llm);
  await settings.llmStep(p, ws, false);

  p.section(t.init.sections.discord);
  await settings.ask(p, ws, settings.DISCORD_TOKEN);
  await settings.ask(p, ws, settings.OWNER);

  p.section(t.init.sections.database);
  await settings.databaseStep(p, ws);

  p.section(t.init.sections.panel);
  await settings.oauthStep(p, ws, true);

  return settings.ensureTokens(ws);
}

/** The workspace `init` edits: existing files, or the bundled templates. */
export function openForInit(configPath: string, options: WorkspaceOptions = {}): Workspace {
  return Workspace.openOrCreate(configPath, exampleConfig(), exampleEnv(), options);
}

/**
 * How the user reaches this CLI again, from what the package manager that started it left in the
 * environment: `pnpm exec` and `npx` set `npm_command` to `exec`; `pnpm dlx` sets only the user
 * agent. Anything else (a global install, a script of the repository) is plain `miyoria`.
 */
export function commandPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const pnpm = (env.npm_config_user_agent ?? "").startsWith("pnpm/");
  if (env.npm_command === "exec") return pnpm ? "pnpm exec miyoria" : "npx miyoria";
  if (pnpm && env.npm_command === undefined) return "pnpm dlx miyoria";
  return "miyoria";
}

/** The catalog's services a machine can offer to a Core elsewhere, with what each costs. */
function offered(catalog: Catalog): Array<{ name: string; label: string }> {
  return [...catalog.services.values()]
    .filter((e) => !NOT_OFFERED.has(e.name) && e.descriptor.kind !== "external")
    .map((e) => {
      const gpu = e.descriptor.gpu;
      const mb = gpu?.vram_mb?.peak;
      const card =
        gpu === undefined || gpu.policy === "reserve"
          ? ""
          : t.init.gpuTag(mb !== undefined && mb > 0 ? mb : null);
      return { name: e.name, label: `${e.name}  ${e.descriptor.summary}${card}` };
    });
}

/** Which services this machine offers: the flag, or a multiple choice from the catalog. */
async function pickServices(
  p: Prompter,
  catalog: Catalog,
  given: readonly string[] | undefined,
  already: readonly string[],
): Promise<string[]> {
  const choices = offered(catalog);
  if (given !== undefined) {
    const unknown = given.filter((name) => !choices.some((c) => c.name === name));
    if (unknown.length > 0) {
      throw new Error(
        t.init.unknownServices(t.common.list(unknown), t.common.list(choices.map((c) => c.name))),
      );
    }
    return [...given];
  }
  const initial = choices.flatMap((c, i) => (already.includes(c.name) ? [i] : []));
  const picked = await p.multiSelect(
    t.init.pickServices,
    choices.map((c) => c.label),
    initial,
  );
  return picked.map((i) => (choices[i] as { name: string }).name);
}

function hostExtra(plan: HostTomlPlan, shown: string): ExtraWrite {
  const lines =
    !plan.exists || plan.added.length > 0
      ? [
          (plan.exists ? t.init.hostUpdate : t.init.hostCreate)(
            shown,
            plan.added.length > 0 ? t.common.list(plan.added) : t.common.none,
          ),
        ]
      : [];
  return {
    lines,
    save: () => (lines.length > 0 && writeHostToml(plan) ? [shown] : []),
  };
}

/** What the first question starts on: what an existing `host.toml` already says. */
function defaultMode(hostToml: string): InitMode {
  const have = enabledServices(hostToml);
  if (have.length > 0 && !have.includes("core")) return "service";
  return have.some((s) => VOICE_SERVICES.includes(s)) ? "voice" : "text";
}

/** A path as shown to the user: relative to the current folder when that is shorter. */
function shownPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel !== "" && !rel.startsWith("..") && rel.length < path.length ? rel : path;
}

export async function run(
  configPath: string,
  p: Prompter,
  options: InitOptions = {},
): Promise<void> {
  const bundled =
    options.bundledProfiles === undefined ? bundledProfilesDir() : options.bundledProfiles;
  const ws = openForInit(configPath, {
    bundledProfiles: bundled,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const hostToml = options.hostToml ?? join(ws.dir, HOST_CONFIG_FILE);
  p.intro(t.init.intro);

  let mode: InitMode;
  if (options.mode !== undefined) mode = options.mode;
  else {
    const picked = await p.select(
      t.init.modeQuestion,
      INIT_MODES.map((m) => t.init.modes[m]),
      INIT_MODES.indexOf(defaultMode(hostToml)),
    );
    mode = INIT_MODES[picked] ?? "text";
  }

  const cmd = options.command ?? commandPrefix();
  const width = `${cmd} config`.length + 2;
  const line = (c: string, what: string) => `  ${`${cmd} ${c}`.padEnd(width)} ${what}`;

  if (mode === "service") {
    await runService(p, options, { hostToml, cmd, line });
    return;
  }

  if (ws.tomlExists) {
    p.note(t.init.existing);
  } else {
    p.note(t.init.willCreate(resolve(ws.dir) === resolve(process.cwd()) ? null : ws.dir));
  }
  const fresh = !ws.tomlExists;
  if (fresh) ws.planGitignore();
  const scaffold = ws.planScaffold();
  if (scaffold.length > 0) p.note(t.init.willCopyProfiles(t.common.list(scaffold)));

  const generated = await flow(p, ws);
  if (generated.length > 0) p.note(t.init.willGenerateTokens(t.common.list(generated)));

  const services = ["core", ...(mode === "voice" ? VOICE_SERVICES : [])];
  const plan = planHostToml(hostToml, services);
  const changes = await commit(p, options.yes ?? false, ws, hostExtra(plan, shownPath(hostToml)));
  // A config made now has not been read by any Core: nothing could be running on it.
  if (changes && !fresh) await afterWrite(p, options.yes ?? false, ws, changes);
  if (changes !== null || ws.tomlExists) {
    const key = settings.current(ws, settings.llmApiKeyField(ws)).value;
    if (key === "") p.warn(t.init.noApiKey);
  }

  const panel = `http://${ws.effective("modules.api.bind") ?? "127.0.0.1:7878"}/`;
  const next =
    mode === "voice"
      ? [
          line(`add ${VOICE_SERVICES.join(" ")}`, t.init.nextAddVoice),
          line("up", t.init.nextUpVoice),
        ]
      : [line("up", t.init.nextUpText)];
  p.outro(
    [
      t.init.nextSteps,
      ...next,
      t.init.nextPanel(panel),
      ...(mode === "voice" ? [t.init.nextVoiceLater] : []),
      line("doctor", t.init.nextDoctor),
      line("config", t.init.nextConfig),
    ].join("\n"),
  );
}

/** The third path: only `host.toml`, for a machine that serves somebody else's Core. */
async function runService(
  p: Prompter,
  options: InitOptions,
  ui: { hostToml: string; cmd: string; line: (command: string, what: string) => string },
): Promise<void> {
  const { hostToml, cmd, line } = ui;
  p.note(t.init.serviceOnly(hostToml));
  const catalog = loadCatalog(options.catalogRoot ?? catalogRoot(hostToml));
  if (catalog.services.size === 0) {
    throw new Error(t.init.noCatalog);
  }
  p.section(t.init.sections.services);
  const services = await pickServices(p, catalog, options.services, enabledServices(hostToml));
  if (services.length === 0) {
    throw new Error(t.init.noServices);
  }
  const plan = planHostToml(hostToml, services);
  const changes = await commit(p, options.yes ?? false, null, hostExtra(plan, shownPath(hostToml)));
  if (changes === null && !plan.exists) return;
  p.outro(
    [
      t.init.nextSteps,
      line(`add ${services.join(" ")}`, t.init.nextAddServices),
      t.init.nextInvite,
      t.init.joinCommand(cmd),
      t.init.nextApprove(plan.name),
      line("up", t.init.nextUpServices),
    ].join("\n"),
  );
}
