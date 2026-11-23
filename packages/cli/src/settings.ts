// Settings shared by `miyoria init` and `miyoria config`: field specs, asking for one field
// (Enter keeps the current value), and the steps that touch several keys at once (LLM,
// database, OAuth, tokens). What a field's value may be is checked by the root schema where it
// describes the key (`validate.ts`); the labels, choices and defaults here are the prompts'.

import { randomBytes } from "node:crypto";
import { t } from "./i18n/index.js";
import type { Prompter } from "./prompt.js";
import { maskUrl, singleRef } from "./refs.js";
import {
  formatKey,
  isTable,
  parseKey,
  plainValue,
  type TomlDocument,
  type TomlValue,
} from "./toml-patch.js";
import type { Check, SchemaContext } from "./validate.js";
import * as validate from "./validate.js";
import type { Workspace } from "./workspace.js";

export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:7878/api/auth/oauth/callback";
export const DEFAULT_SQLITE_URL = "sqlite:data/miyoria.db";
export const LLM_KINDS = ["deepseek", "openai", "openai-compatible", "opencode"] as const;

export function defaultBaseUrl(kind: string): string | undefined {
  switch (kind) {
    case "deepseek":
      return "https://api.deepseek.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "opencode":
      return "https://opencode.ai/inference/go/v1";
    default:
      return undefined;
  }
}

function defaultModel(kind: string): string {
  return kind === "deepseek" ? "deepseek-chat" : "";
}

function apiKeyVar(kind: string): string {
  return kind === "opencode" ? "OPENCODE_API_KEY" : "LLM_API_KEY";
}

export type Kind =
  | { type: "text" }
  | { type: "url" }
  | { type: "ws_url" }
  | { type: "bind" }
  | { type: "port" }
  | { type: "bool" }
  /** Optional Discord id. */
  | { type: "id" }
  /** Comma separated Discord ids, stored as an array of strings. */
  | { type: "ids" }
  | { type: "secret" }
  | { type: "choice"; options: readonly string[] };

const TEXT: Kind = { type: "text" };
const URL_KIND: Kind = { type: "url" };
const SECRET: Kind = { type: "secret" };

/**
 * The CLI's own check of a kind of field. `described`: the root schema describes the key, so
 * the range of a port and what a list of ids may hold are its to say; the formats it does not
 * say (a URL, `host:port`, one Discord id) are checked either way.
 */
function formatCheck(kind: Kind, described: boolean): Check | undefined {
  switch (kind.type) {
    case "url":
      return validate.httpUrl;
    case "ws_url":
      return validate.wsUrl;
    case "bind":
      return validate.bind;
    case "port":
      return described ? undefined : validate.port;
    case "id":
      return validate.optionalDiscordId;
    case "ids":
      return described ? undefined : validate.discordIds;
    default:
      return undefined;
  }
}

/** The prompt's check of a field: the root schema where it describes the key, then the format. */
export function checkOf(field: Field, ctx: SchemaContext | null): Check | undefined {
  const path = field.key === null ? null : parseKey(field.key);
  const described = path !== null && validate.described(ctx, path);
  const format = formatCheck(field.kind, described);
  if (path === null || !described) return format;
  return (s) => {
    if (field.kind.type === "port" && !/^\d+$/.test(s.trim())) return t.settings.portInteger;
    return validate.schemaCheck(ctx, path, typed(field.kind, s)) ?? format?.(s) ?? null;
  };
}

/**
 * One editable setting: a `miyoria.toml` key, a `.env` variable, or a key whose secret lives in
 * `.env` (`env` names the variable to use when the key has no `${VAR}` reference yet).
 */
export interface Field {
  /** Read when shown: a getter for the fields defined at the top level. */
  readonly label: string;
  key: string | null;
  env: string | null;
  kind: Kind;
  default: string;
}

/** A label, or the function giving it in the active language. */
export type Label = string | (() => string);

function labelled(label: Label, field: Omit<Field, "label">): Field {
  const get = typeof label === "string" ? () => label : label;
  return Object.defineProperty({ ...field }, "label", { get, enumerable: true }) as Field;
}

export function tomlField(
  label: Label,
  key: string,
  kind: Kind,
  extra: Partial<Omit<Field, "label">> = {},
): Field {
  return labelled(label, { key, env: null, kind, default: "", ...extra });
}

export function envField(label: Label, env: string, kind: Kind): Field {
  return labelled(label, { key: null, env, kind, default: "" });
}

const f = () => t.settings.fields;

