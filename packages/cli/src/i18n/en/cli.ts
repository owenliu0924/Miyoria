// biome-ignore-all lint/suspicious/noTemplateCurlyInString: help text names the ${VAR} syntax
// Messages of the command line: help of every command and option, parse errors.

export const cli = {
  root: "Miyoria — AI VTuber framework",
  /** The last lines of the root help. */
  rootFooter: [
    "Language: --lang, then MIYORIA_LANG, then the system locale (LC_ALL, LC_MESSAGES, LANG; on",
    "Windows, the display language). zh-TW, zh-HK and zh-Hant select Traditional Chinese; every",
    "other locale selects English.",
  ],
  usage: "Usage:",
  commandsTitle: "Commands:",
  argumentsTitle: "Arguments:",
  optionsTitle: "Options:",
  optionsWord: "[options]",
  commandOptional: "[command]",
  commandRequired: "<command>",
  defaultValue: (value: string) => `[default: ${value}]`,
  errors: {
    unknownOption: (token: string) => `Unknown option \`${token}\``,
    needsValue: (token: string, value: string) => `\`${token}\` requires a value <${value}>`,
    unknownCommand: (token: string) => `Unknown command \`${token}\``,
    extraArgument: (token: string) => `Unexpected argument \`${token}\``,
    missingArgument: (name: string) => `Missing argument <${name}>`,
    conflict: (option: string, arg: string) => `--${option} cannot be combined with <${arg}>`,
    integer: (option: string) => `--${option} must be an integer`,
    timeout: "--timeout must be a positive integer (seconds)",
    lines: "--lines must be 0 or a positive integer",
    limit: "--limit must be a positive integer",
    badLang: (value: string) => `Unsupported language \`${value}\` for --lang; use en or zh-TW`,
  },
  cancelled: "Cancelled; no files were written",
  options: {
    config: "Path to miyoria.toml",
    yes: "Skip all confirmations and write or apply directly",
    help: "Show help",
    version: "Show the version",
    lang: "Language of messages: en or zh-TW (default: MIYORIA_LANG, then the system locale)",
    hostConfig:
      "Path to host.toml (default: host.toml in the folder of miyoria.toml; that folder is the workspace)",
    force: "Stop even during singing or a live stream",
  },
  cmd: {
    init: {
      help: "Setup wizard: first asks what this machine runs (Core with text only, Core with voice, or a worker node), then the LLM, Discord, database and admin panel sign-in. Safe to re-run; press Enter to keep current values",
      mode: "What this machine runs, skipping the first question: text (Core, text only; default), voice (Core with voice) or service (worker node)",
      services:
        "With --mode service: the services this machine provides (comma-separated, e.g. asr,tts); omit to choose interactively",
      notTty:
        "in scripts, use `miyoria init --yes` (accept all defaults) or `miyoria config set <key> <value>`",
      modeChoice: (modes: string) => `--mode must be one of: ${modes}`,
      servicesNeedMode: "--services can only be used with --mode service",
    },
    config: {
      help: "Change settings (without a subcommand, opens an interactive menu that changes one item at a time)",
      list: "List all settings with their effective values (secrets masked; values from .env marked)",
      reveal: "Show secrets in plain text",
      get: "Show the effective value of one setting, e.g. `core.profile`",
      getKey: "Dotted key, e.g. modules.api.bind or 'modules.\"voice.link\".bind'",
      getEnv: "Read a .env variable instead",
      set: "Set a value, e.g. `set core.log debug`; for a key that references ${VAR}, the .env variable is updated",
      setArgName: "key value",
      setArg:
        '<key> <value> (the value is parsed as TOML: 3, true, ["a"]; anything else is a string)',
      setEnv: "Write a .env variable instead: `set --env LLM_API_KEY sk-...`",
      unset: "Remove a setting (or a .env variable with `--env NAME`)",
      unsetKey: "Dotted key",
      unsetEnv: "Remove a .env variable",
      edit: "Open miyoria.toml in an editor ($VISUAL or $EDITOR; Notepad by default on Windows)",
      overrides:
        "List settings changed in the admin panel (stored in the database, overriding miyoria.toml), with the file value and who changed them",
      bake: "Write the admin panel's changes into miyoria.toml (comments are kept), then clear them from the database",
      import:
        "Import miyoria.toml into the database as the next configuration revision (admin panel changes are kept; per-channel and per-server values move to those scopes). Back up the database first and preview with --dry-run",
      importDryRun: "List what would change without writing",
      importReplace:
        "Replace the database configuration with the file as it is (admin panel changes are removed; the revision history is kept). Required to import again after an earlier import",
    },
    doctor: {
      help: "Check the configuration file, profile, LLM, Discord, database and every service enabled in host.toml (environment, system programs, files, models, hostd, Core connection). --deep adds imports, ports, health checks, VRAM, builds and temporary files; --fix applies only safe repairs",
      deep: "Also check: check_imports with each environment's Python, Windows reserved ports, service health, VRAM budget, stale dist and mod jar, JDK 21, temporary files",
      deepOnly: "Only the --deep deployment checks (no LLM, Discord or database connections)",
      fix: "Apply only safe repairs: sync missing or stale environments and download missing or invalid model files (install.files; sizes and licenses are listed for one confirmation, -y skips it). Never installs system programs or changes system settings",
      printHashes:
        "Only print the SHA-256 and size of this service's files on this machine (install.files and install.manual), in service.toml syntax for [[install.files]]",
    },
    db: {
      help: "Database cutover tools (offline): check a file, archive a stopped V4 database, import identities into the new database",
      importLinks:
        "Import people, accounts, handles, privacy and voice consent, and keepsake card data from a V4 database into the database at core.database_url. Reads the old file only; re-running creates no duplicates",
      from: "The V4 database (usually the .single.db made by db archive)",
      importDryRun: "List what would be imported and how much, without writing",
      archive:
        "Move a stopped V4 database (.db with its -wal and -shm files) into data/archive/, make a single-file copy and record its hash. Deletes nothing; safe to re-run after an interruption",
      archiveFile: "Database to archive; omit for core.database_url",
      archiveDryRun:
        "Only check whether the file is open and list what would be done, without moving anything",
      doctor:
        "Read-only check of a database file: V4, V5 or empty, whether Core would refuse it, migrations, integrity, number of people and events; for V4, also what import-links would bring over",
      doctorFile: "File to check; omit for core.database_url",
    },
    memory: {
      help: "Offline memory tools: rebuild the character's memory (notes and episodes) from the event log",
      rebuild:
        "Re-run segmentation over the chats in the event log with the configured model, adding note lines and episodes. Previews by default (segments, lines, estimated tokens and cost) without calling the model. Only adds; never deletes or replaces existing memory. Progress is stored in the database, so an interrupted run can resume",
      file: "Database file; omit for core.database_url",
      since: "Only process chats after this time (ISO date)",
      apply: "Run for real (calls the model and incurs cost); without it, only a preview",
      maxUsd: "Stop when spending reaches this amount; the run can resume later",
      force: "Proceed even if another program has the database open (for example, a running Core)",
    },
    add: {
      help: "Add services to this machine: write them to host.toml, build their environments with uv, download missing model files (sizes and licenses are listed for one confirmation, -y skips it) and list anything still missing. Without a name, lists the catalog",
      service: "Service name (asr, tts, sing, turn, lyrics ...)",
      noInstall: "Only write host.toml; do not build environments or download",
      extra:
        "Extras to sync (comma-separated, e.g. sensevoice); written to extras in [services.<name>]; one service only",
    },
    remove: {
      help: "Remove services from this machine: stop them, delete their environments (downloaded models are kept) and remove them from host.toml",
      service: "Service name",
      keepEnv: "Keep the environment folder",
    },
    models: {
      help: "Models on this machine: download, list, remove unused ones",
      pull: "Download the Hugging Face models listed in a service's service.toml; omit names for every service enabled in host.toml",
      service: "Service name",
      ls: "List the models in the model folder, their sizes and which services use them",
      gc: "List models no enabled service uses and delete them after confirmation (-y deletes without asking)",
    },
    hostd: {
      help: "Run this machine's hostd in this terminal (`up` starts it in the background); Ctrl+C stops all services",
      start:
        "Start every service enabled in host.toml once hostd is up (autostart at login uses this; without it, only hostd itself starts)",
    },
    up: {
      help: "Ask hostd to start this machine's services (every service enabled in host.toml, or the ones named); starts hostd in the background first if it is not running",
      service: "Service name; omit for every service enabled in host.toml",
      foreground:
        "Supervise in this terminal and show the status, without a background hostd; Ctrl+C stops everything in reverse order",
      timeout:
        "Maximum seconds to wait (hostd keeps starting; check with status); default: wait until every service has a result",
      noWait: "Return once hostd has the request; do not wait for health checks",
      noLink:
        "Do not link this machine to the local Core once Core is up (default: link when this machine has neither host.key nor [cluster], the same as `host join --local`)",
    },
    down: {
      help: "Stop services; without names, stop all of them and exit hostd",
      service: "Service name; omit for all services, and hostd exits",
    },
    restart: {
      help: "Restart a service; refused during singing or a live stream unless --force is given",
      service: "Service name",
      timeout: "Maximum seconds to wait",
    },
    status: {
      help: "Status of this machine's services (hostd) and of the running Core: modules and LLM usage; --all adds every host known to Core",
      all: "Also list every host in Core and the services of the connected ones (through Core's admin API)",
    },
    logs: {
      help: "Show a service's log file (<state>/logs/<service>.log)",
      service: "Service name",
      follow: "Keep showing new lines; Ctrl+C to stop",
      lines: "Number of trailing lines to show first",
    },
    host: {
      help: "This machine's settings (host.toml) and the links between hosts: join a Core, invite, approve, remove",
      invite:
        "On the Core node: create an invite code (single use, valid for 10 minutes by default) and print the join command to run on the other machine",
      inviteName: "Name of the host that joins with this code",
      ttl: "Minutes the invite code is valid (1 to 10080)",
      join: "Join this machine to a Core: with an invite code (Core on another machine) or --local (Core on this machine)",
      coreUrl: "Address of Core's admin API, e.g. http://192.168.1.10:7878",
      code: "Invite code from `host invite`",
      joinName:
        "Name of this machine in Core (default: name in host.toml, otherwise the operating system's host name)",
      local:
        "Core runs on this machine: no invite code; the admin API creates and approves this host directly (capabilities from the services enabled in host.toml)",
      joinForce: "Join again even if this machine already has host.key",
      ls: "List the hosts known to Core: status, connection, approved capabilities, platform, version, last seen",
      approve:
        "Approve a host so its services are used; without capabilities, approves everything it currently reports",
      hostName: "Host name",
      capability: "Capabilities to approve (asr, tts, sing ...)",
      remove:
        "Remove a host from Core: its key is revoked, its connection closed and its services no longer used",
      autostart:
        "Start hostd at login on this machine (hostd then starts the services enabled in host.toml): on registers, off unregisters, status shows the state",
      autostartOn:
        "Register: start hostd when this account logs in (Windows: a Task Scheduler task for this user; Linux: a systemd user unit). Prints the commands first and asks for confirmation",
      autostartOff: "Unregister; does nothing when autostart is not registered",
      autostartStatus:
        "Whether autostart is registered, the command it runs, and whether hostd is running now",
      migrate:
        "Write host.toml from [machine] and [stack] in miyoria.toml, keeping the existing Python environments, ports and worker environment variables",
      migrateForce: "Overwrite an existing host.toml",
      migrateDryRun: "Only show what would be written",
    },
    update: {
      help: "git pull (--ff-only), install dependencies, rebuild only what changed (SDK, extension dist, admin panel, overlay, Minecraft mod jar), re-sync stale Python environments, and restart the running services that changed, one at a time (services in use for singing or a live stream are left until later)",
      noPull: "Skip git pull",
      force: "Rebuild everything, changed or not",
      skipMod: "Do not build or install the Minecraft mod",
      dryRun: "Only list what would be done",
      noRestart: "Sync environments without restarting any service",
    },
    core: { help: "Start Core (Discord bot, agent ...)" },
    stage: {
      help: "Start the Stage node on the streaming machine (VTube Studio, OBS, overlay)",
      obsSetup:
        "Create Miyoria's scenes and sources in OBS (background, singing layout, transparent avatar, overlay) in a scene collection and profile of their own, leaving the existing ones untouched",
      dryRun: "Only list what would be done; do not change OBS",
      relayout: "Also move existing items back to their default positions",
      collection:
        "Scene collection to build in (created if missing; default: [stage.obs] collection, otherwise Miyoria)",
      here: "Build directly in OBS's current scene collection (the earlier behavior)",
      profile:
        "OBS profile to use (created if missing; default: [stage.obs] profile, otherwise Miyoria)",
      noProfile: "Keep OBS's current profile",
      profileSettings:
        "Also set an existing profile to 1920x1080 with the replay buffer on (new profiles always get these)",
    },
    chat: {
      help: "Chat with the character in the terminal (no Discord needed)",
      name: "Your name in the conversation",
      /** The default of `--name`: the name the character sees. */
      defaultName: "You",
      withDiscord: "Also connect the Discord bot while chatting",
    },
    module: {
      help: "Manage the running Core's modules",
      list: "List modules (shows the configuration file when Core is not running)",
      offline: "(Core is not running; showing the configuration file)",
      enable: "Enable a module",
      disable: "Disable a module",
      restart: "Restart a module",
      id: "Module id",
    },
    decisions: {
      help: "Recent attention decisions (why the character replied or stayed silent)",
      limit: "Number of entries to show",
    },
    events: {
      help: "Follow Core's events live, e.g. `miyoria events 'agent.*'`",
      topics: "Event topics (wildcards allowed; omit for all)",
    },
    persona: {
      help: "Persona sections of the running Core",
      show: "Show all persona sections",
      set: "Replace a section with the contents of a file (`-` for stdin)",
      key: "Section name",
      file: "File path or `-`",
    },
    profile: {
      help: "Profiles: one runs at a time, each with its own persona, settings and data; hosts and pairings are shared",
      list: "List this installation's profiles (● marks the one that runs)",
      show: "The profile that runs now: the character's name, configuration file and folder",
      use: "Run this profile the next time Core starts (writes core.profile in miyoria.toml; restart a running Core)",
      useId: "Folder name under profiles/",
      new: "Create a new, empty profile: persona templates, its own miyoria.toml, .env and data/ under profiles/<id>/",
      newId: "Folder name (lowercase letters, digits, - or _)",
      newName: "The character's name (default: the id)",
      validate: "Load and check the current profile",
    },
    discord: {
      help: "Discord bot tools",
      commands: "Slash commands",
      reset:
        "Delete the bot's slash commands globally and in every server (clears duplicate old commands; Core registers them again at its next start)",
    },
    ext: {
      help: "Extensions (offline tools; `dev` starts Core with hot reload)",
      new: "Create a TypeScript extension skeleton",
      name: "Package name",
      dir: "Parent folder",
      list: "List the extensions found",
      install: "Install from a local path or git URL",
      source: "Path or git URL",
      validate: "Check an extension's manifest",
      validateDir: "Extension folder",
      dev: "Start Core with extension hot reload",
    },
  },
};
