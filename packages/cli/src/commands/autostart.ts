// `miyoria host autostart on | off | status`: start this workspace's hostd when the current user
// logs in (docs/design/v5-hostd.md §4, H10). Nothing here is elevated and nothing runs unless the
// owner asks: the commands that change the system are printed first and run through an injected
// runner (tests assert the exact command lines).
//
// Windows: a per-user scheduled task registered from an XML definition (`schtasks /create /xml`).
// XML rather than `/sc onlogon ... /tr`: `/tr` is limited to 261 characters and has fragile
// quoting, while the XML file is Unicode (paths with spaces and Chinese characters need no
// escaping beyond XML's) and can name the user. The trigger is the logon of THAT user, the
// principal is that user with an interactive token and least privilege (so it runs in the user's
// session, not as SYSTEM in session 0, and can start desktop programs later). The action is
// `conhost.exe --headless <node> <entry> hostd ...`: a console program with no window. VBScript
// (`wscript`) is being removed from Windows; `--headless` is what the current Windows Terminal
// itself uses, but Microsoft does not document it (see the notes in the output of `on`).
//
// Linux: a systemd user unit (`~/.config/systemd/user/<name>.service`), `Restart=on-failure`,
// `systemctl --user enable --now`. macOS is not supported yet.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HostdClient } from "@miyoria/hostd";
import { t } from "../i18n/index.js";
import { defaultRunner, type Runner } from "../stack/system.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import { HostCommandError, type HostTarget, loadHost, selfCommand } from "./host.js";

export interface AutostartDeps {
  platform: NodeJS.Platform;
  runner: Runner;
  env: Record<string, string | undefined>;
  /** `<domain>\<user>` for the Windows principal, `user` elsewhere. */
  user: () => string;
  /** How this CLI is started (program and leading arguments). */
  self: () => string[];
  /** Whether a hostd of this workspace answers now. */
  daemonRunning: (target: HostTarget) => Promise<boolean>;
  /** Asks before changing anything; `null` = no terminal to ask on. */
  confirm: ((message: string) => Promise<boolean>) | null;
  yes: boolean;
  /** Where the systemd user units live; defaults to `$XDG_CONFIG_HOME/systemd/user`. */
  unitDir?: string;
}

export function defaultAutostartDeps(
  options: { yes: boolean; confirm: ((message: string) => Promise<boolean>) | null },
  runner: Runner = defaultRunner,
): AutostartDeps {
  return {
    platform: process.platform,
    runner,
    env: process.env,
    user: () => {
      const name = userInfo().username;
      const domain = process.env.USERDOMAIN;
      return process.platform === "win32" && domain ? `${domain}\\${name}` : name;
    },
    self: selfCommand,
    daemonRunning: async (target) => {
      try {
        const host = loadHost(target);
        return (await HostdClient.connect(host.state.root, 1000)) !== null;
      } catch {
        return false;
      }
    },
    confirm: options.confirm,
    yes: options.yes,
  };
}

// ---- names and quoting -----------------------------------------------------------------------

/** The workspace folder: the folder of `host.toml`. */
export function workspaceOf(target: HostTarget): string {
  return dirname(resolve(target.hostToml));
}

/**
 * A short stable identifier of the workspace: 8 hex digits of the hash of its folder (case folded
 * and `/`-separated on Windows, where paths are case-insensitive), so two workspaces on one
 * machine never share an entry and the same one always finds its own.
 */
