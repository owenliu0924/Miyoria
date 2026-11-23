// Messages of `miyoria update`. Lines of the form `<label>  <state>` keep the two spaces.

export const update = {
  // ---- git ----
  notGit: "Not a git checkout; skipping pull",
  wouldPull: "Would run: git pull --ff-only (skipped if the working tree has uncommitted changes)",
  gitMissing: "git not found; skipping pull",
  dirtyTree:
    "The working tree has uncommitted changes; skipping git pull (use --no-pull to hide this message)",
  pullFailed: "git pull --ff-only failed (diverged branch or no network?)",
  pullAborted: "Pull failed; no builds were changed",
  pulled: "Updated to the latest commit",
  alreadyCurrent: "Already up to date",
  // ---- pnpm install ----
  depsCurrent: "Dependencies  match pnpm-lock.yaml",
  wouldInstall: "Would run: pnpm install",
  installing: "Installing dependencies (pnpm install)...",
  installFailed: "pnpm install failed",
  installAborted: "Dependencies could not be installed; the remaining builds were not run",
  depsInstalled: "Dependencies  installed",
  // ---- builds ----
  building: (label: string) => `Building ${label}...`,
  buildRetry: (label: string) =>
    `${label} build failed; retrying without minification (common when antivirus locks esbuild's temporary files)`,
  buildFailed: (label: string, timedOut: boolean) =>
    `${label} build failed${timedOut ? " (timed out)" : ""}; the output was left unchanged`,
  noIndexHtml: (label: string) =>
    `${label} build finished without index.html; the existing dist is kept`,
  swapFailed: (label: string, error: string) =>
    `${label} was built, but replacing dist failed: ${error}`,
  swapHint: (next: string) =>
    `The new output is in ${next}; close the program that holds dist and rename it by hand`,
  built: (label: string) => `${label}  built`,
  unusedSkipped: "not used; skipped",
  /** `why`: the freshness detail, or `notBuilt`; `command`: the build command line. */
  wouldBuild: (label: string, why: string, command: string) =>
    `Would build ${label} (${why}): ${command}`,
  notBuilt: "not built",
  // ---- Minecraft mod ----
  wouldBuildMod:
    "Would run gradlew build with JDK 21 (the mod is older than its sources, or not built)",
  /** `missing`: `stack.checks.jdkMissing`. */
  modNoJdk: (missing: string) => `${missing}; the mod was not rebuilt`,
  modJdkFix: "    Fix: winget install EclipseAdoptium.Temurin.21.JDK, or set JAVA_HOME to a JDK 21",
  buildingMod: (home: string) => `Building the Minecraft mod (JDK ${home})...`,
  modBuildFailed: "Mod build failed",
  modBuilt: "Minecraft mod  built",
  modCurrent: "Minecraft mod  jar matches the sources",
  wouldCopyMod: (mods: string) =>
    `Would compare the miyoria-bridge jar in ${mods} and, if it differs, back it up and copy the new one (after confirmation)`,
  modSame: "Installed mod  same as the build",
  askCopy: (jar: string, mods: string) => `Copy ${jar} to ${mods}?`,
  /** `installed`: `common.list`. */
  askReplace: (jar: string, mods: string, installed: string, backup: string) =>
    `Replace ${installed} in ${mods} with ${jar}? The old files are backed up to ${backup} first (close the game before continuing).`,
  modNotConfirmed: "Installed mod not updated (not confirmed; add --yes for automation)",
  modUpdated: (backup: string | null) =>
    `Installed mod  updated${backup !== null ? `; old files backed up to ${backup}` : ""}`,
  /** `busy`: the jar is locked (EBUSY, EPERM). */
  copyFailed: (code: string, busy: boolean) =>
    `Copying the mod failed (${code}). ${busy ? "If the game or launcher is still open, close it and run again" : "Check the folder permissions"}`,
  // ---- packaged install ----
  upgradeHint:
    "Installed from npm: upgrade the package with `npm update -g miyoria` (pnpm: `pnpm update -g miyoria`), then run `miyoria update` again",
  // ---- services ----
  noHostToml:
    "No host.toml; skipping service sync and restarts (`miyoria add <service>` creates it)",
  servicesSection: "Services",
  envsCurrent: "Environments match uv.lock, extras and service.toml",
  /** `services`: `common.list`. */
  wouldSync: (services: string) => `Would sync environments: ${services}`,
  wouldStopSyncStart: (services: string) =>
    `Would stop, sync and start again (guarded): ${services}`,
  wouldRestart: (services: string) => `Would restart (guarded): ${services}`,
  asksFirst: "Asks once before downloading (--yes skips the question)",
  /** `service`: bold; `detail`: hostd's reason. */
  guarded: (service: string, detail: string) =>
    `${service}  busy with singing or a live stream; left running: ${detail}`,
  filesSkipped:
    "Model files not downloaded; run `miyoria doctor --fix` later to get them (hostd does not start a service that lacks a required file)",
  /** `commands`: `miyoria restart <service>` per service, `common.list`. */
  notRestarted: (services: string, commands: string) =>
    `Not restarted (--no-restart): ${services}. To use the new version: ${commands}`,
  busyNotRestarted: (services: string, commands: string) =>
    `Not restarted because they are busy: ${services}. When they are idle, run ${commands} (for a service whose environment needs syncing, run \`miyoria update\` again)`,
  // ---- run ----
  incomplete: (count: number) =>
    `${count} ${count === 1 ? "step" : "steps"} did not complete; see the messages above`,
  planTitle: "Update plan (dry run; nothing is changed)",
  done: "Done.",
  doneNoRestart:
    "Done. Services already running were not restarted (--no-restart); run `miyoria restart <service>` to use the new version.",
};
