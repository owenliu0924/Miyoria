// Messages of `miyoria config` (the menu, `list | get | set | unset | edit`, the admin panel's
// layer and `import`), and of the change summary `miyoria init` shares with it.

export const config = {
  // ---- writing (also `miyoria init`) ----
  create: (file: string) => `Create ${file}`,
  noChanges: "No changes",
  summaryTitle: "Pending changes",
  confirmWrite: "Write these changes?",
  nothingWritten: "No files were written",
  wrote: (file: string) => `Wrote ${file}`,
  // ---- after writing ----
  /** The area of a `[stage]` key in the restart list. */
  stageArea: "stage node",
  /** The area of a profile change in the restart list. */
  profileArea: "profile",
  notRunning: "Core is not running; the changes apply at its next start.",
  enable: (id: string) => `enable ${id}`,
  disable: (id: string) => `disable ${id}`,
  applyNow: (toggles: string) => `Core is running. Apply now (${toggles})?`,
  actionFailed: (id: string, error: string) => `${id}: ${error}`,
  applyLater: "Core is running: run `miyoria module enable|disable <id>` to apply immediately",
  restartNeeded: (areas: string) =>
    `Core is running. Module settings are read when Core starts; these changes take effect after a restart: ${areas}`,
  restartHow:
    "Press Ctrl+C in the window running Core, then run `miyoria core` again (on a stage node, run `miyoria stage` again)",
  // ---- the menu ----
  areas: {
    profile: "Profile",
    llm: "LLM",
    discord: "Discord bot",
    oauth: "Admin panel sign-in (Discord OAuth)",
    voice: "Voice (ASR / TTS workers, voice link)",
    stage: "Stage (VTube Studio / OBS)",
    database: "Database",
    owner: "Owner",
    tokens: "Tokens (regenerate)",
    modules: "Modules",
    done: "Done",
  },
  tokenStatus: (state: string) => `token ${state}`,
  oauthOn: "enabled",
  tokensStatus: (set: number, total: number) => `${set}/${total} set`,
  modulesStatus: (enabled: number, total: number) => `${enabled}/${total} enabled`,
  pickModules: "Which modules should be enabled? (Space to toggle)",
  pickToken: "Which token should be regenerated?",
  regenerateWarning: (name: string) =>
    `After ${name} is regenerated, connections that use the old token stop working`,
  shareToken: (name: string) =>
    `To use it on other nodes: miyoria config get --env ${name} --reveal`,
  voiceLinkToken: 'The voice link token is under "Tokens"',
  ownerUnreferenced:
    "miyoria.toml does not reference MIYORIA_OWNER_ID (owners in [modules.commands])",
  intro: "Miyoria configuration",
  menuHelp:
    'Pick an item to change; only the fields you pick are changed. Esc goes back; pick "Done" to exit.',
  menuQuestion: "Which item do you want to configure?",
  areaCancelled: "Cancelled this item; nothing was written",
  outro: "Configuration complete",
  // ---- list / get ----
  plainSecret: "(plain text; move it to .env)",
  unreferenced: "(not referenced by miyoria.toml)",
  placesHeader: "Per-server and per-channel values (they override the value above):",
  /** The database holds what the file says. */
  sourceSame: (version: number, by: string, at: string) =>
    `(source: database revision ${version} (${by}, ${at}), same as miyoria.toml)`,
  /** `layer`: `layerSet`; `file`: the file's value, or `null` when the file does not set it. */
  sourceDatabase: (layer: string, file: string | null) =>
    `(source: database; ${layer}; miyoria.toml: ${file ?? "not set"})`,
  sourceFile: "(source: miyoria.toml)",
  sourceOf: (source: string) => `(source: ${source})`,
  /** A `${NAME}` value: the file's text and where each variable comes from. */
  resolvedFrom: (raw: string, sources: string) => `(miyoria.toml: ${raw}; ${sources})`,
  envNotSet: (name: string) => `${name} is not set`,
  needKey: "Specify a key, for example `miyoria config get core.profile`",
  noKeyInFile: (key: string) =>
    `miyoria.toml has no \`${key}\` (run \`miyoria config list\` to see every key)`,
  // ---- the admin panel's layer ----
  byImport: "imported into the database",
  byPanel: "changed in the admin panel",
  /** `who`: `byImport` or `byPanel`. */
  layerSet: (who: string, value: string, version: number, by: string, at: string) =>
    `${who}: ${value} (revision ${version}, ${by}, ${at})`,
  fileIgnored: (layer: string) => `${layer}; the value in the file is not used`,
  placeSpace: (name: string) => `server ${name}`,
  /** `space`: the server the channel is in, when known. */
  placeRoom: (room: string, space: string | null) =>
    `channel ${room}${space !== null ? ` (${space})` : ""}`,
  placeValue: (where: string, value: string) => `${where}: ${value}`,
  noDatabaseNoOverrides: "No database found, so there are no admin panel overrides",
  noOverrides: "No admin panel overrides",
  overrideDetail: (file: string | null, version: number, by: string, at: string) =>
    `file: ${file ?? "not set"} · revision ${version} · ${by} · ${at}`,
  nothingToBake: "No admin panel overrides; nothing to write",
  bakeThenClear: (n: number) =>
    `  Then clears ${n === 1 ? "this admin panel value" : `these ${n} admin panel values`} from the database`,
  confirmBake: "Write to miyoria.toml and clear the admin panel values?",
  bakeNotWritten: "No files were written (use --yes to write without asking)",
  baked: "Cleared the admin panel values; miyoria.toml is now the only source",
  bakedNote:
    "If Core is running, the values its modules use do not change (the file and the admin panel agree); from its next start Core reads them from the file",
  // ---- import ----
  more: (n: number) => `  …and ${n} more`,
  importNoDatabase: (file: string) =>
    `Database ${file} not found. Start Core once so that it creates the database, then import.`,
  importSecrets: (keys: string) =>
    `miyoria.toml has secret values written directly in the file: ${keys}. The database does not store secrets: move them to .env first (\`miyoria config set <key> <value>\` moves them automatically), write \${NAME} in the file instead, then import again. Nothing was written.`,
  /** `version` and `at` of the import that is already there (`?` when unknown). */
  alreadyImported: (version: string, at: string) =>
    `Already imported (revision ${version}, ${at}); nothing was written. To replace the database's settings with miyoria.toml, add --replace (values changed in the admin panel since then are removed; the revision history is kept)`,
  importHeader: (file: string, database: string, dryRun: boolean) =>
    `Import ${file} → ${database}${dryRun ? " (dry run, nothing is written)" : ""}`,
  importUnchanged: "Settings: same as the database's current settings; no new revision",
  importChanged: (next: number, replace: boolean, changed: number) =>
    `Settings: revision ${next}${replace ? " (--replace: the file replaces them as it is)" : ""}; ${changed} ${changed === 1 ? "key differs" : "keys differ"} from the current settings`,
  importPanelKept: "Values changed in the admin panel, kept (they override the file):",
  importPlacesWrite: "Written to per-server and per-channel settings:",
  importPlacesKeep:
    "These servers and channels already have their own values, kept (only --replace overwrites them):",
  importKeptGlobal: "Kept at the level of all servers (they cannot be attributed to one server):",
  importServer: "server",
  importChannel: "channel",
  importNewPlace: " (new)",
  importDryRun: "Dry run: nothing was written. Run again without --dry-run to write.",
  importCoreRunning:
    "Core is running: stop Core and back up the database before importing (running modules do not change; Core uses the database from its next start)",
  importNeedYes: "Review the above, then add --yes to write (or use --dry-run first)",
  importConfirm: "Write to the database?",
  importNotWritten: "Nothing was written",
  importRaced: "Nothing was written (the database was imported in the meantime)",
  imported: (version: number, places: number) =>
    `Wrote revision ${version} (author import) and ${places} per-server and per-channel ${places === 1 ? "setting" : "settings"}`,
  importedNote:
    "From now on the database is authoritative for module settings: later changes to miyoria.toml are overridden by it (`miyoria config get` reports this). To make the file the only source again, run `miyoria config bake`",
  // ---- set / unset ----
  usageSetEnv: "Usage: miyoria config set --env NAME <value>",
  usageSet: "Usage: miyoria config set <key> <value>",
  usageUnset: "Usage: miyoria config unset <key>  or  miyoria config unset --env NAME",
  envUnreferenced: (name: string) => `miyoria.toml does not reference \${${name}}`,
  isTable: (key: string) =>
    `\`${key}\` is a table; specify a key inside it, for example \`${key}.enabled\``,
  viaReference: (key: string, name: string) =>
    `${key} references \${${name}}; updated ${name} in .env`,
  secretToEnv: (name: string) =>
    `Secret values are stored in .env as ${name}; miyoria.toml references it`,
  invalidValue: (key: string, error: string) => `\`${key}\`: ${error}`,
  coveredHint:
    "Revert the key in the module's settings in the admin panel, or run `miyoria config bake` to make the file the only source",
  envMissing: (name: string) => `.env has no ${name}`,
  keyMissing: (key: string) => `miyoria.toml has no \`${key}\``,
  // ---- edit ----
  opening: (program: string, file: string) =>
    `Opening ${file} with ${program} (continues when the editor closes)`,
  editorFailed: (program: string, error: string) =>
    `Cannot start the editor \`${program}\`: ${error} (set the EDITOR environment variable)`,
  editorStatus: (status: number | null) =>
    `The editor exited with an error (exit code ${status ?? "unknown"})`,
  invalidToml: (file: string, error: string) =>
    `${file} is not valid TOML. Run \`miyoria config edit\` again to fix it:\n${error}`,
  validToml: (file: string) => `${file} is valid`,
};