export const PROFILE = tomlField(() => f().profile, "core.profile", TEXT);
export const DATABASE = tomlField("DATABASE_URL", "core.database_url", TEXT, {
  env: "DATABASE_URL",
});
export const DISCORD_TOKEN = tomlField(
  () => f().discordToken,
  'modules."platform.discord.bot".token',
  SECRET,
  { env: "DISCORD_BOT_TOKEN" },
);
export const DISCORD_GUILDS = tomlField(
  () => f().discordGuilds,
  'modules."platform.discord.bot".command_guilds',
  { type: "ids" },
);
export const OWNER = envField(() => f().owner, "MIYORIA_OWNER_ID", { type: "id" });
export const OAUTH_CLIENT_ID = tomlField(
  () => f().oauthClientId,
  "modules.api.discord_oauth.client_id",
  { type: "id" },
  { env: "DISCORD_CLIENT_ID" },
);
export const OAUTH_SECRET = tomlField(
  () => f().oauthSecret,
  "modules.api.discord_oauth.client_secret",
  SECRET,
  { env: "DISCORD_CLIENT_SECRET" },
);
export const OAUTH_REDIRECT = tomlField(
  () => f().oauthRedirect,
  "modules.api.discord_oauth.redirect_uri",
  URL_KIND,
  { default: DEFAULT_REDIRECT_URI },
);
export const API_BIND = tomlField(
  () => f().apiBind,
  "modules.api.bind",
  { type: "bind" },
  {
    default: "127.0.0.1:7878",
  },
);

export const VOICE: readonly Field[] = [
  tomlField(() => f().asrUrl, "speech.asr.local.url", URL_KIND, {
    default: "http://127.0.0.1:8003",
  }),
  tomlField(() => f().ttsUrl, "speech.tts.local.url", URL_KIND, {
    default: "http://127.0.0.1:8002",
  }),
  tomlField(() => f().ttsVoice, "speech.tts.local.voice", TEXT),
  tomlField(
    () => f().voiceLink,
    'modules."voice.link".bind',
    { type: "bind" },
    {
      default: "127.0.0.1:7879",
    },
  ),
  tomlField(
    () => f().consent,
    "modules.voice.consent",
    { type: "choice", options: ["opt-out", "opt-in"] },
    {
      default: "opt-out",
    },
  ),
  tomlField(
    () => f().bargeIn,
    "modules.voice.barge_in",
    // `[modules.voice] barge_in`'s own values and default (`selective`).
    { type: "choice", options: ["selective", "stop", "ignore"] },
    {
      default: "selective",
    },
  ),
];

export const STAGE: readonly Field[] = [
  tomlField(
    () => f().stageCoreUrl,
    "stage.core_url",
    { type: "ws_url" },
    {
      default: "ws://127.0.0.1:7882/stage-link",
    },
  ),
  tomlField(
    () => f().stageBind,
    'modules."stage.link".bind',
    { type: "bind" },
    {
      default: "127.0.0.1:7882",
    },
  ),
  tomlField(() => f().vts, "stage.vts.enabled", { type: "bool" }, { default: "true" }),
  tomlField(() => f().obs, "stage.obs.enabled", { type: "bool" }, { default: "false" }),
  tomlField(() => f().obsHost, "stage.obs.host", TEXT, { default: "127.0.0.1" }),
  tomlField(() => f().obsPort, "stage.obs.port", { type: "port" }, { default: "4455" }),
  tomlField(() => f().obsPassword, "stage.obs.password", SECRET, { env: "OBS_PASSWORD" }),
];

/** Every static field, for `miyoria config set` on known secret keys. */
export function allFields(): Field[] {
  return [
    PROFILE,
    DATABASE,
    DISCORD_TOKEN,
    DISCORD_GUILDS,
    OWNER,
    OAUTH_CLIENT_ID,
    OAUTH_SECRET,
    OAUTH_REDIRECT,
    API_BIND,
    ...VOICE,
    ...STAGE,
  ];
}

/** `[variable, keys referencing it, what uses it]`. */
export function tokens(): ReadonlyArray<readonly [string, readonly string[], string]> {
  return [
    ["MIYORIA_API_TOKEN", ["modules.api.token"], t.settings.tokens.api],
    ["VOICE_LINK_TOKEN", ['modules."voice.link".token'], t.settings.tokens.voice],
    ["STAGE_LINK_TOKEN", ['modules."stage.link".token', "stage.token"], t.settings.tokens.stage],
  ];
}

/** 52 random hex characters (208 bits); only authenticates local nodes / the CLI. */
export function newToken(): string {
  return randomBytes(26).toString("hex");
}

/** Current value of a field (references expanded; empty when unset). */
export interface Current {
  value: string;
  /** The key (or variable) exists at all. */
  present: boolean;
}

