// Messages of `src/stack/`: the install checks of `miyoria doctor` (`checks`, `hostChecks`), the
// build targets (`builds`), the old launcher's plan (`plan`), machine roles (`roles`) and `[stack]`
// (`config`). A finding is printed as `<what>  <detail>`, with each fix on its own line.

export const stack = {
  checks: {
    // ---- ports ----
    winnatList:
      "List the reserved ranges from an administrator PowerShell: netsh interface ipv4 show excludedportrange protocol=tcp",
    winnatRestart:
      "Restarting WinNAT usually releases them: net stop winnat, then net start winnat (the reservation may return after a reboot)",
    winnatMove:
      "For a lasting fix, move the dynamic port range to start at 49152: netsh int ipv4 set dynamic tcp start=49152 num=16384 (requires a reboot; Miyoria never changes this setting itself)",
    dynamicPortRange: "Dynamic port range",
    dynamicPortLow: (start: number) =>
      `Starts at ${start} (Windows default: 49152); Hyper-V or WinNAT may reserve Miyoria's ports at startup`,
    dynamicPortOk: (start: number) => `Starts at ${start}`,
    port: (port: number, label: string) => `Port ${port} (${label})`,
    inReservedRange: (start: number, end: number) =>
      `In the Windows reserved range ${start}-${end}`,
    bindDenied: "Windows denies binding to it",
    /** `where`: `inReservedRange` or `bindDenied`. */
    portBlocked: (where: string) =>
      `${where}; the service cannot bind to it (EACCES) although no program is using it`,
    portOurs: "A Miyoria service is listening",
    portForeign:
      "Another program is listening; unless it is Miyoria, the service cannot bind to this port",
    portForeignFind: (port: number) =>
      `Find the process: netstat -ano | findstr :${port} (the last column is the PID)`,
    portForeignStop:
      "If it is an old Miyoria process, stop it first; `miyoria up` does not end other programs",
    portUntestable: "Could not test this port",
    portFree: "Available",
    // ---- builds ----
    /** `label`: a build target's label. */
    build: (label: string) => `${label} build`,
    rebuildStale: "Run `miyoria update` to rebuild (only outdated targets are rebuilt)",
    notBuiltUnused: "Not built (the configuration does not use it)",
    buildWhenNeeded: "Run `miyoria update --force` when it is needed",
    notBuiltOrEmpty: "Not built, or the last build failed and left an empty output",
    runUpdate: "Run `miyoria update`",
    modJar: "Mod jar (build)",
    notBuilt: "Not built",
    runUpdateJdk: "Run `miyoria update` (requires JDK 21)",
    jdkOnPath: "on PATH",
    /** `onPath`: the major version of the `java` on PATH, when there is one. */
    jdkMissing: (onPath: number | null) =>
      `JDK 21 not found${onPath !== null ? ` (the java on PATH is version ${onPath})` : ""}`,
    jdkInstall: "Install Temurin 21: winget install EclipseAdoptium.Temurin.21.JDK",
    jdkJavaHome:
      "Or set JAVA_HOME to a JDK 21 (`miyoria update` uses the JDK 21 it finds and does not change system settings)",
    /** `missing`: `jdkMissing`. */
    jdkNeededLater: (missing: string) => `${missing}; required the next time the mod changes`,
    protocolVersion: "Mod protocol version",
    protocolMismatch: (source: number, doc: number) =>
      `Protocol.java says ${source} but PROTOCOL.md says ${doc}; the adapter follows the document`,
    protocolFix: "Change both together, then run `miyoria update`",
    protocolOk: (version: number) => `protocol ${version}`,
    installedMod: "Installed mod",
    noMinecraftDir: "minecraft_dir is not set; cannot compare the mod jar installed in the game",
    minecraftDirExample:
      '[extensions."miyoria.minecraft"] minecraft_dir = "<Prism instance>\\.minecraft"',
    noBridgeJar: (mods: string) => `No miyoria-bridge jar in ${mods}`,
    runUpdateCopy: "Run `miyoria update` (it asks before copying)",
    modSame: "Same as the built jar",
    /** `files`: the installed jars, `common.list`. */
    modDiffers: (files: string) =>
      `Not the current build: ${files} (a common cause of a missing adapter or task executor)`,
    modReplace:
      "Close the game, then run `miyoria update` (it backs up the old jar before copying)",
    // ---- temporary files ----
    tempFiles: "Temporary files",
    /** `size`: `common.mb`. */
    tempOk: (dir: string, size: string) => `Can write, read and delete a ${size} file in ${dir}`,
    tempFailed: (dir: string, code: string) =>
      `Large file operations failed in ${dir} (${code}); antivirus locking temporary files is the usual cause`,
    tempNoBuildWeb:
      "Do not use `pnpm build:web`; use `miyoria update` (vite with --minify false --target esnext)",
    tempExclusion:
      "Alternatively, add the temporary folder to the antivirus exclusion list (a setting to change yourself)",
    esbuildTemp: "esbuild temporary files",
    esbuildLeftovers: (dir: string, count: number) =>
      `${count} esbuild-* ${count === 1 ? "file remains" : "files remain"} in ${dir} (a previous build was blocked)`,
    esbuildCleanup:
      "Once no build is running, they can be deleted by hand; build with `miyoria update`",
    antivirus: "Antivirus",
    antivirusFound: (product: string) =>
      `${product} detected; it may lock esbuild's temporary files and make the admin panel build fail`,
    antivirusBuild:
      "Always build with `miyoria update` (it runs vite build --minify false --target esnext)",
  },

  hostChecks: {
    // ---- per service ----
    platform: "Platform",
    /** `platforms`: `common.list`. */
    platformUnsupported: (platforms: string, here: string) =>
      `Supported only on ${platforms}; this machine is ${here}`,
    platformFix: (service: string) =>
      `Remove [services.${service}] from host.toml, or run \`miyoria remove ${service}\``,
    environment: "Python environment",
    envReady: (dir: string, extras: string | null) =>
      `${dir}${extras !== null ? ` (extras: ${extras})` : ""}`,
    /** `reasons`: hostd's reasons, `common.list`. */
    envStale: (reasons: string) =>
      `Out of sync with the current uv.lock, extras or service.toml: ${reasons}`,
    envStaleFix: "Run `miyoria doctor --fix` or `miyoria update` to sync it again",
    envMissing: (dir: string) => `Not created: ${dir}`,
    envMissingFix: (service: string) =>
      `Create it with \`miyoria add ${service}\` (or \`miyoria doctor --fix\`); install uv first if it is missing`,
    envUserManaged: (dir: string) =>
      `Uses ${dir} as set in host.toml (Miyoria leaves it unchanged)`,
    envUserMissing: (dir: string) => `The environment set in host.toml does not exist: ${dir}`,
    envUserMissingFix: (service: string) =>
      `Create it, or remove python from [services.${service}] so that Miyoria creates one`,
    systemProgram: (program: string) => `System program ${program}`,
    onPath: "Found on PATH",
    notOnPath: "Not found on PATH",
    manualItem: "Manual item",
    manualPresent: (what: string, path: string) => `${what}: ${path}`,
    manualMissing: (what: string, path: string) => `Missing ${what}: ${path}`,
    manualFix: "Miyoria does not download this; place it yourself, then run `miyoria doctor` again",
    file: (path: string) => `File ${path}`,
    /** `size`: hostd's `formatBytes`. */
    fileVerified: (size: string) => `Verified (${size})`,
    fileWrong: (detail: string) => `Invalid: ${detail}`,
    checksumMismatch: "checksum mismatch",
    fileRefetch:
      "Run `miyoria doctor --fix` to download it again (it lists the files and asks first)",
    fileMissing: (what: string, size: string, license: string, source: string) =>
      `Missing ${what} (${size}, license ${license}, from ${source})`,
    fileFetch: "Run `miyoria doctor --fix` to download it (it lists the files and asks first)",
    fileRequired: "hostd does not start this service without this file",
    model: (repo: string) => `Model ${repo}`,
    modelCached: "In the cache",
    modelMissing: "Not downloaded (the first start downloads it, which can take a long time)",
    modelPull: (service: string) => `Run \`miyoria models pull ${service}\``,
    importCheck: "Import check",
    pythonMissing: (python: string) => `${python} not found`,
    /** `modules`: Python syntax, `a, b`; `last`: the last line of the output. */
    importFailed: (modules: string, timedOut: boolean, last: string | null) =>
      `import ${modules} failed${timedOut ? " (timed out)" : ""}${last !== null ? `: ${last}` : ""}`,
    importFix: (service: string) =>
      `Run \`miyoria doctor --fix\` to sync again; if that does not help, run \`miyoria remove ${service}\` and then \`miyoria add ${service}\``,
    // ---- hostd, the Core link, the host key ----
    hostdNotRunning: "Not running",
    hostdStart: "Start it with `miyoria up` (`miyoria status` shows its state)",
    hostdRunning: (name: string, running: number, total: number) =>
      `${name}, ${running} of ${total} ${total === 1 ? "service" : "services"} running`,
    hostKeyUnreadable: (error: string) => `Cannot be read: ${error}`,
    hostKeyRejoin: "Rejoin Core with `miyoria host join`",
    hostKeyMissing: (url: string) => `${url} is set, but this machine has not joined Core yet`,
    hostKeyJoin:
      "On the Core node, run `miyoria host invite`; then run the `miyoria host join ...` command it prints on this machine",
    hostKeyOk: (id: string) => `Joined Core (host ID ${id})`,
    coreLink: "Core link",
    linkConnected: (url: string) => `Connected to ${url}`,
    linkUnauthorized: "Core rejected this machine (host.key is invalid or was revoked)",
    linkRejoin: "Rejoin with `miyoria host join`",
    linkConnecting: "Connecting; retries continue while Core is down or the URL is unreachable",
    linkReachable: (url: string) => `Check that ${url} is reachable`,
    linkNone: "Not connected",
    linkCheck: "Run `miyoria up`, then check `miyoria status`",
    // ---- health ----
    service: (name: string) => `Service ${name}`,
    /** `state`: hostd's state of the service, or `unknownToHostd`. */
    serviceNotRunning: (state: string) => `Not running (${state})`,
    unknownToHostd: "unknown to hostd",
    upService: (service: string) => `Run \`miyoria up ${service}\``,
    noAnswer: (url: string) => `${url} does not answer (not started?)`,
    upStart: "Start it with `miyoria up`",
    httpStatus: (url: string, status: number) => `${url} returned HTTP ${status}`,
    /** `models`: `common.list`. */
    modelsNotLoaded: (url: string, models: string) =>
      `${url} is running, but these models are not loaded: ${models}`,
    modelsNotLoadedFix:
      "See the errors in /health; usually the model files are missing. Download them with `miyoria doctor --fix`, then restart",
    versionMismatch: (running: string, cli: string) =>
      `The running Core is version ${running}; this CLI is ${cli}`,
    versionFix: "Restart Core to use the new version (a restart is needed after `miyoria update`)",
    healthy: (version: string | null) =>
      `Healthy${version !== null ? ` (version ${version})` : ""}`,
    // ---- VRAM ----
    vram: "VRAM",
    noSmi: "nvidia-smi not found; VRAM budget skipped (not needed without an NVIDIA GPU)",
    smiUnreadable: "Could not read the output of nvidia-smi",
    /** `used`: `common.int`; `total`: `common.mb`. */
    vramUsed: (gpu: string, used: string, total: string) => `${gpu}: ${used} / ${total} used`,
    vramBudget: "VRAM budget",
    peakResident: "when every resident service is loaded",
    peakOnDemand: (service: string) =>
      `while ${service} works, after the evictable services are unloaded`,
    /** `head`: `vramUsed`; `reserve`, `peak`: `common.mb`; `why`: `peakResident` or `peakOnDemand`. */
    vramDetail: (head: string, reserve: string, peak: string, why: string) =>
      `${head}; reserved ${reserve}; estimated peak ${peak} (${why}; the per-service estimates are [gpu] vram_mb in service.toml)`,
    /** `available`: `common.mb`. */
    vramOver: (detail: string, available: string) => `${detail}; over 92% of ${available}`,
    vramFix:
      "Set [services.<name>.gpu] policy in host.toml to evictable or on_demand, or use a smaller model (ASR_QWEN_SIZE=0.6B)",
  },

  builds: {
    noOutput: "No build output",
    /** `by`: `common.duration`. */
    stale: (by: string) => `Sources are newer than the output (by about ${by})`,
    upToDate: "Up to date with the sources",
    contracts: "Contracts (@miyoria/contracts)",
    sdk: "SDK (@miyoria/sdk)",
    extension: (id: string) => `Extension ${id}`,
    panel: "Admin panel (apps/panel)",
    overlay: "Overlay (apps/overlay)",
  },

  plan: {
    workersNeedRepository:
      "[stack.workers] works only inside a Miyoria source checkout (workers/ and pnpm-workspace.yaml not found)",
    voiceNodeNeedsRepository:
      "The voice node works only inside a source checkout (apps/voice-node)",
  },

  roles: {
    label: {
      broadcast: "Streaming machine",
      core: "Bot server",
      inference: "GPU inference machine",
    },
    help: {
      broadcast:
        "Streaming machine: Discord voice and Go Live (voice node); VTube Studio, OBS and the overlay (stage)",
      core: "Discord bot, all modules, the database and the admin panel (core); the end-of-turn worker (turn); Docker for the file sandbox",
      inference:
        "All AI models: speech recognition (asr), speech synthesis (tts) and singing (sing); all three must run on the same machine",
    },
    /** `roles`, `services`: `common.list`. */
    unknownTarget: (word: string, roles: string, services: string) =>
      `Unknown target \`${word}\`. Roles: ${roles} (or all); services: ${services}`,
    /** `services`: `common.list`. */
    custom: (services: string) => `Custom: ${services}`,
    noRoles: "(no roles selected)",
    withLabel: (role: string, label: string) => `${role} (${label})`,
  },

  config: {
    workerNeedsPort: (worker: string) => `[stack.workers.${worker}] needs a port`,
  },
};
