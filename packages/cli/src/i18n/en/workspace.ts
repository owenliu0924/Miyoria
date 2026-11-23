// Messages of the configuration files: the workspace, references, TOML editing, profiles.

export const workspace = {
  removed: (key: string, old: string) => `- ${key} (was ${old})`,
  readFailed: (path: string, error: string) => `Could not read ${path}: ${error}`,
  invalidToml: (path: string, error: string) => `${path} is not valid TOML: ${error}`,
  notFound: (path: string) =>
    `${path} not found. Run \`miyoria init\` first to create the configuration.`,
  envOverride: (name: string) =>
    `${name} is also set as a system environment variable, which overrides the .env value at run time`,
  scaffoldProfile: (path: string, id: string) => `${path} (bundled profile ${id})`,
  scaffoldData: (path: string) => `${path} (database folder)`,
  writeFailed: (path: string, error: string) => `Could not write ${path}: ${error}`,
  sources: {
    process: "environment variable",
    default: "default",
    unset: "not set",
  },
  empty: "(empty)",
  profileOwn: "its own settings and data",
  profileShared: "the installation's settings and data",
  profileLine: (character: string, id: string, where: string) =>
    `${character} (profile ${id}, ${where})`,
  toml: {
    unclosedQuote: (key: string) => `\`${key}\`: unclosed quote`,
    quoteNeeded: (key: string, ch: string) =>
      `\`${key}\`: a key part containing \`${ch}\` must be quoted, e.g. modules."voice.link".bind`,
    emptyPart: (key: string) => `\`${key}\`: empty key part`,
    unexpected: (key: string, next: string) => `\`${key}\`: unexpected \`${next}\``,
    emptyKey: "The key is empty",
    inArrayTable: (key: string) =>
      `\`${key}\` is inside an [[array of tables]]; edit it with \`miyoria config edit\``,
    isTable: (key: string) => `\`${key}\` is a table and cannot be set to a single value`,
    notTable: (key: string) => `\`${key}\` is a single value, not a table`,
  },
};