export function current(ws: Workspace, field: Field): Current {
  if (field.key === null) {
    const found = ws.lookup(field.env ?? "");
    return { present: found !== undefined, value: found?.[0] ?? "" };
  }
  const value = ws.item(field.key);
  if (value === undefined || isTable(value)) return { value: "", present: false };
  return {
    value: typeof value === "string" ? ws.resolve(value)[0] : plainValue(value),
    present: true,
  };
}

/** `label  [current]` for pick lists; secrets only say whether they are set. */
export function fieldLabel(ws: Workspace, field: Field): string {
  const cur = current(ws, field);
  let shown: string;
  if (field.kind.type === "secret") shown = cur.value === "" ? t.common.notSet : t.common.set;
  else if (cur.value === "")
    shown = field.default === "" ? t.common.notSet : t.settings.defaultIs(field.default);
  else shown = maskUrl(cur.value);
  return `${field.label}  [${shown}]`;
}

export function secretLabel(label: string, isSet: boolean): string {
  return isSet ? t.settings.secretSet(label) : t.settings.secretUnset(label);
}

/**
 * Asks for one field with the current value as default; writes only when the answer differs.
 * Returns whether anything changed.
 */
export async function ask(p: Prompter, ws: Workspace, field: Field): Promise<boolean> {
  const cur = current(ws, field);
  let next: string;
  const kind = field.kind;
  if (kind.type === "secret") {
    const typed = (await p.secret(secretLabel(field.label, cur.value !== ""))).trim();
    if (typed === "") return false;
    next = typed;
  } else if (kind.type === "choice") {
    const want = cur.value === "" ? field.default : cur.value;
    const start = Math.max(kind.options.indexOf(want), 0);
    next = kind.options[await p.select(field.label, [...kind.options], start)] as string;
  } else if (kind.type === "bool") {
    const initial = cur.present ? cur.value === "true" : field.default === "true";
    next = String(await p.confirm(field.label, initial));
  } else {
    const initial = cur.present && cur.value !== "" ? cur.value : field.default;
    const ctx = field.key === null ? null : await validate.schemaContext(ws.doc.data);
    next = (await p.text(field.label, initial, checkOf(field, ctx))).trim();
  }
  const unchanged = cur.present ? next === cur.value : next === "" || next === field.default;
  if (unchanged) return false;
  apply(ws, field, next);
  return true;
}

/**
 * Writes a field: into the `.env` variable a key references, as a new `${VAR}` reference for
 * secrets, or as a typed TOML value.
 */
export function apply(ws: Workspace, field: Field, next: string): void {
  if (field.key === null) {
    ws.setEnv(field.env ?? "", next);
    return;
  }
  const existing = ws.item(field.key);
  const referenced = typeof existing === "string" ? singleRef(existing)?.name : undefined;
  if (referenced !== undefined) {
    ws.setEnv(referenced, next);
    return;
  }
  if (field.env !== null && (existing === undefined || field.kind.type === "secret")) {
    ws.set(field.key, `\${${field.env}:-}`);
    ws.setEnv(field.env, next);
    return;
  }
  ws.set(field.key, typed(field.kind, next));
}

function typed(kind: Kind, s: string): TomlValue {
  switch (kind.type) {
    case "bool":
      return s === "true";
    case "port": {
      // The range is checked before (the schema's, or `validate.port`); this is the parse.
      if (!/^\d+$/.test(s.trim())) throw new Error(t.settings.portInteger);
      return BigInt(s.trim());
    }
    case "ids":
      return s
        .split(/[, ]/)
        .map((p) => p.trim())
        .filter((p) => p !== "");
    default:
      return s;
  }
}

/** Multi-select which fields to change, then ask each. */
export async function editFields(
  p: Prompter,
  ws: Workspace,
  fields: readonly Field[],
): Promise<void> {
  const labels = fields.map((f) => fieldLabel(ws, f));
  const picked = await p.multiSelect(t.settings.whichToChange, labels, []);
  for (const i of picked) await ask(p, ws, fields[i] as Field);
}

// ---- profile -----------------------------------------------------------------------------

export async function profileStep(p: Prompter, ws: Workspace): Promise<boolean> {
  const ids = ws.listProfiles();
  if (ids.length === 0) return ask(p, ws, PROFILE);
  const cur = current(ws, PROFILE).value;
  if (cur !== "" && !ids.includes(cur)) ids.push(cur);
  const start = Math.max(ids.indexOf(cur), 0);
  const picked = ids[await p.select(t.settings.profile, ids, start)] as string;
  if (picked === cur) return false;
  apply(ws, PROFILE, picked);
  return true;
}

