// Messages of value checks (`validate.ts`). The schema wordings are fragments: `must be a number`
// stands alone (capitalized there) or after the part of the value it is about (`[0] must be ...`).

export const validate = {
  httpUrl: "Must be a URL starting with http:// or https://, e.g. http://127.0.0.1:8001",
  wsUrl: "Must be a URL starting with ws:// or wss://, e.g. ws://127.0.0.1:7882/stage-link",
  sqlitePath: "SQLite needs a file path, e.g. sqlite:data/miyoria.db",
  noPostgres: "PostgreSQL is no longer supported; use sqlite:data/miyoria.db or memory://",
  databaseUrl: "Must be sqlite:data/miyoria.db or memory://",
  port: "Port must be an integer from 1 to 65535",
  bind: "Format: host:port, e.g. 127.0.0.1:7878",
  discordId: "A Discord ID has 17–20 digits (Developer Mode → right-click → Copy ID)",
  modelEmpty: "The model ID cannot be empty",
  modelSpace: "The model ID cannot contain spaces",
  envName: (name: string) =>
    `\`${name}\` is not a valid environment variable name (letters, digits and underscores, e.g. LLM_API_KEY)`,
  types: {
    string: "a string",
    number: "a number",
    int: "an integer",
    boolean: "true or false",
    array: "an array",
    object: "a table",
    record: "a table",
  } as Record<string, string>,
  mustBe: (what: string) => `must be ${what}`,
  /** `exclusive`: the maximum itself is not allowed either. */
  tooBig: (max: string, exclusive: boolean) =>
    exclusive ? `must be less than ${max}` : `must be at most ${max}`,
  tooSmall: (min: string, exclusive: boolean) =>
    exclusive ? `must be greater than ${min}` : `must be at least ${min}`,
  oneOf: (values: string) => `must be one of ${values}`,
  /** A wording that stands alone. */
  sentence: (fragment: string) => fragment.charAt(0).toUpperCase() + fragment.slice(1),
  unknownKey: (key: string) => `\`${key}\` is not a key this table accepts`,
  keyString: (key: string) => `\`${key}\` must be a string`,
  keyBoolean: (key: string) => `\`${key}\` must be true or false`,
  idsArray: 'Must be an array, e.g. ["123456789012345678"]',
  idsString: 'Server IDs must be strings, e.g. ["123456789012345678"]',
};
