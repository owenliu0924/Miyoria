// Messages of `miyoria add | remove <service>` and the model files they download.

export const services = {
  /** A detail after a path or name: `m/model.bin: <detail>`. */
  detail: (subject: string, detail: string) => `${subject}: ${detail}`,
  /** Between the sentences of one error. */
  separator: "; ",
  // ---- model files ----
  filesTitle: "Model files to download",
  /** A file taken from where this machine already has it. */
  fileAdopted: (service: string, path: string, size: string, from: string) =>
    `  ${service}  ${path}  ${size}  reuses ${from} (same checksum, hard link, no download)`,
  /** `resume`: the size left when a download goes on. */
  fileToFetch: (
    service: string,
    path: string,
    size: string,
    resume: string | null,
    license: string,
    source: string,
  ) =>
    `  ${service}  ${path}  ${size}${resume !== null ? ` (resuming, ${resume} left)` : ""}  license ${license}  from ${source}`,
  /** `wrong`: why the file there now is not the right one. */
  fileWhat: (what: string, optional: boolean, wrong: string | null) =>
    `      ${what}${optional ? " (optional)" : ""}${
      wrong !== null ? `; the current file is wrong (${wrong}) and will be replaced` : ""
    }`,
  checksumMismatch: "checksum mismatch",
  filesTotal: (size: string, dir: string) => `  Total ${size}, saved to ${dir}`,
  noTerminalForFiles: (command: string) =>
    `No terminal to confirm the downloads above. To agree, run \`${command}\`.`,
  /** `files`: `common.files`. */
  confirmFiles: (files: string, size: string) => `Download ${files} (${size} in total)?`,
  downloaded: (path: string) => `downloaded and verified ${path}`,
  downloadFailed: "download failed",
  fileMissing: (path: string, detail: string | null) =>
    `${path} is missing${detail !== null ? ` (${detail})` : ""}`,
  voiceNodeNeedsRepository:
    "The voice node is not shipped with the miyoria package yet and needs the source repository: clone the project and run `miyoria add voice-node` inside it. A later release will include it in the package.",
  // ---- host.toml ----
  createdHostToml: (file: string, name: string) => `Created ${file} (name = "${name}")`,
  // ---- add ----
  unknownService: (name: string, known: string) =>
    `No service named ${name}. The catalog has:\n${known}`,
  catalogTitle: "Services available for this machine",
  added: "added",
  addedDisabled: "added (disabled)",
  catalogHint:
    "`miyoria add <service>...` adds and installs; `miyoria doctor` checks what is missing.",
  envSynced: (extras: string | null) =>
    `environment ready${extras !== null ? ` (extras: ${extras})` : ""}`,
  envCurrent: "environment is up to date",
  envUserManaged: "uses an environment you manage; left unchanged",
  envUnsupported: (detail: string) => `not supported on this platform: ${detail}`,
  uvMissing: (detail: string) => `uv not found: ${detail}`,
  uvHint: "    uv is not installed automatically; install it and run the same command again.",
  envFailed: (detail: string) => `environment setup failed: ${detail}`,
  programMissing: (program: string, hint: string | null) =>
    `${program} not found on PATH (not installed automatically)${hint !== null ? `: ${hint}` : ""}`,
  manualFile: (what: string, path: string) => `place this yourself: ${what} (${path})`,
  modelsNotPulled: (service: string, repos: string) =>
    `models not downloaded yet: ${repos} (\`miyoria models pull ${service}\`)`,
  extraOneService:
    "--extra applies to one service only (each service names its extras differently).",
  platformUnsupported: (name: string, platforms: string, platform: string) =>
    `${name} supports only ${platforms}; this machine runs ${platform}`,
  addedTo: (file: string, list: string) => `${file}: added ${list}`,
  notInstalled:
    "Not installed (--no-install). Install later with `miyoria add <service>` or `miyoria doctor --fix`.",
  filesSkipped:
    "Model files not downloaded. `miyoria doctor --fix` can fetch them later; hostd does not start a service that lacks a required file.",
  installingInDaemon: "Installing through the running hostd",
  installingHere: "hostd is not running; installing in this process",
  installing: (name: string) => `Installing ${name}`,
  /** `services`: `common.services`. */
  installFailed: (services: string) =>
    `${services} failed to install; see the messages above. Fix the problem and run the command again (completed steps are skipped).`,
  doneMark: "Done",
  /** `mark`: `doneMark`, emphasised; `todo`: something marked ! above is left to do. */
  addDone: (mark: string, todo: boolean, names: string) =>
    `${mark}${todo ? "; the items marked ! above still need attention" : ""}. Next: \`miyoria up ${names}\` (\`miyoria doctor\` checks what is missing)`,
  // ---- remove ----
  notInHostToml: (file: string, name: string) => `${file} has no [services.${name}]; skipped`,
  stopped: "stopped",
  envDeleted: (dir: string) => `deleted environment ${dir}`,
  envFromHostToml: "environment is set in host.toml; left unchanged",
  envKept: "environment kept (--keep-env)",
  removedFrom: (file: string, name: string) => `${file}: removed [services.${name}]`,
  modelsKept: "Models were left in place; `miyoria models gc` lists the ones no service uses.",
  notRemoved: (services: string) => `${services} not removed`,
};
