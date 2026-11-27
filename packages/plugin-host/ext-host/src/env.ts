// The environment of an extension process. Extensions used to inherit the core's whole
// `process.env`, which holds its secrets (`LLM_API_KEY`, `DISCORD_BOT_TOKEN`,
// `MIYORIA_API_TOKEN`, ...). Now they get:
//
// 1. a fixed platform allowlist (`BASE_ENV`: what runtimes and the OS need to start, find
//    executables, temp and home directories, locale);
// 2. the host variables the manifest declares (`[env] pass`), or the owner's `env_pass`
//    instead, never a credential by wildcard (the rule below `ExtensionEnv`);
// 3. the literal values of `[extensions."<id>"] env`;
// 4. `MIYORIA_RPC` and `MIYORIA_EXTENSION_ID`, always.
//
// The owner's `[extensions."<id>"] secrets` come on top (`extensionSecrets`), handed to the
// launcher separately so it can keep them on machines the owner trusts.
//
// Not passed on purpose: `NODE_OPTIONS` (a dev loader of the core is no business of an
// extension), proxies (their URLs may carry credentials; pass them explicitly if needed).

/** Platform variables every extension gets (matched case-insensitively on Windows). */
export const BASE_ENV: readonly string[] = [
  // Finding executables and the OS.
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  // Temp, home and per-user directories.
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  // Who and where.
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  // Terminal output of their logs.
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  // TLS trust stores (paths, not secrets).
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/** What an extension may receive besides `BASE_ENV`. */
export interface ExtensionEnv {
  /** Host variable names (or `PREFIX*`) passed through. */
  pass: readonly string[];
  /** Values set for the process (win over everything but the protocol variables). */
  set: Readonly<Record<string, string>>;
  /**
   * `pass` is the owner's (`[extensions."<id>"] env_pass`), not the manifest's: an exact name
   * there may be one of Core's own credentials (`CORE_SECRET_PREFIXES`).
   */
  owner?: boolean;
}

// The rule for credentials (`looksLikeSecret`):
//
// 1. A wildcard (`PREFIX*`), whoever wrote it, never matches a name that looks like a credential.
//    `LLM_*` in a manifest used to hand over `LLM_API_KEY`, `MIYORIA_*` every Core token. A
//    wildcard is for an extension's settings (`MIYORIA_MC_URL`, `MIYORIA_MC_DIR`); a key or
//    token is one name, so naming it costs one line and says plainly what is handed over.
// 2. By exact name a credential passes, unless it is one Core itself lives on (provider keys,
//    the platform token, the service tokens: `CORE_SECRET_PREFIXES`) and only the manifest asked:
//    those reach an extension only by the owner's own word (`env_pass`, `secrets`, or a literal
//    `env` value), because with them a stranger's program could spend the owner's money or speak
//    as her.
//
// A credential held back is reported by name (never its value) so the owner sees why an
// extension misses it (`ExtensionEnvReport.held`).

/** Words that make a variable name a credential (`MIYORIA_MC_TOKEN`, `OPENAI_API_KEY`). */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  "KEY",
  "KEYS",
  "TOKEN",
  "TOKENS",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWORDS",
  "PASSWD",
  "PASS",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "AUTH",
  "COOKIE",
  "COOKIES",
  "SESSION",
  "PRIVATE",
  "PAT",
  "DSN",
  "WEBHOOK",
  "SIGNATURE",
]);

/** Does `name` look like it holds a credential (one of its `_` words is a `SECRET_WORDS`, or `…KEY`)? */
export function looksLikeSecret(name: string): boolean {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .some((word) => SECRET_WORDS.has(word) || (word.length > 3 && word.endsWith("KEY")));
}

/**
 * Families of Core's own credentials (the `${...}` names in `miyoria.example.toml` and what Core
 * reads from its environment): a manifest never gets one of these, whatever it names.
 */
