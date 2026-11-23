// Messages of `miyoria doctor`. The findings of the install checks are in `stack`; the output of
// `--print-hashes` is TOML for a service.toml and is not translated.

export const doctor = {
  /** One fix of a finding, under it. */
  fix: (line: string) => `    Fix: ${line}`,
  // ---- --fix ----
  fixingTitle: "Fixing (safe steps only: sync environments and download missing files)",
  fixing: (service: string) => `Fixing ${service}`,
  nothingToFix: "Nothing to fix automatically",
  fixNeedsHostToml: "--fix requires host.toml",
  // ---- --print-hashes ----
  unknownService: (service: string) => `No service named ${service} in the catalog`,
  // ---- the install checks ----
  check: "Check",
  /** A group of checks that threw: `label` is one of `groups`. */
  interrupted: (label: string, error: string) => `${label} was interrupted: ${error}`,
  groups: {
    hostd: "hostd",
    services: "Services",
    ports: "Ports",
    health: "Health checks",
    vram: "VRAM",
    state: "State folder",
    builds: "Builds",
    temp: "Temporary files",
  },
  noServicesEnabled: "host.toml enables no services (add one with `miyoria add <service>`)",
  stateFolder: "State folder",
  stateWritable: (dir: string) => `${dir} is writable`,
  stateNotWritable: (dir: string, code: string) => `${dir} is not writable (${code})`,
  stateFix:
    "Check the folder permissions and the antivirus's protected-folder settings, or point [paths] state in host.toml to another folder",
  // ---- run ----
  configFile: "Configuration file",
  configFailed: (error: string) => `${error} (run \`miyoria init\` first)`,
  cannotContinue: "Cannot continue the checks",
  noHostToml: (file: string) =>
    `${file} not found; service checks skipped (create it with \`miyoria add <service>\`, or convert an older configuration with \`miyoria host migrate\`)`,
  servicesTitle: "Services on this machine",
  failed: (count: number) =>
    `${count} ${count === 1 ? "check" : "checks"} failed. Run \`miyoria doctor --fix\` to apply safe repairs.`,
  stackPassed: "Deployment checks passed",
  machineReady: "Everything this machine needs is in place",
  profile: "Profile",
  profileOk: (name: string, sections: number) =>
    `${name} (${sections} ${sections === 1 ? "persona section" : "persona sections"})`,
  /** `ms`: `common.int`. */
  llmOk: (model: string, reply: string, ms: string) => `${model} replied "${reply}" in ${ms} ms`,
  disabled: "Disabled",
  noDiscordToken: "DISCORD_BOT_TOKEN is not set",
  database: "Database",
  databaseFailed: (url: string, error: string) => `${url}: ${error}`,
  allPassed: "All checks passed",
  // ---- Discord ----
  discordStatus: (status: number) => `Discord API returned ${status}; check DISCORD_BOT_TOKEN`,
  noMessageContent: (bot: string) =>
    `Bot \`${bot}\` does not have the Message Content Intent enabled (Developer Portal → Bot → Privileged Gateway Intents)`,
  /** `intents`: `common.list`. */
  missingIntents: (bot: string, intents: string) =>
    `Bot \`${bot}\` does not have ${intents} enabled (Developer Portal → Bot → Privileged Gateway Intents), and Discord refuses the connection without them. Alternatively, stop requesting them with \`miyoria config set modules."platform.discord.bot".presence_intents false\``,
  bot: (bot: string) => `Bot \`${bot}\``,
};
