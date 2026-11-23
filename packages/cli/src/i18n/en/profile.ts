// Messages of `miyoria profile list | show | use | new`.

export const profile = {
  // ---- list ----
  noProfiles: (dir: string) => `No profiles in ${dir}`,
  ownData: "own config and data",
  installData: "config and data of the installation",
  // ---- show ----
  current: (line: string) => `Current profile: ${line}`,
  /** How the running profile was chosen. */
  sourceEnv: (name: string) => `environment variable ${name}`,
  sourceDefault: "default",
  showSource: (value: string) => `  Selected by  ${value}`,
  showConfig: (path: string) => `  Config       ${path}`,
  showData: (path: string) => `  Data         ${path}`,
  showPersona: (path: string) => `  Persona      ${path}`,
  // ---- use ----
  noInstall: (path: string) =>
    `${path} not found. Run \`miyoria init\` first to create the configuration.`,
  notFolderName: (id: string) => `"${id}" is not a valid folder name`,
  notProfile: (dir: string) => `${dir} is not a profile (no profile.toml)`,
  /** `data`: `dataOwn` or `dataOf`. */
  nextStart: (id: string, data: string) =>
    `Core runs ${id} from its next start (${data}). A running Core switches only after a restart: \`miyoria restart core\``,
  dataOwn: "its own config and data",
  dataOf: (path: string) => `the config and data of ${path}`,
  envOverrides: (name: string, value: string) =>
    `The environment variable ${name}=${value} overrides core.profile`,
  // ---- new ----
  badId: (id: string) =>
    `"${id}" cannot be used as a profile name: use lowercase letters, digits, - or _`,
  exists: (dir: string) => `${dir} already exists. No existing profile is overwritten.`,
  created: (dir: string) => `Created ${dir}`,
  newPersona: (path: string) =>
    `  Persona  ${path} (identity.md and style.md: who the character is and how it speaks)`,
  newConfig: (path: string) =>
    `  Config   ${path} ([character]: the character's name and short name)`,
  newSecrets: (path: string) =>
    `  Secrets  ${path} (this character's own LLM keys and Discord token; never those of another character)`,
  newData: (path: string) => `  Data     ${path}`,
  newNext: (id: string) =>
    `When the files are ready, run \`miyoria profile use ${id}\` and restart Core`,
};
