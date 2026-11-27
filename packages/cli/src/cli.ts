// Command line: a small declarative parser. Help and errors come from the message catalogue
// (`i18n/`), in the language `main` picks before it builds the command tree.

import type { ResolvedProfile } from "@miyoria/core/light";
import { loadDotenv } from "@miyoria/runtime/kernel";
import { cliVersion } from "./assets.js";
import * as autostart from "./commands/autostart.js";
import * as cluster from "./commands/cluster.js";
import * as configCmd from "./commands/config.js";
import * as dbCmd from "./commands/db.js";
import * as discordCmd from "./commands/discord.js";
import * as doctor from "./commands/doctor.js";
import * as host from "./commands/host.js";
import * as init from "./commands/init.js";
import * as memoryCmd from "./commands/memory.js";
import * as migrate from "./commands/migrate.js";
import * as modelsCmd from "./commands/models.js";
import * as nodeCmd from "./commands/node.js";
import * as profileCmd from "./commands/profile.js";
import * as remote from "./commands/remote.js";
import * as servicesCmd from "./commands/services.js";
import * as update from "./commands/update.js";
import { detectLang, langFlag, parseLang } from "./i18n/detect.js";
import { setLang, t } from "./i18n/index.js";
import { captureProcessEnv } from "./process-env.js";
import { installHostToml, loadProfileEnv, selectProfile } from "./profile.js";
import {
  ClackPrompter,
  DefaultsPrompter,
  isCancelled,
  isInteractive,
  NotTtyError,
  type Prompter,
} from "./prompt.js";
import { bold, dim, fail, plainReporter, println, warn } from "./ui.js";

export interface OptionSpec {
  name: string;
  short?: string;
  /** Takes a value shown as `<value>` in the help. */
  value?: string;
  help: string;
  default?: string;
}

export interface ArgSpec {
  name: string;
  help: string;
  optional?: boolean;
  variadic?: boolean;
}

export interface RunContext {
  /**
   * The config the command works on: `--config`, or for a command about her (`isCharacterCommand`)
   * the running profile's own `miyoria.toml` when it has one (docs/design/v5-profiles.md).
   */
  config: string;
  /** `--config` itself: the install's config, beside which `host.toml` and the machines are. */
  install: string;
  /** The running profile, for a command about her; `undefined` for the others. */
  profile?: ResolvedProfile;
  /** `--yes` */
  yes: boolean;
  options: Record<string, string | boolean | undefined>;
  args: string[];
}

export interface CommandSpec {
  name: string;
  help: string;
  options?: OptionSpec[];
  args?: ArgSpec[];
  subcommands?: CommandSpec[];
  /** Unknown `-x` / `--x` tokens are positional values (`config set k -1`). */
  allowHyphenValues?: boolean;
  /** Options that cannot be combined with the positional `args`. */
  conflicts?: [string, string];
  run?: (ctx: RunContext) => Promise<void>;
}

export class UsageError extends Error {
  override readonly name = "UsageError";

  constructor(
    message: string,
    readonly command: CommandSpec[],
  ) {
    super(message);
  }
}

function globalOptions(): OptionSpec[] {
  return [
    {
      name: "config",
      short: "c",
      value: "PATH",
      help: t.cli.options.config,
      default: "miyoria.toml",
    },
    { name: "yes", short: "y", help: t.cli.options.yes },
    { name: "lang", value: "LANG", help: t.cli.options.lang },
    { name: "help", short: "h", help: t.cli.options.help },
  ];
}

function versionOption(): OptionSpec {
  return { name: "version", short: "V", help: t.cli.options.version };
}

function interactivePrompter(): Prompter {
  return new ClackPrompter();
}

function str(ctx: RunContext, name: string): string | undefined {
  const v = ctx.options[name];
  return typeof v === "string" ? v : undefined;
}

function flag(ctx: RunContext, name: string): boolean {
  return ctx.options[name] === true;
}

async function remoteClient(ctx: RunContext) {
  return remote.clientFor(await nodeCmd.loadConfig(ctx.config));
}

function hostConfigOption(): OptionSpec {
  return { name: "host-config", value: "PATH", help: t.cli.options.hostConfig };
}

function jsonOption(): OptionSpec {
  return { name: "json", help: t.cli.options.json };
}

function forceOption(): OptionSpec {
  return { name: "force", help: t.cli.options.force };
}

function hostTargetOf(ctx: RunContext): host.HostTarget {
  return host.hostTarget(ctx.install, str(ctx, "host-config"));
}

/** The installer's confirmation: `--yes` agrees, a script without a terminal refuses. */
function serviceDepsOf(ctx: RunContext): servicesCmd.ServiceDeps {
  return {
    yes: ctx.yes,
    interactive: isInteractive(),
    confirm: async (message) => {
      if (ctx.yes) return true;
      if (!isInteractive()) return false;
      return interactivePrompter().confirm(message, false);
    },
  };
}

function autostartDepsOf(ctx: RunContext): autostart.AutostartDeps {
  return autostart.defaultAutostartDeps({
    yes: ctx.yes,
    confirm: isInteractive() ? (message) => interactivePrompter().confirm(message, false) : null,
  });
}

/** `{ [key]: value }` when there is a value; keeps optional properties out of exact types. */
function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

