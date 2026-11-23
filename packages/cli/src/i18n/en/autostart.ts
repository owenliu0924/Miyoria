// Messages of `miyoria host autostart on | off | status`.

export const autostart = {
  macosUnsupported:
    "Starting hostd at logon is not supported on macOS yet. Start it with `miyoria up`.",
  unsupported: (platform: string) => `Starting hostd at logon is not supported on ${platform}.`,
  needsConfirmation: "This command needs confirmation. Run it in a terminal, or add -y.",
  commandNotFound: (command: string) => `${command} not found`,
  commandFailed: (command: string, code: string, detail: string | null) =>
    `${command} failed (exit code ${code})${detail !== null ? `: ${detail}` : ""}`,
  needsAdmin:
    'This machine requires administrator rights to create a logon task. Run the same command again in a terminal opened with "Run as administrator". The task itself stays the same: it runs under your account, with standard privileges, in your logon session.',
  notCompleted: "The system commands did not complete.",
  // ---- on ----
  onTitle: (update: boolean) =>
    `Start hostd at logon (${update ? "updating the existing entry" : "new entry"})`,
  workspace: (dir: string) => `Workspace: ${dir}`,
  runs: (command: string) => `Runs: ${command}`,
  writes: (file: string) => `Writes: ${file}`,
  deletes: (file: string) => `Deletes: ${file}`,
  systemCommands: "System commands to run:",
  confirmOn: "Register it?",
  notRegistered: "Not registered",
  registered: (name: string) => `Registered ${name}`,
  windowsNext:
    "The next time this account logs in, Task Scheduler starts hostd in your logon session without a window, and hostd starts the services enabled in host.toml.",
  windowsTry: (command: string) =>
    `  To try it now: ${command} (first check with \`miyoria status\` that no hostd is running)`,
  windowsLogs: (dir: string) => `  Logs: hostd writes its log files to ${dir}`,
  windowsHeadless:
    "  The hidden window relies on conhost.exe --headless, which Microsoft does not document. If a window appears after a Windows update, run `miyoria host autostart off` and report it.",
  /** `retry`: the delay before a retry after a failure. */
  linuxNext: (retry: string) =>
    `The next time this account logs in, systemd starts hostd (and retries ${retry} after a failure).`,
  linuxLinger: (command: string) =>
    `  To start it at boot without a login: ${command} (run it once, as your own user)`,
  linuxNoNow: "hostd is already running, so --now was left out; the unit starts at the next login.",
  /** `undo`: the system commands; `file`: the unit file that is deleted too, when there is one. */
  undoHint: (command: string, undo: string, file: string | null) =>
    `To undo: ${command} (equivalent to ${undo}${file !== null ? `, then deleting ${file}` : ""})`,
  // ---- off ----
  nothingToUndo: "Starting hostd at logon is not registered; there is nothing to undo.",
  offTitle: "Stop starting hostd at logon",
  confirmOff: "Remove it?",
  notRemoved: "Not removed",
  removed: (name: string) => `Removed ${name}`,
  // ---- status ----
  entryName: (name: string) => `Entry name: ${name}`,
  registeredStatus: "Registered: hostd starts when this account logs in",
  runsIndented: (command: string) => `  Runs: ${command}`,
  stale:
    "The registered entry differs from the current settings (was the folder or Node moved?). Run `miyoria host autostart on` again.",
  /** `mark`: `notRegistered`, dimmed. */
  notRegisteredStatus: (mark: string) =>
    `${mark}: hostd does not start at logon (\`miyoria host autostart on\`)`,
  /** `state`: `running` or `notRunning`, possibly dimmed. */
  daemonNow: (state: string) => `hostd now: ${state}`,
  running: "running",
  notRunning: "not running",
};