export function workspaceId(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let key = resolve(workspace).replaceAll("\\", "/");
  key = key.length > 1 ? key.replace(/\/+$/, "") : key;
  if (platform === "win32") key = key.toLowerCase();
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function entryName(id: string): string {
  return `Miyoria-hostd-${id}`;
}

/** The command the entry runs: the daemon only, and it starts what `host.toml` enables. */
export function hostdCommand(self: readonly string[], target: HostTarget): string[] {
  return [...self, "hostd", "-c", target.configPath, "--host-config", target.hostToml, "--start"];
}

/** Windows (CreateProcess) command line: every argument in double quotes. */
export function windowsArgs(args: readonly string[]): string {
  return args.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(" ");
}

/** A command as shown to a person (quotes only where needed). */
export function display(command: string, args: readonly string[]): string {
  const q = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
  return [command, ...args].map(q).join(" ");
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** One systemd command-line word: quoted, with `\`, `"`, `%` and `$` escaped (systemd.syntax(7)). */
export function systemdWord(word: string): string {
  const escaped = word
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

// ---- the plan --------------------------------------------------------------------------------

export interface AutostartPlan {
  platform: "win32" | "linux";
  /** Task name / unit name. */
  name: string;
  /** The daemon command line the entry runs. */
  command: string[];
  /** The file written first, and what it holds. */
  file: { path: string; content: string | Buffer };
  /** Commands that register it, in order. */
  register: { command: string; args: string[] }[];
  /** Commands that remove it, in order. */
  unregister: { command: string; args: string[] }[];
  /** Exits 0 when it is registered. */
  query: { command: string; args: string[] };
}

export class AutostartUnsupported extends Error {
  override readonly name = "AutostartUnsupported";
}

export function windowsTaskXml(options: {
  user: string;
  conhost: string;
  command: readonly string[];
  workspace: string;
  description: string;
}): string {
  const user = xmlEscape(options.user);
  const args = `--headless ${windowsArgs(options.command)}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(options.description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(options.conhost)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(options.workspace)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** The task definition as the file `schtasks /create /xml` reads: UTF-16 LE with a byte order mark. */
export function utf16(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

export function systemdUnit(options: {
  workspace: string;
  command: readonly string[];
  path: string | undefined;
}): string {
  const lines = [
    "[Unit]",
    `Description=Miyoria hostd (${options.workspace.replaceAll("%", "%%").replace(/[\r\n]/g, " ")})`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${options.workspace.replaceAll("%", "%%")}`,
    `ExecStart=${options.command.map(systemdWord).join(" ")}`,
  ];
  if (options.path) lines.push(`Environment=${systemdWord(`PATH=${options.path}`)}`);
  lines.push("Restart=on-failure", "RestartSec=10", "", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

export function planAutostart(
  target: HostTarget,
  runDir: string,
  deps: Pick<AutostartDeps, "platform" | "env" | "user" | "self" | "unitDir">,
): AutostartPlan {
  const workspace = workspaceOf(target);
  const id = workspaceId(workspace, deps.platform);
  const name = entryName(id);
  const command = hostdCommand(deps.self(), target);
  if (deps.platform === "win32") {
    const system = deps.env.SystemRoot ?? deps.env.windir ?? "C:\\Windows";
    const conhost = `${system}\\System32\\conhost.exe`;
    const file = join(runDir, `autostart-${id}.xml`);
    return {
      platform: "win32",
      name,
      command,
      file: {
        path: file,
        content: utf16(
          windowsTaskXml({
            user: deps.user(),
            conhost,
            command,
            workspace,
            description: `Miyoria hostd for ${workspace}, started when ${deps.user()} logs in`,
          }),
        ),
      },
      register: [{ command: "schtasks", args: ["/create", "/tn", name, "/xml", file, "/f"] }],
      unregister: [{ command: "schtasks", args: ["/delete", "/tn", name, "/f"] }],
      query: { command: "schtasks", args: ["/query", "/tn", name] },
    };
  }
  if (deps.platform === "linux") {
    const dir =
      deps.unitDir ??
      join(deps.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
    const unit = `${name}.service`;
    return {
      platform: "linux",
      name: unit,
      command,
      file: {
        path: join(dir, unit),
        content: systemdUnit({ workspace, command, path: deps.env.PATH }),
      },
      register: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", unit] },
      ],
      unregister: [
        { command: "systemctl", args: ["--user", "disable", "--now", unit] },
        { command: "systemctl", args: ["--user", "daemon-reload"] },
      ],
      query: { command: "systemctl", args: ["--user", "is-enabled", unit] },
    };
  }
  throw new AutostartUnsupported(
    deps.platform === "darwin"
      ? t.autostart.macosUnsupported
      : t.autostart.unsupported(deps.platform),
  );
}

// ---- commands --------------------------------------------------------------------------------

async function isRegistered(plan: AutostartPlan, deps: AutostartDeps): Promise<boolean> {
  const result = await deps.runner(plan.query.command, plan.query.args, { timeoutMs: 30_000 });
  return !result.missing && result.code === 0;
}

async function confirmed(message: string, deps: AutostartDeps): Promise<boolean> {
  if (deps.yes) return true;
  if (deps.confirm === null) {
    throw new HostCommandError(t.autostart.needsConfirmation);
  }
  return deps.confirm(message);
}

/** The state folder for the launcher file; `host.toml` is needed for it. */
function runDirOf(target: HostTarget): string {
  return loadHost(target).state.run;
}

function plainPlan(target: HostTarget, deps: AutostartDeps, runDir: string): AutostartPlan {
  try {
    return planAutostart(target, runDir, deps);
  } catch (error) {
    if (error instanceof AutostartUnsupported) throw new HostCommandError(error.message);
    throw error;
  }
}

function printCommands(title: string, commands: AutostartPlan["register"]): void {
  println(`${title}`);
  for (const c of commands) println(`  ${bold(display(c.command, c.args))}`);
}

async function runAll(commands: AutostartPlan["register"], deps: AutostartDeps): Promise<void> {
  for (const c of commands) {
    const r = await deps.runner(c.command, c.args, { timeoutMs: 60_000 });
    if (r.missing) throw new HostCommandError(t.autostart.commandNotFound(c.command));
    if (r.code !== 0) {
      const detail = `${r.stderr}${r.stdout}`.trim();
      fail(
        t.autostart.commandFailed(
          display(c.command, c.args),
          r.code !== null ? String(r.code) : "?",
          detail !== "" ? detail : null,
        ),
      );
      // schtasks answers in the language of Windows: English, or Chinese ("拒絕", "存取").
      if (deps.platform === "win32" && /denied|拒絕|存取/i.test(detail)) {
        note(t.autostart.needsAdmin);
      }
      throw new HostCommandError(t.autostart.notCompleted);
    }
  }
}

export async function autostartOn(target: HostTarget, deps: AutostartDeps): Promise<void> {
  const plan = plainPlan(target, deps, runDirOf(target));
  const registered = await isRegistered(plan, deps);
  const running = await deps.daemonRunning(target);
  // A hostd already running would make the new unit's first start fail ("already running").
  const register =
    plan.platform === "linux" && running
      ? plan.register.map((c) => ({ ...c, args: c.args.filter((a) => a !== "--now") }))
      : plan.register;

  section(t.autostart.onTitle(registered));
  println(t.autostart.workspace(workspaceOf(target)));
  println(t.autostart.runs(bold(display(plan.command[0] as string, plan.command.slice(1)))));
  println(t.autostart.writes(plan.file.path));
  printCommands(t.autostart.systemCommands, register);
  if (!(await confirmed(t.autostart.confirmOn, deps))) {
    warn(t.autostart.notRegistered);
    return;
  }
  mkdirSync(dirname(plan.file.path), { recursive: true });
  writeFileSync(plan.file.path, plan.file.content);
  await runAll(register, deps);
  ok(t.autostart.registered(plan.name));
  if (plan.platform === "win32") {
    println(t.autostart.windowsNext);
    println(t.autostart.windowsTry(bold(`schtasks /run /tn ${plan.name}`)));
    println(t.autostart.windowsLogs(loadHost(target).state.logs));
    println(dim(t.autostart.windowsHeadless));
  } else {
    // `RestartSec=10` of the unit.
    println(t.autostart.linuxNext(t.common.seconds(10)));
    println(t.autostart.linuxLinger(bold("loginctl enable-linger")));
    if (running) note(t.autostart.linuxNoNow);
  }
  const undo = plan.unregister.map((c) => display(c.command, c.args)).join(" && ");
  println(
    t.autostart.undoHint(
      bold("miyoria host autostart off"),
      undo,
      plan.platform === "win32" ? null : plan.file.path,
    ),
  );
}

export async function autostartOff(target: HostTarget, deps: AutostartDeps): Promise<void> {
  // The run folder is only needed to build the plan; `off` works without a host.toml.
  const runDir = existsSync(target.hostToml) ? runDirOf(target) : join(workspaceOf(target), "run");
  const plan = plainPlan(target, deps, runDir);
  const registered = await isRegistered(plan, deps);
  const fileThere = plan.platform === "linux" && existsSync(plan.file.path);
  if (!registered && !fileThere) {
    note(t.autostart.nothingToUndo);
    return;
  }
  section(t.autostart.offTitle);
  printCommands(t.autostart.systemCommands, registered ? plan.unregister : []);
  if (plan.platform === "linux") println(t.autostart.deletes(plan.file.path));
  if (!(await confirmed(t.autostart.confirmOff, deps))) {
    warn(t.autostart.notRemoved);
    return;
  }
  if (registered) await runAll(plan.unregister, deps);
  rmSync(plan.file.path, { force: true });
  ok(t.autostart.removed(plan.name));
}

export async function autostartStatus(target: HostTarget, deps: AutostartDeps): Promise<void> {
  const runDir = existsSync(target.hostToml) ? runDirOf(target) : join(workspaceOf(target), "run");
  const plan = plainPlan(target, deps, runDir);
  const registered = await isRegistered(plan, deps);
  println(t.autostart.workspace(workspaceOf(target)));
  println(t.autostart.entryName(plan.name));
  if (registered) {
    ok(t.autostart.registeredStatus);
    println(t.autostart.runsIndented(display(plan.command[0] as string, plan.command.slice(1))));
    const saved = existsSync(plan.file.path) ? readFileSync(plan.file.path) : null;
    if (saved !== null && Buffer.compare(saved, Buffer.from(plan.file.content)) !== 0) {
      warn(t.autostart.stale);
    }
  } else {
    println(t.autostart.notRegisteredStatus(dim(t.autostart.notRegistered)));
  }
  println(
    t.autostart.daemonNow(
      (await deps.daemonRunning(target)) ? t.autostart.running : dim(t.autostart.notRunning),
    ),
  );
}
