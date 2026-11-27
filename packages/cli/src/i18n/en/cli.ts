// biome-ignore-all lint/suspicious/noTemplateCurlyInString: help text names the ${VAR} syntax
// Messages of the command line: help of every command and option, parse errors. A command's
// summary starts with a verb and fits one line where it can; details go to its options.

export const cli = {
  root: "Miyoria — AI VTuber framework",
  /** The last lines of the root help. */
  rootFooter: [
    "Run `miyoria init` to set up this machine, then `miyoria doctor` to check it.",
    "Use `miyoria <command> --help` for more about a command.",
  ],
  /** Followed directly by the command line. */
  usage: "Usage: ",
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
    jsonWith: (option: string) => `--json cannot be combined with --${option}`,
  },
  cancelled: "Cancelled; no files were written",
  options: {
    config: "Path to miyoria.toml",
    yes: "Answer yes to every confirmation (for scripts)",
    help: "Show help",
    version: "Show the version",
    lang: "Language of messages: en or zh-TW. Default: MIYORIA_LANG, then the system locale (LC_ALL, LC_MESSAGES, LANG; on Windows, the display language); zh-TW, zh-HK, zh-MO and zh-Hant select Traditional Chinese, every other locale English",
    hostConfig:
      "Path to host.toml (default: host.toml next to miyoria.toml; its folder is the workspace)",
    force: "Stop even during singing or a live stream",
    json: "Print the result as JSON on stdout (nothing else goes to stdout)",
  },
  cmd: {
    init: {
      help: "Set up this machine as a Core node or a Service node. Safe to re-run; press Enter to keep a value",
      mode: "Skip the role question: text (Core node, text only; default), voice (Core node with voice) or service (Service node)",
      services:
        "With --mode service: the services this machine provides, comma-separated (e.g. asr,tts); omit to choose interactively",
      nonInteractive:
        "Ask nothing and keep every default; `init --yes` does the same. Secrets come from MIYORIA_LLM_API_KEY and MIYORIA_DISCORD_BOT_TOKEN, or from stdin with the options below, never from an option value",
      llmKeyStdin:
        "Read the LLM API key from stdin (the first line when --discord-token-stdin is also given); implies --non-interactive",
      discordTokenStdin: "Read the Discord bot token from stdin; implies --non-interactive",
      notTty:
        "in scripts, use `miyoria init --non-interactive` (`--yes` is an alias) or `miyoria config set <key> <value>`",
      modeChoice: (modes: string) => `--mode must be one of: ${modes}`,
      servicesNeedMode: "--services can only be used with --mode service",
    },
    config: {
      help: "Change settings; without a subcommand, opens an interactive menu",
      list: "List every setting and its effective value (secrets masked; values from .env marked)",
      reveal: "Show secrets in plain text",
      get: "Show the effective value of one setting, e.g. `core.profile`",
      getKey: "Dotted key, e.g. modules.api.bind or 'modules.\"voice.link\".bind'",
      getEnv: "Read a .env variable instead",
      set: "Set a value, e.g. `set core.log debug`; a key that references ${VAR} updates the .env variable",
      setArgName: "key value",
      setArg:
        '<key> <value> (the value is parsed as TOML: 3, true, ["a"]; anything else is a string)',
      setEnv: "Write a .env variable instead: `set --env LLM_API_KEY sk-...`",
      unset: "Remove a setting, or a .env variable with `--env NAME`",
      unsetKey: "Dotted key",
      unsetEnv: "Remove a .env variable",
      edit: "Open miyoria.toml in an editor ($VISUAL or $EDITOR; Notepad by default on Windows)",
      overrides:
        "List settings changed in the admin panel, with the file value and who changed them",
      bake: "Write the admin panel's changes into miyoria.toml (comments are kept) and clear them from the database",
      import:
        "Import miyoria.toml into the database as the next configuration revision (admin panel changes are kept). Back up the database first and preview with --dry-run",
      importDryRun: "List what would change without writing",
      importReplace:
        "Replace the database configuration with the file as it is (admin panel changes are removed; the revision history is kept). Required to import again after an earlier import",
    },
    doctor: {
      help: "Check this machine's configuration and services. --deep adds deployment checks; --fix applies safe repairs",
      deep: "Also check imports with each environment's Python, Windows reserved ports, service health, the VRAM budget, stale builds, JDK 21 and temporary files",
      deepOnly: "Run only the --deep deployment checks (no LLM, Discord or database connections)",
      fix: "Apply safe repairs: sync missing or stale environments and download missing or invalid model files (sizes and licenses are listed for one confirmation; -y skips it). Never installs system programs or changes system settings",
      printHashes:
        "Print the SHA-256 and size of this service's files on this machine, in service.toml syntax for [[install.files]]",
    },
    db: {
      help: "Check, archive and migrate databases (offline)",
      importLinks:
        "Import people, accounts, handles, privacy and voice consent, and keepsake cards from a V4 database into the database at core.database_url. Reads the old file only; re-running creates no duplicates",
      from: "The V4 database (usually the .single.db made by db archive)",
      importDryRun: "List what would be imported and how much, without writing",
      archive:
        "Move a stopped V4 database (.db, -wal and -shm) into data/archive/, make a single-file copy and record its hash. Deletes nothing; safe to re-run",
      archiveFile: "Database to archive; omit for core.database_url",
      archiveDryRun:
        "Check whether the file is open and list what would be done, without moving anything",
      doctor:
        "Check a database file read-only: version, whether Core would accept it, migrations, integrity and counts; for V4, also what import-links would bring over",
      doctorFile: "File to check; omit for core.database_url",
    },
    memory: {
      help: "Rebuild the character's memory from the event log (offline)",
      rebuild:
        "Re-run segmentation over the chats in the event log with the configured model, adding note lines and episodes. Previews by default (segments, lines, estimated tokens and cost) without calling the model. Only adds; never deletes or replaces memory. Progress is stored in the database, so a stopped run can resume",
      file: "Database file; omit for core.database_url",
      since: "Process only chats after this time (ISO date)",
      apply: "Run for real (calls the model and incurs cost); without it, only a preview",
      maxUsd: "Stop when spending reaches this amount; the run can resume later",
      force: "Proceed even if another program has the database open (for example, a running Core)",
    },
    add: {
      help: "Add services to this machine: write host.toml, build environments and download model files. Without a name, lists the catalog",
      service: "Service name (asr, tts, sing, turn, lyrics ...)",
      noInstall: "Only write host.toml; do not build environments or download",
      extra:
        "Extras to sync, comma-separated (e.g. sensevoice); written to extras in [services.<name>]; one service only",
    },
    remove: {
      help: "Remove services from this machine: stop them, delete their environments and remove them from host.toml (downloaded models are kept)",
      service: "Service name",
      keepEnv: "Keep the environment folder",
    },
    models: {
      help: "Download, list and clean up model files on this machine",
      pull: "Download the Hugging Face models a service's service.toml lists; omit names for every service enabled in host.toml",
      service: "Service name",
      ls: "List the models in the model folder, their sizes and which services use them",
      gc: "Delete models that no enabled service uses, after confirmation (-y deletes without asking)",
    },
    sandbox: {
      help: "The sandbox service: this machine runs code for her in Docker containers (host.toml [sandbox] says whose)",
      serve: "Run the sandbox service in this terminal (hostd starts it; for a hand-started one)",
      build:
        "Build the sandbox image (about 2 GB, minutes on the first build); -y builds without asking",
    },
    hostd: {
      help: "Run this machine's host daemon (hostd) in this terminal; Ctrl+C stops all services",
      start:
        "Start every service enabled in host.toml once hostd is up (autostart at login uses this)",
    },
    up: {
      help: "Start this machine's services through hostd, starting hostd in the background if needed",
      service: "Service name; omit for every service enabled in host.toml",
      foreground:
        "Supervise in this terminal without a background hostd; Ctrl+C stops everything in reverse order",
      timeout:
        "Maximum seconds to wait (hostd keeps starting; check with status); default: until every service has a result",
      noWait: "Return once hostd has the request, without waiting for health checks",
      noLink:
        "Do not link this machine to the local Core once Core is up (by default it is linked when there is neither host.key nor [cluster], like `host join --local`)",
    },
    down: {
      help: "Stop services; without names, stop all of them and exit hostd",
      service: "Service name; omit to stop all services and exit hostd",
    },
    restart: {
      help: "Restart a service; refused during singing or a live stream unless --force is given",
      service: "Service name",
      timeout: "Maximum seconds to wait",
    },
    status: {
      help: "Show the status of this machine's services and of Core; --all includes every host",
      all: "Also list every host known to Core and the services of the connected ones",
    },
    logs: {
      help: "Show a service's log (<state>/logs/<service>.log)",
      service: "Service name",
      follow: "Keep showing new lines; Ctrl+C to stop",
      lines: "Number of trailing lines to show first",
    },
    host: {
      help: "Manage hosts: join a Core node, invite, approve or remove Service nodes",
      invite:
        "Create a single-use invite code on the Core node (valid for 10 minutes by default) and print the join command for the other machine",
      inviteName: "Name of the host that joins with this code",
      ttl: "Minutes the invite code is valid (1 to 10080)",
      join: "Join this machine to a Core node with an invite code, or with --local when Core runs here",
      coreUrl: "Address of Core's admin API, e.g. http://192.168.1.10:7878",
      code: "Invite code from `host invite`",
      joinName:
        "Name of this machine in Core (default: name in host.toml, otherwise the system host name)",
      local:
        "Core runs on this machine: no invite code; the admin API creates and approves this host directly",
      joinForce: "Join again even if this machine already has host.key",
      ls: "List the hosts known to Core: status, connection, approved capabilities, platform, version, last seen",
      approve:
        "Approve a host so its services are used; without capabilities, approves everything it reports",
      hostName: "Host name",
      capability: "Capabilities to approve (asr, tts, sing ...)",
      remove:
        "Remove a host from Core: revoke its key, close its connection and stop using its services",
      autostart: "Start hostd when you log in to this machine: on, off or status",
      autostartOn:
        "Register hostd to start at login (Windows: a Task Scheduler task for this user; Linux: a systemd user unit). Prints the commands and asks first",
      autostartOff: "Unregister autostart; does nothing when it is not registered",
      autostartStatus:
        "Show whether autostart is registered, what it runs and whether hostd is running",
      migrate:
        "Write host.toml from [machine] and [stack] in an older miyoria.toml, keeping its Python environments, ports and service environment variables",
      migrateForce: "Overwrite an existing host.toml",
      migrateDryRun: "Show what would be written without writing",
    },
    update: {
      help: "Update Miyoria: pull, install dependencies, rebuild what changed and restart changed services one at a time",
      noPull: "Skip git pull",
      force: "Rebuild everything, changed or not",
      skipMod: "Do not build or install the Minecraft mod",
      dryRun: "List what would be done without doing it",
      noRestart: "Sync environments without restarting any service",
    },
    core: { help: "Start Core (Discord bot, agent ...)" },
    stage: {
      help: "Start the Stage node on the streaming machine (VTube Studio, OBS, overlay)",
      obsSetup:
        "Create Miyoria's scenes and sources in OBS, in a scene collection and profile of their own",
      dryRun: "List what would be done without changing OBS",
      relayout: "Also move existing items back to their default positions",
      collection:
        "Scene collection to build in (created if missing; default: [stage.obs] collection, otherwise Miyoria)",
      here: "Build in OBS's current scene collection instead (the earlier behavior)",
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
      help: "List, enable, disable or restart the running Core's modules",
      list: "List modules (shows the configuration file when Core is not running)",
      offline: "(Core is not running; showing the configuration file)",
      enable: "Enable a module",
      disable: "Disable a module",
      restart: "Restart a module",
      id: "Module id",
    },
    decisions: {
      help: "Show recent attention decisions (why the character replied or stayed silent)",
      limit: "Number of entries to show",
    },
    events: {
      help: "Follow Core's events live, e.g. `miyoria events 'agent.*'`",
      topics: "Event topics (wildcards allowed; omit for all)",
    },
    persona: {
      help: "Show or replace the running Core's persona sections",
      show: "Show all persona sections",
      set: "Replace a section with the contents of a file (`-` for stdin)",
      key: "Section name",
      file: "File path or `-`",
    },
    profile: {
      help: "Manage profiles: one runs at a time, each with its own persona, settings and data",
      list: "List this installation's profiles (● marks the one that runs)",
      show: "Show the profile that runs: the character's name, configuration file and folder",
      use: "Run this profile the next time Core starts (writes core.profile; restart a running Core)",
      useId: "Folder name under profiles/",
      new: "Create an empty profile under profiles/<id>/ with persona templates, its own miyoria.toml, .env and data/",
      newId: "Folder name (lowercase letters, digits, - or _)",
      newName: "The character's name (default: the id)",
      validate: "Load and check the current profile",
    },
    discord: {
      help: "Manage the Discord bot",
      commands: "Manage slash commands",
      reset:
        "Delete the bot's slash commands globally and in every server; Core registers them again at its next start",
    },
    ext: {
      help: "Create, install and check extensions (`dev` starts Core with hot reload)",
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