export const CORE_SECRET_PREFIXES: readonly string[] = [
  "LLM_",
  "DISCORD_",
  "OPENAI_",
  "ANTHROPIC_",
  "CLAUDE_",
  "GEMINI_",
  "GOOGLE_",
  "DEEPSEEK_",
  "OPENROUTER_",
  "GROQ_",
  "MISTRAL_",
  "XAI_",
  "AZURE_",
  "AWS_",
  "TAVILY_",
  "GITHUB_",
  "GH_",
  "HF_",
  "HUGGINGFACE_",
  "OBS_",
  "VOICE_LINK_",
  "STAGE_LINK_",
  "FRIEND_SING_",
  "DATABASE_",
  "MIYORIA_API_",
  "MIYORIA_SERVICE_",
  "MIYORIA_HOST_",
  "MIYORIA_GITHUB_",
  "MIYORIA_HLS_",
  "MIYORIA_MCP_",
  "MIYORIA_PANEL_",
  "MIYORIA_OWNER",
];

/** A credential of Core's own (`looksLikeSecret` and under `CORE_SECRET_PREFIXES`). */
export function isCoreSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return looksLikeSecret(upper) && CORE_SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

interface Patterns {
  exact(name: string): boolean;
  wildcard(name: string): boolean;
}

function patterns(list: readonly string[], caseless: boolean): Patterns {
  const norm = (s: string) => (caseless ? s.toUpperCase() : s);
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of list) {
    if (p.endsWith("*")) prefixes.push(norm(p.slice(0, -1)));
    else exact.add(norm(p));
  }
  return {
    exact: (name) => exact.has(norm(name)),
    wildcard: (name) => {
      const n = norm(name);
      return prefixes.some((prefix) => prefix !== "" && n.startsWith(prefix));
    },
  };
}

/** `extensionEnv` with the credentials the rule held back. */
export interface ExtensionEnvReport {
  env: Record<string, string>;
  /** Names `pass` matched that were not handed over (see the rule above), sorted. */
  held: string[];
}

/**
 * The environment of extension `id`: `BASE_ENV` and `env.pass` from `source` (default
 * `process.env`) under the credential rule, then `env.set`, then the protocol variables.
 */
export function extensionEnv(
  id: string,
  env: ExtensionEnv = { pass: [], set: {} },
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return extensionEnvReport(id, env, source, platform).env;
}

export function extensionEnvReport(
  id: string,
  env: ExtensionEnv = { pass: [], set: {} },
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ExtensionEnvReport {
  const caseless = platform === "win32";
  const base = patterns(BASE_ENV, caseless);
  const passed = patterns(env.pass, caseless);
  const out: Record<string, string> = {};
  const held: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (base.exact(name)) {
      out[name] = value;
      continue;
    }
    const exact = passed.exact(name);
    if (!exact && !passed.wildcard(name)) continue;
    const secret = looksLikeSecret(name);
    if (secret && (!exact || (env.owner !== true && isCoreSecret(name)))) {
      held.push(name);
      continue;
    }
    out[name] = value;
  }
  // A configured value replaces an inherited one, whatever its case on Windows.
  for (const [name, value] of Object.entries(env.set)) {
    if (caseless) {
      for (const key of Object.keys(out)) {
        if (key.toUpperCase() === name.toUpperCase()) delete out[key];
      }
    }
    out[name] = value;
  }
  out.MIYORIA_RPC = "stdio";
  out.MIYORIA_EXTENSION_ID = id;
  return { env: out, held: held.sort() };
}

/**
 * The values of the variables the owner named in `[extensions."<id>"] secrets` (missing ones
 * are left out). Kept apart from the environment so a launcher can decide where they may go.
 */
export function extensionSecrets(
  names: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const caseless = platform === "win32";
  const out: Record<string, string> = {};
  for (const wanted of names) {
    const found = caseless
      ? Object.keys(source).find((k) => k.toUpperCase() === wanted.toUpperCase())
      : Object.hasOwn(source, wanted)
        ? wanted
        : undefined;
    const value = found === undefined ? undefined : source[found];
    if (value !== undefined && value !== "") out[wanted] = value;
  }
  return out;
}