/** An integer option; a text that is not one is an error (the range is the command's). */
function integerOption(ctx: RunContext, name: string, fallback: number): number {
  const text = str(ctx, name);
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new Error(t.cli.errors.integer(name));
  return Number.parseInt(text, 10);
}

/** `--timeout SECS`, checked. */
function timeoutOf(ctx: RunContext): { timeoutSecs?: number } {
  const timeout = str(ctx, "timeout");
  if (timeout === undefined) return {};
  const timeoutSecs = Number.parseInt(timeout, 10);
  if (!(timeoutSecs > 0)) throw new Error(t.cli.errors.timeout);
  return { timeoutSecs };
}

/** Aborted on Ctrl+C (for streaming commands). */
function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}

/** The command tree, with help in the active language. */
export function commands(): CommandSpec {
  return {
    name: "miyoria",
    help: t.cli.root,
    subcommands: [
      {
        name: "init",
        help: t.cli.cmd.init.help,
        options: [
          {
            name: "mode",
            value: "MODE",
            help: t.cli.cmd.init.mode,
          },
          {
            name: "services",
            value: "LIST",
            help: t.cli.cmd.init.services,
          },
          { name: "non-interactive", help: t.cli.cmd.init.nonInteractive },
          { name: "llm-key-stdin", help: t.cli.cmd.init.llmKeyStdin },
          { name: "discord-token-stdin", help: t.cli.cmd.init.discordTokenStdin },
        ],
        run: async (ctx) => {
          const sources = {
            llmKeyStdin: flag(ctx, "llm-key-stdin"),
            discordTokenStdin: flag(ctx, "discord-token-stdin"),
          };
          // `--yes` keeps its old meaning for init: no questions at all.
          const unattended =
            flag(ctx, "non-interactive") ||
            ctx.yes ||
            sources.llmKeyStdin ||
            sources.discordTokenStdin;
          let p: Prompter;
          if (unattended) {
            const secrets = await init.initSecrets(sources, process.env, init.readAllStdin);
            p = new DefaultsPrompter(plainReporter, secrets);
          } else if (isInteractive()) p = interactivePrompter();
          else throw new NotTtyError(t.cli.cmd.init.notTty);
          const mode = str(ctx, "mode");
          if (mode !== undefined && !(init.INIT_MODES as readonly string[]).includes(mode)) {
            throw new Error(t.cli.cmd.init.modeChoice(t.common.list(init.INIT_MODES)));
          }
          const services = str(ctx, "services");
          if (services !== undefined && mode !== "service") {
            throw new Error(t.cli.cmd.init.servicesNeedMode);
          }
          await init.run(ctx.config, p, {
            yes: unattended,
            ...(mode !== undefined ? { mode: mode as init.InitMode } : {}),
            ...(services !== undefined
              ? {
                  services: services
                    .split(",")
                    .map((name) => name.trim())
                    .filter((name) => name !== ""),
                }
              : {}),
          });
        },
      },
      {
        name: "config",
        help: t.cli.cmd.config.help,
        run: (ctx) => configCmd.menu(ctx.config, interactivePrompter(), ctx.yes),
        subcommands: [
          {
            name: "list",
            help: t.cli.cmd.config.list,
            options: [{ name: "reveal", help: t.cli.cmd.config.reveal }, jsonOption()],
            run: async (ctx) => configCmd.list(ctx.config, flag(ctx, "reveal"), flag(ctx, "json")),
          },
          {
            name: "get",
            help: t.cli.cmd.config.get,
            args: [
              {
                name: "key",
                help: t.cli.cmd.config.getKey,
                optional: true,
              },
            ],
            options: [
              { name: "env", value: "NAME", help: t.cli.cmd.config.getEnv },
              { name: "reveal", help: t.cli.cmd.config.reveal },
            ],
            conflicts: ["env", "key"],
            run: async (ctx) =>
              configCmd.get(ctx.config, ctx.args[0], str(ctx, "env"), flag(ctx, "reveal")),
          },
          {
            name: "set",
            help: t.cli.cmd.config.set,
            args: [
              {
                name: t.cli.cmd.config.setArgName,
                help: t.cli.cmd.config.setArg,
                variadic: true,
              },
            ],
            options: [{ name: "env", value: "NAME", help: t.cli.cmd.config.setEnv }],
            allowHyphenValues: true,
            run: (ctx) => configCmd.set(ctx.config, ctx.args, str(ctx, "env"), ctx.yes),
          },
          {
            name: "unset",
            help: t.cli.cmd.config.unset,
            args: [{ name: "key", help: t.cli.cmd.config.unsetKey, optional: true }],
            options: [{ name: "env", value: "NAME", help: t.cli.cmd.config.unsetEnv }],
            conflicts: ["env", "key"],
            run: (ctx) => configCmd.unset(ctx.config, ctx.args[0], str(ctx, "env"), ctx.yes),
          },
          {
            name: "edit",
            help: t.cli.cmd.config.edit,
            run: (ctx) => configCmd.edit(ctx.config, ctx.yes),
          },
          {
            name: "overrides",
            help: t.cli.cmd.config.overrides,
            run: (ctx) => configCmd.overrides(ctx.config),
          },
          {
            name: "bake",
            help: t.cli.cmd.config.bake,
            run: (ctx) =>
              configCmd.bake(ctx.config, ctx.yes, ctx.yes ? null : interactivePrompter()),
          },
          {
            name: "import",
            help: t.cli.cmd.config.import,
            options: [
              { name: "dry-run", help: t.cli.cmd.config.importDryRun },
              {
                name: "replace",
                help: t.cli.cmd.config.importReplace,
              },
            ],
            run: (ctx) =>
              configCmd.importConfig(
                ctx.config,
                { replace: flag(ctx, "replace"), dryRun: flag(ctx, "dry-run"), yes: ctx.yes },
                ctx.yes || !isInteractive() ? null : interactivePrompter(),
              ),
          },
        ],
      },
      {
        name: "doctor",
        help: t.cli.cmd.doctor.help,
        options: [
          {
            name: "deep",
            help: t.cli.cmd.doctor.deep,
          },
          { name: "deep-only", help: t.cli.cmd.doctor.deepOnly },
          {
            name: "fix",
            help: t.cli.cmd.doctor.fix,
          },
          {
            name: "print-hashes",
            value: "SERVICE",
            help: t.cli.cmd.doctor.printHashes,
          },
          jsonOption(),
          hostConfigOption(),
        ],
        run: (ctx) =>
          doctor.run(ctx.config, {
            deep: flag(ctx, "deep"),
            stackOnly: flag(ctx, "deep-only"),
            fix: flag(ctx, "fix"),
            json: flag(ctx, "json"),
            ...optionalString("hostConfig", str(ctx, "host-config")),
            ...optionalString("printHashes", str(ctx, "print-hashes")),
            services: serviceDepsOf(ctx),
          }),
      },
      {
        name: "db",
        help: t.cli.cmd.db.help,
        subcommands: [
          {
            name: "import-links",
            help: t.cli.cmd.db.importLinks,
            options: [
              {
                name: "from",
                value: "FILE",
                help: t.cli.cmd.db.from,
              },
              { name: "dry-run", help: t.cli.cmd.db.importDryRun },
            ],
            run: (ctx) =>
              dbCmd.importLinksCommand(ctx.config, {
                from: str(ctx, "from"),
                dryRun: flag(ctx, "dry-run"),
              }),
          },
          {
            name: "archive",
            help: t.cli.cmd.db.archive,
            args: [{ name: "file", help: t.cli.cmd.db.archiveFile, optional: true }],
            options: [{ name: "dry-run", help: t.cli.cmd.db.archiveDryRun }],
            run: (ctx) =>
              dbCmd.archiveCommand(
                ctx.config,
                { file: ctx.args[0], dryRun: flag(ctx, "dry-run"), yes: ctx.yes },
                isInteractive() ? interactivePrompter() : null,
              ),
          },
          {
            name: "doctor",
            help: t.cli.cmd.db.doctor,
            args: [{ name: "file", help: t.cli.cmd.db.doctorFile, optional: true }],
            run: (ctx) => dbCmd.doctorCommand(ctx.config, ctx.args[0]),
          },
        ],
      },
      {
        name: "memory",
        help: t.cli.cmd.memory.help,
        subcommands: [
          {
            name: "rebuild",
            help: t.cli.cmd.memory.rebuild,
            args: [{ name: "file", help: t.cli.cmd.memory.file, optional: true }],
            options: [
              {
                name: "since",
                value: "DATE",
                help: t.cli.cmd.memory.since,
                default: "2026-11-15",
              },
              { name: "apply", help: t.cli.cmd.memory.apply },
              {
                name: "max-usd",
                value: "USD",
                help: t.cli.cmd.memory.maxUsd,
                default: "2",
              },
              { name: "force", help: t.cli.cmd.memory.force },
            ],
            run: (ctx) =>
              memoryCmd.rebuildCommand(ctx.config, {
                file: ctx.args[0],
                since: str(ctx, "since"),
                apply: flag(ctx, "apply"),
                maxUsd: str(ctx, "max-usd"),
                force: flag(ctx, "force"),
              }),
          },
        ],
      },
      {
        name: "add",
        help: t.cli.cmd.add.help,
        args: [
          {
            name: "service",
            help: t.cli.cmd.add.service,
            optional: true,
            variadic: true,
          },
        ],
        options: [
          { name: "no-install", help: t.cli.cmd.add.noInstall },
          {
            name: "extra",
            value: "NAME",
            help: t.cli.cmd.add.extra,
          },
          hostConfigOption(),
        ],
        run: (ctx) => {
          const extra = str(ctx, "extra");
          const extras =
            extra === undefined
              ? undefined
              : extra
                  .split(",")
                  .map((e) => e.trim())
                  .filter((e) => e !== "");
          return servicesCmd.add(
            hostTargetOf(ctx),
            {
              services: ctx.args,
              noInstall: flag(ctx, "no-install"),
              ...(extras !== undefined ? { extras } : {}),
            },
            serviceDepsOf(ctx),
          );
        },
      },
      {
        name: "remove",
        help: t.cli.cmd.remove.help,
        args: [{ name: "service", help: t.cli.cmd.remove.service, variadic: true }],
        options: [
          { name: "keep-env", help: t.cli.cmd.remove.keepEnv },
          forceOption(),
          hostConfigOption(),
        ],
        run: (ctx) =>
          servicesCmd.remove(
            hostTargetOf(ctx),
            { services: ctx.args, keepEnv: flag(ctx, "keep-env"), force: flag(ctx, "force") },
            serviceDepsOf(ctx),
          ),
      },
      {
        name: "models",
        help: t.cli.cmd.models.help,
        subcommands: [
          {
            name: "pull",
            help: t.cli.cmd.models.pull,
            args: [
              { name: "service", help: t.cli.cmd.models.service, optional: true, variadic: true },
            ],
            options: [hostConfigOption()],
            run: (ctx) =>
              modelsCmd.pull(hostTargetOf(ctx), { services: ctx.args }, serviceDepsOf(ctx)),
          },
          {
            name: "ls",
            help: t.cli.cmd.models.ls,
            options: [hostConfigOption()],
            run: async (ctx) => modelsCmd.ls(hostTargetOf(ctx)),
          },
          {
            name: "gc",
            help: t.cli.cmd.models.gc,
            options: [hostConfigOption()],
            run: (ctx) => modelsCmd.gc(hostTargetOf(ctx), { yes: ctx.yes }, serviceDepsOf(ctx)),
          },
        ],
      },
      {
        name: "sandbox",
        help: t.cli.cmd.sandbox.help,
        subcommands: [
          {
            name: "serve",
            help: t.cli.cmd.sandbox.serve,
            options: [hostConfigOption()],
            run: async (ctx) => {
              const { sandboxServe } = await import("./commands/sandbox.js");
              await sandboxServe({ hostToml: hostTargetOf(ctx).hostToml });
            },
          },
          {
            name: "build",
            help: t.cli.cmd.sandbox.build,
            options: [hostConfigOption()],
            run: async (ctx) => {
              const { sandboxBuild } = await import("./commands/sandbox.js");
              const built = await sandboxBuild({
                yes: ctx.yes,
                hostToml: hostTargetOf(ctx).hostToml,
              });
              if (!built) process.exitCode = 1;
            },
          },
        ],
      },
      {
        name: "hostd",
        help: t.cli.cmd.hostd.help,
        options: [
          hostConfigOption(),
          {
            name: "start",
            help: t.cli.cmd.hostd.start,
          },
        ],
        run: (ctx) => host.hostd(hostTargetOf(ctx), { start: flag(ctx, "start") }),
      },
      {
        name: "up",
        help: t.cli.cmd.up.help,
        args: [
          {
            name: "service",
            help: t.cli.cmd.up.service,
            optional: true,
            variadic: true,
          },
        ],
        options: [
          hostConfigOption(),
          {
            name: "foreground",
            help: t.cli.cmd.up.foreground,
          },
          {
            name: "timeout",
            value: "SECS",
            help: t.cli.cmd.up.timeout,
          },
          { name: "no-wait", help: t.cli.cmd.up.noWait },
          {
            name: "no-link",
            help: t.cli.cmd.up.noLink,
          },
        ],
        run: (ctx) => {
          const target = hostTargetOf(ctx);
          return host.up(target, {
            services: ctx.args,
            foreground: flag(ctx, "foreground"),
            noWait: flag(ctx, "no-wait"),
            ...(flag(ctx, "no-link") ? {} : { selfLink: (h) => cluster.selfLink(target, h) }),
            ...timeoutOf(ctx),
          });
        },
      },
      {
        name: "down",
        help: t.cli.cmd.down.help,
        args: [
          {
            name: "service",
            help: t.cli.cmd.down.service,
            optional: true,
            variadic: true,
          },
        ],
        options: [hostConfigOption(), forceOption()],
        run: (ctx) =>
          host.down(hostTargetOf(ctx), { services: ctx.args, force: flag(ctx, "force") }),
      },
      {
        name: "restart",
        help: t.cli.cmd.restart.help,
        args: [{ name: "service", help: t.cli.cmd.restart.service }],
        options: [
          hostConfigOption(),
          forceOption(),
          { name: "timeout", value: "SECS", help: t.cli.cmd.restart.timeout },
        ],
        run: (ctx) =>
          host.restart(hostTargetOf(ctx), {
            service: ctx.args[0] as string,
            force: flag(ctx, "force"),
            ...timeoutOf(ctx),
          }),
      },
      {
        name: "status",
        help: t.cli.cmd.status.help,
        options: [hostConfigOption(), { name: "all", help: t.cli.cmd.status.all }, jsonOption()],
        run: (ctx) =>
          host.status(hostTargetOf(ctx), {
            ...(flag(ctx, "all") ? { hosts: cluster.hostsSection, all: true } : {}),
            json: flag(ctx, "json"),
          }),
      },
      {
        name: "logs",
        help: t.cli.cmd.logs.help,
        args: [{ name: "service", help: t.cli.cmd.logs.service }],
        options: [
          hostConfigOption(),
          { name: "follow", short: "f", help: t.cli.cmd.logs.follow },
          { name: "lines", short: "n", value: "N", help: t.cli.cmd.logs.lines, default: "100" },
        ],
        run: (ctx) => {
          const lines = Number.parseInt(str(ctx, "lines") ?? "100", 10);
          if (!Number.isInteger(lines) || lines < 0) throw new Error(t.cli.errors.lines);
          return host.logs(hostTargetOf(ctx), {
            service: ctx.args[0] as string,
            follow: flag(ctx, "follow"),
            lines: Math.min(lines, 2000),
            signal: interruptSignal(),
          });
        },
      },
      {
        name: "host",
        help: t.cli.cmd.host.help,
        subcommands: [
          {
            name: "invite",
            help: t.cli.cmd.host.invite,
            options: [
              { name: "name", value: "NAME", help: t.cli.cmd.host.inviteName },
              {
                name: "ttl",
                value: "MINUTES",
                help: t.cli.cmd.host.ttl,
                default: "10",
              },
            ],
            run: (ctx) =>
              cluster.invite(hostTargetOf(ctx), {
                ...optionalString("name", str(ctx, "name")),
                ttlMinutes: integerOption(ctx, "ttl", 10),
              }),
          },
          {
            name: "join",
            help: t.cli.cmd.host.join,
            args: [
              {
                name: "core-url",
                help: t.cli.cmd.host.coreUrl,
                optional: true,
              },
            ],
            options: [
              hostConfigOption(),
              { name: "code", value: "CODE", help: t.cli.cmd.host.code },
              {
                name: "name",
                value: "NAME",
                help: t.cli.cmd.host.joinName,
              },
              {
                name: "local",
                help: t.cli.cmd.host.local,
              },
              { name: "force", help: t.cli.cmd.host.joinForce },
            ],
            conflicts: ["local", "core-url"],
            run: (ctx) =>
              cluster.joinHost(hostTargetOf(ctx), {
                ...optionalString("coreUrl", ctx.args[0]),
                ...optionalString("code", str(ctx, "code")),
                ...optionalString("name", str(ctx, "name")),
                local: flag(ctx, "local"),
                force: flag(ctx, "force"),
              }),
          },
          {
            name: "ls",
            help: t.cli.cmd.host.ls,
            options: [jsonOption()],
            run: (ctx) => cluster.ls(hostTargetOf(ctx), flag(ctx, "json")),
          },
          {
            name: "approve",
            help: t.cli.cmd.host.approve,
            args: [
              { name: "name", help: t.cli.cmd.host.hostName },
              {
                name: "capability",
                help: t.cli.cmd.host.capability,
                optional: true,
                variadic: true,
              },
            ],
            run: (ctx) =>
              cluster.approve(hostTargetOf(ctx), ctx.args[0] as string, ctx.args.slice(1)),
          },
          {
            name: "remove",
            help: t.cli.cmd.host.remove,
            args: [{ name: "name", help: t.cli.cmd.host.hostName }],
            run: (ctx) =>
              cluster.removeHost(hostTargetOf(ctx), ctx.args[0] as string, {
                yes: ctx.yes,
                confirm: isInteractive()
                  ? (message) => interactivePrompter().confirm(message, false)
                  : null,
              }),
          },
          {
            name: "autostart",
            help: t.cli.cmd.host.autostart,
            subcommands: [
              {
                name: "on",
                help: t.cli.cmd.host.autostartOn,
                options: [hostConfigOption()],
                run: (ctx) => autostart.autostartOn(hostTargetOf(ctx), autostartDepsOf(ctx)),
              },
              {
                name: "off",
                help: t.cli.cmd.host.autostartOff,
                options: [hostConfigOption()],
                run: (ctx) => autostart.autostartOff(hostTargetOf(ctx), autostartDepsOf(ctx)),
              },
              {
                name: "status",
                help: t.cli.cmd.host.autostartStatus,
                options: [hostConfigOption()],
                run: (ctx) => autostart.autostartStatus(hostTargetOf(ctx), autostartDepsOf(ctx)),
              },
            ],
          },
          {
            name: "migrate",
            help: t.cli.cmd.host.migrate,
            options: [
              hostConfigOption(),
              { name: "force", help: t.cli.cmd.host.migrateForce },
              { name: "dry-run", help: t.cli.cmd.host.migrateDryRun },
            ],
            run: (ctx) =>
              migrate.migrate(hostTargetOf(ctx), {
                force: flag(ctx, "force"),
                dryRun: flag(ctx, "dry-run"),
              }),
          },
        ],
      },
      {
        name: "update",
        help: t.cli.cmd.update.help,
        options: [
          { name: "no-pull", help: t.cli.cmd.update.noPull },
          { name: "force", help: t.cli.cmd.update.force },
          { name: "skip-mod", help: t.cli.cmd.update.skipMod },
          { name: "dry-run", help: t.cli.cmd.update.dryRun },
          { name: "no-restart", help: t.cli.cmd.update.noRestart },
          hostConfigOption(),
        ],
        run: (ctx) =>
          update.run(
            ctx.config,
            {
              noPull: flag(ctx, "no-pull"),
              force: flag(ctx, "force"),
              skipMod: flag(ctx, "skip-mod"),
              dryRun: flag(ctx, "dry-run"),
              noRestart: flag(ctx, "no-restart"),
              ...optionalString("hostConfig", str(ctx, "host-config")),
            },
            {
              ...update.defaultUpdateDeps(async (message) => {
                if (ctx.yes) return true;
                if (!isInteractive()) return false;
                return interactivePrompter().confirm(message, false);
              }),
              services: serviceDepsOf(ctx),
            },
          ),
      },
      {
        name: "core",
        help: t.cli.cmd.core.help,
        run: (ctx) => nodeCmd.core(ctx.config, ctx.profile),
      },
      {
        name: "stage",
        help: t.cli.cmd.stage.help,
        run: (ctx) => nodeCmd.stage(ctx.config),
        subcommands: [
          {
            name: "obs-setup",
            help: t.cli.cmd.stage.obsSetup,
            options: [
              { name: "dry-run", help: t.cli.cmd.stage.dryRun },
              { name: "relayout", help: t.cli.cmd.stage.relayout },
              {
                name: "collection",
                value: "NAME",
                help: t.cli.cmd.stage.collection,
              },
              { name: "here", help: t.cli.cmd.stage.here },
              {
                name: "profile",
                value: "NAME",
                help: t.cli.cmd.stage.profile,
              },
              { name: "no-profile", help: t.cli.cmd.stage.noProfile },
              {
                name: "profile-settings",
                help: t.cli.cmd.stage.profileSettings,
              },
            ],
            run: (ctx) =>
              nodeCmd.stageObsSetup(ctx.config, {
                dryRun: flag(ctx, "dry-run"),
                relayout: flag(ctx, "relayout"),
                here: flag(ctx, "here"),
                noProfile: flag(ctx, "no-profile"),
                profileSettings: flag(ctx, "profile-settings"),
                collection: str(ctx, "collection") ?? null,
                profile: str(ctx, "profile") ?? null,
              }),
          },
        ],
      },
      {
        name: "chat",
        help: t.cli.cmd.chat.help,
        options: [
          {
            name: "name",
            value: "NAME",
            help: t.cli.cmd.chat.name,
            default: t.cli.cmd.chat.defaultName,
          },
          { name: "with-discord", help: t.cli.cmd.chat.withDiscord },
        ],
        run: (ctx) =>
          nodeCmd.chat(
            ctx.config,
            str(ctx, "name") ?? t.cli.cmd.chat.defaultName,
            flag(ctx, "with-discord"),
            ctx.profile,
          ),
      },
      {
        name: "module",
        help: t.cli.cmd.module.help,
        subcommands: [
          {
            name: "list",
            help: t.cli.cmd.module.list,
            run: async (ctx) => {
              const config = await nodeCmd.loadConfig(ctx.config);
              try {
                const client = remote.clientFor(config);
                if (await remote.isRunning(client)) {
                  await remote.modules(client);
                  return;
                }
              } catch {
                // no token: show the config file
              }
              println(t.cli.cmd.module.offline);
              const { configuredModules } = await import("@miyoria/core/light");
              for (const [id, enabled] of configuredModules(config))
                println(`${enabled ? "●" : "○"} ${id}`);
            },
          },
          ...(["enable", "disable", "restart"] as const).map(
            (action): CommandSpec => ({
              name: action,
              help: t.cli.cmd.module[action],
              args: [{ name: "id", help: t.cli.cmd.module.id }],
              run: async (ctx) =>
                remote.moduleAction(await remoteClient(ctx), ctx.args[0] as string, action),
            }),
          ),
        ],
      },
      {
        name: "decisions",
        help: t.cli.cmd.decisions.help,
        options: [
          { name: "limit", short: "l", value: "N", help: t.cli.cmd.decisions.limit, default: "20" },
        ],
        run: async (ctx) => {
          const limit = Number.parseInt(str(ctx, "limit") ?? "20", 10);
          if (!Number.isFinite(limit) || limit <= 0) throw new Error(t.cli.errors.limit);
          await remote.decisions(await remoteClient(ctx), limit);
        },
      },
      {
        name: "events",
        help: t.cli.cmd.events.help,
        args: [
          {
            name: "topics",
            help: t.cli.cmd.events.topics,
            optional: true,
            variadic: true,
          },
        ],
        run: async (ctx) => remote.events(await remoteClient(ctx), ctx.args, interruptSignal()),
      },
      {
        name: "persona",
        help: t.cli.cmd.persona.help,
        subcommands: [
          {
            name: "show",
            help: t.cli.cmd.persona.show,
            run: async (ctx) => remote.personaShow(await remoteClient(ctx)),
          },
          {
            name: "set",
            help: t.cli.cmd.persona.set,
            args: [
              { name: "key", help: t.cli.cmd.persona.key },
              { name: "file", help: t.cli.cmd.persona.file },
            ],
            allowHyphenValues: true,
            run: async (ctx) => {
              const client = await remoteClient(ctx);
              const body = await nodeCmd.readInput(ctx.args[1] as string);
              await remote.personaSet(client, ctx.args[0] as string, body.trim());
            },
          },
        ],
      },
      {
        name: "profile",
        help: t.cli.cmd.profile.help,
        subcommands: [
          {
            name: "list",
            help: t.cli.cmd.profile.list,
            run: (ctx) => profileCmd.list(ctx.install),
          },
          {
            name: "show",
            help: t.cli.cmd.profile.show,
            run: (ctx) => profileCmd.show(ctx.install),
          },
          {
            name: "use",
            help: t.cli.cmd.profile.use,
            args: [{ name: "id", help: t.cli.cmd.profile.useId }],
            run: (ctx) => profileCmd.use(ctx.install, ctx.args[0] as string),
          },
          {
            name: "new",
            help: t.cli.cmd.profile.new,
            args: [{ name: "id", help: t.cli.cmd.profile.newId }],
            options: [{ name: "name", value: "NAME", help: t.cli.cmd.profile.newName }],
            run: (ctx) =>
              profileCmd.create(ctx.install, ctx.args[0] as string, {
                ...optionalString("name", str(ctx, "name")),
              }),
          },
          {
            name: "validate",
            help: t.cli.cmd.profile.validate,
            run: (ctx) => nodeCmd.profileValidate(ctx.config, ctx.profile),
          },
        ],
      },
      {
        name: "discord",
        help: t.cli.cmd.discord.help,
        subcommands: [
          {
            name: "commands",
            help: t.cli.cmd.discord.commands,
            subcommands: [
              {
                name: "reset",
                help: t.cli.cmd.discord.reset,
                run: (ctx) =>
                  discordCmd.commandsReset(
                    ctx.config,
                    isInteractive() ? interactivePrompter() : null,
                    ctx.yes,
                  ),
              },
            ],
          },
        ],
      },
      {
        name: "ext",
        help: t.cli.cmd.ext.help,
        subcommands: [
          {
            name: "new",
            help: t.cli.cmd.ext.new,
            args: [{ name: "name", help: t.cli.cmd.ext.name }],
            options: [
              { name: "dir", value: "DIR", help: t.cli.cmd.ext.dir, default: "extensions" },
            ],
            run: (ctx) => nodeCmd.extNew(ctx.args[0] as string, str(ctx, "dir") ?? "extensions"),
          },
          { name: "list", help: t.cli.cmd.ext.list, run: (ctx) => nodeCmd.extList(ctx.config) },
          {
            name: "install",
            help: t.cli.cmd.ext.install,
            args: [{ name: "source", help: t.cli.cmd.ext.source }],
            run: (ctx) => nodeCmd.extInstall(ctx.config, ctx.args[0] as string),
          },
          {
            name: "validate",
            help: t.cli.cmd.ext.validate,
            args: [{ name: "dir", help: t.cli.cmd.ext.validateDir }],
            run: async (ctx) => nodeCmd.extValidate(ctx.args[0] as string),
          },
          {
            name: "dev",
            help: t.cli.cmd.ext.dev,
            run: (ctx) => nodeCmd.extDev(ctx.config),
          },
        ],
      },
    ],
  };
}