// ---- LLM ---------------------------------------------------------------------------------

export interface LlmState {
  provider: string;
  kind: string;
  model: string;
  /** `provider:model` the chat purpose uses now. */
  reference: string | null;
}

function providers(ws: Workspace): Array<[string, string]> {
  const table = ws.item("llm.providers");
  if (!isTable(table)) return [];
  return Object.entries(table).map(([name, item]) => {
    const kind = isTable(item) && typeof item.kind === "string" ? item.kind : "openai-compatible";
    return [name, kind];
  });
}

function chatRef(doc: TomlDocument | undefined): string | null {
  const item = doc?.get(["llm", "purposes", "chat"]);
  if (Array.isArray(item)) return typeof item[0] === "string" ? item[0] : null;
  return typeof item === "string" ? item : null;
}

export function llmState(ws: Workspace): LlmState {
  const reference = chatRef(ws.profileDoc()) ?? chatRef(ws.doc);
  const list = providers(ws);
  let provider: string;
  let model: string;
  const colon = reference?.indexOf(":") ?? -1;
  if (reference !== null && colon !== -1) {
    provider = reference.slice(0, colon);
    model = reference.slice(colon + 1);
  } else {
    provider = list[0]?.[0] ?? "deepseek";
    model = "";
  }
  const kind =
    list.find(([n]) => n === provider)?.[1] ??
    ((LLM_KINDS as readonly string[]).includes(provider) ? provider : "openai-compatible");
  return { provider, kind, model, reference };
}

function providerKey(provider: string, field: string): string {
  return `llm.providers.${formatKey([provider])}.${field}`;
}

/**
 * Uses a provider of `kind`: an existing one, a new `[llm.providers.opencode]`, or the current
 * provider with its kind changed.
 */
function switchKind(ws: Workspace, provider: string, kind: string): string {
  const existing = providers(ws).find(([, k]) => k === kind);
  if (existing) return existing[0];
  const name = kind === "opencode" ? "opencode" : provider;
  ws.set(providerKey(name, "kind"), kind);
  if (kind === "opencode") {
    if (ws.item(providerKey(name, "base_url")) === undefined) {
      ws.set(providerKey(name, "base_url"), defaultBaseUrl(kind) ?? "");
    }
    if (ws.item(providerKey(name, "api_key")) === undefined) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} reference
      ws.set(providerKey(name, "api_key"), "${OPENCODE_API_KEY:-}");
    }
  }
  return name;
}

function setModelRef(ws: Workspace, old: string | null, next: string): void {
  let hit = false;
  if (old !== null) {
    hit = ws.doc.replaceStringInArrays(["llm", "purposes"], old, next) || hit;
    const profile = ws.profileDoc();
    if (profile) hit = profile.replaceStringInArrays(["llm", "purposes"], old, next) || hit;
  }
  if (!hit) ws.set("llm.purposes.chat", [next]);
}

/** The API key field of the provider the chat purpose uses. */
export function llmApiKeyField(ws: Workspace): Field {
  const st = llmState(ws);
  return tomlField(() => t.settings.fields.llmApiKey, providerKey(st.provider, "api_key"), SECRET, {
    env: apiKeyVar(st.kind),
  });
}

export function llmSummary(ws: Workspace): string {
  const st = llmState(ws);
  return st.model === "" ? st.kind : `${st.kind} · ${st.model}`;
}

/**
 * Provider kind, base URL, API key and chat model. With `pick`, asks which of them to change
 * first.
 */
export async function llmStep(p: Prompter, ws: Workspace, pick: boolean): Promise<void> {
  const st = llmState(ws);
  const baseField = (provider: string, kind: string): [string, string] => [
    providerKey(provider, "base_url"),
    defaultBaseUrl(kind) ?? "",
  ];
  let todo = [true, true, true, true];
  if (pick) {
    const [baseKey, baseDefault] = baseField(st.provider, st.kind);
    const effective = ws.effective(baseKey);
    const baseNow = effective === undefined || effective === "" ? baseDefault : effective;
    const keyMissing =
      current(ws, tomlField("", providerKey(st.provider, "api_key"), SECRET)).value === "";
    const labels = [
      t.settings.llmKindLabel(st.kind),
      t.settings.llmBaseLabel(baseNow),
      t.settings.llmKeyLabel(keyMissing ? t.common.notSet : t.common.set),
      t.settings.llmModelLabel(st.model),
    ];
    const chosen = await p.multiSelect(t.settings.whichToChange, labels, []);
    todo = [0, 1, 2, 3].map((i) => chosen.includes(i));
  }

  let provider = st.provider;
  let kind = st.kind;
  if (todo[0]) {
    const options = [...LLM_KINDS];
    const start = Math.max(options.indexOf(kind as (typeof LLM_KINDS)[number]), 0);
    const nextKind = options[await p.select(t.settings.llmKind, options, start)] as string;
    if (nextKind !== kind) {
      provider = switchKind(ws, provider, nextKind);
      kind = nextKind;
      // The endpoint has to match the new kind; a new provider also needs a key and a model.
      todo[1] = true;
      if (provider !== st.provider) {
        todo[2] = true;
        todo[3] = true;
      }
    }
  }

  if (todo[1]) {
    const [key, def] = baseField(provider, kind);
    const field = tomlField(t.settings.fields.llmBaseUrl, key, URL_KIND, { default: def });
    const suggest = kind !== st.kind && provider === st.provider && def !== "";
    if (suggest) {
      // Same provider, new kind: offer the new kind's endpoint.
      const typedUrl = (await p.text(field.label, def, validate.httpUrl)).trim();
      if (typedUrl !== current(ws, field).value) apply(ws, field, typedUrl);
    } else {
      await ask(p, ws, field);
    }
  }

  if (todo[2]) {
    const field = tomlField(t.settings.fields.llmApiKey, providerKey(provider, "api_key"), SECRET, {
      env: apiKeyVar(kind),
    });
    await ask(p, ws, field);
  }

  if (todo[3]) {
    const def = provider === st.provider && st.model !== "" ? st.model : defaultModel(kind);
    const model = await p.text(t.settings.model, def, validate.modelId);
    const nextRef = `${provider}:${model.trim()}`;
    if (st.reference !== nextRef) setModelRef(ws, st.reference, nextRef);
  }
}

// ---- database ----------------------------------------------------------------------------

export async function databaseStep(p: Prompter, ws: Workspace): Promise<void> {
  const cur = current(ws, DATABASE).value;
  const options = [t.settings.databaseSqlite, t.settings.databaseMemory];
  const pick = await p.select(t.settings.database, options, cur === "memory://" ? 1 : 0);
  const next = pick === 1 ? "memory://" : cur.startsWith("sqlite:") ? cur : DEFAULT_SQLITE_URL;
  if (next !== cur) apply(ws, DATABASE, next);
}

// ---- panel login -------------------------------------------------------------------------

export function oauthReady(ws: Workspace): boolean {
  return [OAUTH_CLIENT_ID, OAUTH_SECRET, OAUTH_REDIRECT].every((f) => current(ws, f).value !== "");
}

/** Discord login for the admin panel (`[modules.api.discord_oauth]`). */
export async function oauthStep(p: Prompter, ws: Workspace, init: boolean): Promise<void> {
  const configured = ws.item("modules.api.discord_oauth") !== undefined;
  const fields = [OAUTH_CLIENT_ID, OAUTH_SECRET, OAUTH_REDIRECT, API_BIND];
  let todo: number[];
  if (init) {
    if (!(await p.confirm(t.settings.oauthConfirm, configured))) return;
    todo = [0, 1, 2];
  } else {
    todo = await p.multiSelect(
      t.settings.whichToChange,
      fields.map((f) => fieldLabel(ws, f)),
      [],
    );
  }
  for (const i of todo) await ask(p, ws, fields[i] as Field);
  const redirectKey = OAUTH_REDIRECT.key ?? "";
  if (ws.item("modules.api.discord_oauth") !== undefined && ws.item(redirectKey) === undefined) {
    apply(ws, OAUTH_REDIRECT, DEFAULT_REDIRECT_URI);
  }
  if (oauthReady(ws)) {
    p.note(t.settings.oauthRedirectNote(current(ws, OAUTH_REDIRECT).value));
  } else if (ws.item("modules.api.discord_oauth") !== undefined) {
    p.warn(t.settings.oauthIncomplete);
  }
}

// ---- tokens ------------------------------------------------------------------------------

/**
 * Generates tokens that are missing (never replaces one that is set) and adds missing `${VAR}`
 * references. Returns the generated variables.
 */
export function ensureTokens(ws: Workspace): string[] {
  const generated: string[] = [];
  for (const [variable, keys] of tokens()) {
    for (const key of keys) {
      if (ws.item(key) === undefined) ws.set(key, `\${${variable}:-}`);
    }
    const found = ws.lookup(variable);
    if (found === undefined || found[0] === "") {
      ws.setEnv(variable, newToken());
      generated.push(variable);
    }
  }
  return generated;
}