// ---- parsing -----------------------------------------------------------------------------

export interface Parsed {
  path: CommandSpec[];
  ctx: RunContext;
  help: boolean;
  version: boolean;
}

function optionsOf(path: CommandSpec[]): OptionSpec[] {
  const cmd = path.at(-1) as CommandSpec;
  return [
    ...(cmd.options ?? []),
    ...globalOptions(),
    ...(path.length === 1 ? [versionOption()] : []),
  ];
}

export function parseArgs(argv: readonly string[], root: CommandSpec = commands()): Parsed {
  const path: CommandSpec[] = [root];
  const options: Record<string, string | boolean | undefined> = {};
  const args: string[] = [];
  const cmd = () => path.at(-1) as CommandSpec;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    const isLong = token.startsWith("--") && token.length > 2;
    const isShort = !isLong && /^-[A-Za-z]$/.test(token);
    if (isLong || isShort) {
      const [rawName, inline] = isLong
        ? ((eq) =>
            eq === -1 ? [token.slice(2), undefined] : [token.slice(2, eq), token.slice(eq + 1)])(
            token.indexOf("="),
          )
        : [token.slice(1), undefined];
      const spec = optionsOf(path).find((o) => (isLong ? o.name === rawName : o.short === rawName));
      if (!spec) {
        if (cmd().allowHyphenValues) {
          args.push(token);
          continue;
        }
        throw new UsageError(t.cli.errors.unknownOption(token), [...path]);
      }
      if (spec.value !== undefined) {
        const value = inline ?? argv[++i];
        if (value === undefined)
          throw new UsageError(t.cli.errors.needsValue(token, spec.value), [...path]);
        options[spec.name] = value;
      } else {
        options[spec.name] = true;
      }
      continue;
    }
    const sub = args.length === 0 ? cmd().subcommands?.find((s) => s.name === token) : undefined;
    if (sub) path.push(sub);
    else args.push(token);
  }
  const target = cmd();
  for (const o of optionsOf(path)) {
    if (options[o.name] === undefined && o.default !== undefined) options[o.name] = o.default;
  }
  return {
    path,
    help: options.help === true,
    version: options.version === true,
    ctx: {
      config: (options.config as string | undefined) ?? "miyoria.toml",
      install: (options.config as string | undefined) ?? "miyoria.toml",
      yes: options.yes === true,
      options,
      args: target.run || target.args ? args : args,
    },
  };
}

/** Checks positional arguments against the command's spec. */
export function checkArgs(path: CommandSpec[], ctx: RunContext): void {
  const cmd = path.at(-1) as CommandSpec;
  const specs = cmd.args ?? [];
  const given = ctx.args;
  if (specs.length === 0 && given.length > 0) {
    const what = cmd.subcommands ? t.cli.errors.unknownCommand : t.cli.errors.extraArgument;
    throw new UsageError(what(given[0] as string), path);
  }
  const variadic = specs.some((a) => a.variadic);
  const required = specs.filter((a) => !a.optional).length;
  if (given.length < required) {
    const missing = specs[given.length] as ArgSpec;
    throw new UsageError(t.cli.errors.missingArgument(missing.name), path);
  }
  if (!variadic && given.length > specs.length) {
    throw new UsageError(t.cli.errors.extraArgument(given[specs.length] as string), path);
  }
  if (cmd.conflicts) {
    const [option, arg] = cmd.conflicts;
    if (ctx.options[option] !== undefined && given.length > 0) {
      throw new UsageError(t.cli.errors.conflict(option, arg), path);
    }
  }
}

// ---- help --------------------------------------------------------------------------------

function optionLabel(o: OptionSpec): string {
  const short = o.short ? `-${o.short}, ` : "    ";
  return `${short}--${o.name}${o.value ? ` <${o.value}>` : ""}`;
}

export function helpText(path: CommandSpec[]): string {
  const cmd = path.at(-1) as CommandSpec;
  const name = path.map((c) => c.name).join(" ");
  const lines: string[] = [cmd.help, ""];
  const argsUsage = (cmd.args ?? [])
    .map((a) => {
      const inner = `<${a.name}>${a.variadic ? "..." : ""}`;
      return a.optional ? `[${inner}]` : inner;
    })
    .join(" ");
  const sub = cmd.subcommands ? ` ${cmd.run ? t.cli.commandOptional : t.cli.commandRequired}` : "";
  lines.push(
    `${bold(t.cli.usage)}${name} ${t.cli.optionsWord}${sub}${argsUsage ? ` ${argsUsage}` : ""}`,
  );
  const table = (title: string, rows: Array<[string, string]>) => {
    if (rows.length === 0) return;
    const width = Math.max(...rows.map(([l]) => l.length)) + 2;
    lines.push("", bold(title));
    for (const [l, h] of rows) lines.push(`  ${l.padEnd(width)}${h}`);
  };
  table(
    t.cli.commandsTitle,
    (cmd.subcommands ?? []).map((s) => [s.name, s.help]),
  );
  table(
    t.cli.argumentsTitle,
    (cmd.args ?? []).map((a) => [`<${a.name}>`, a.help]),
  );
  table(
    t.cli.optionsTitle,
    optionsOf(path).map((o) => [
      optionLabel(o),
      o.default !== undefined ? `${o.help} ${dim(t.cli.defaultValue(o.default))}` : o.help,
    ]),
  );
  if (path.length === 1) lines.push("", ...t.cli.rootFooter);
  return lines.join("\n");
}

// ---- profiles ----------------------------------------------------------------------------

/** Top-level commands about her (her config, `.env` and data) rather than about this machine. */
const CHARACTER_COMMANDS = new Set([
  "config",
  "doctor",
  "db",
  "memory",
  "core",
  "stage",
  "chat",
  "module",
  "decisions",
  "events",
  "persona",
  "discord",
  "ext",
]);

/**
 * Whether a command works on the running profile (docs/design/v5-profiles.md). The others
 * (`init`, `update`, `hostd`, `up`, `add`, `host` ..., `profile list/show/use/new`)
 * are about the install and this machine and keep its files.
 */
export function isCharacterCommand(path: readonly CommandSpec[]): boolean {
  const [, top, sub] = path;
  if (top === undefined) return false;
  if (top.name === "profile") return sub?.name === "validate";
  return CHARACTER_COMMANDS.has(top.name);
}

/**
 * Points a command about her at the running profile and loads the `.env` it runs with. A profile
 * of its own swaps `ctx.config` for its `miyoria.toml`; `host.toml` stays the install's.
 */
export function enterProfile(
  parsed: Parsed,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isCharacterCommand(parsed.path)) {
    loadDotenv(parsed.ctx.config, env);
    return;
  }
  const profile = selectProfile(parsed.ctx.install, env);
  loadProfileEnv(profile, env);
  parsed.ctx.profile = profile;
  if (profile.own) {
    parsed.ctx.config = profile.configPath;
    parsed.ctx.options["host-config"] ??= installHostToml(profile);
  }
}

// ---- main --------------------------------------------------------------------------------

/** Runs the CLI; resolves to the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const given = langFlag(argv);
  const chosen = given === undefined ? undefined : parseLang(given);
  setLang(detectLang({ flag: chosen, env: process.env }));
  if (given !== undefined && chosen === undefined) {
    fail(t.cli.errors.badLang(given));
    return 2;
  }
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      println(helpText(parsed.path));
      return 0;
    }
    if (parsed.version) {
      println(`miyoria ${cliVersion()}`);
      return 0;
    }
    const cmd = parsed.path.at(-1) as CommandSpec;
    if (!cmd.run) {
      if (parsed.ctx.args.length > 0)
        throw new UsageError(
          t.cli.errors.unknownCommand(parsed.ctx.args[0] as string),
          parsed.path,
        );
      println(helpText(parsed.path));
      return parsed.path.length === 1 ? 0 : 2;
    }
    checkArgs(parsed.path, parsed.ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message);
      println(`\n${helpText(error.command)}`);
      return 2;
    }
    throw error;
  }

  captureProcessEnv();
  try {
    enterProfile(parsed);
    await (parsed.path.at(-1) as CommandSpec).run?.(parsed.ctx);
    return 0;
  } catch (error) {
    if (isCancelled(error)) {
      warn(t.cli.cancelled);
      return 130;
    }
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
