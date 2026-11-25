// API keys added in the admin panel, on top of the config file's (`api_key` / `api_keys`, which
// the panel only shows). They are kept in the store's plugin state (plugin `llm`, key
// `provider_keys`): one small JSON value, in no data category, so neither the data export nor a
// wipe or reset touches it. Stored as they are, like `.env` keeps them: the repo has no at-rest
// encryption.
//
// A key's value is write-only: it goes in once (`add`) and out only to the provider. Nothing this
// file returns, logs or throws carries it; a key is named by its position in the provider's
// rotation (`#2`), its id, its label, and at most the last four characters of a long one.
//
// A change takes effect at once: the router's pool for that provider is rebuilt in place
// (`LlmRouter.setProviderKeys`), keys that stay keeping what the breaker knows about them.

import { randomUUID } from "node:crypto";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type Clock, type JsonValue, systemClock, toTimestamp } from "@miyoria/types";
import { configKeyIds, KEYLESS_SLOT, type KeyState } from "./keys.js";
import { errorKind } from "./metrics.js";
import type { LlmRouter } from "./router.js";
import { ProviderHttpError } from "./types.js";

const log = getLogger("llm.keys");

/** Where the panel's keys are: `plugin_state` (`PANEL_KEYS_PLUGIN`, `PANEL_KEYS_STATE`). */
export const PANEL_KEYS_PLUGIN = "llm";
export const PANEL_KEYS_STATE = "provider_keys";
/** The longest key taken. */
export const MAX_KEY_LENGTH = 512;
/** The longest label. */
export const MAX_LABEL_LENGTH = 40;
/**
 * The shortest key that shows a hint (its last four characters). Four characters of a shorter
 * key give away too much of it; from 24 on, 20 or more stay unseen.
 */
export const HINT_MIN_LENGTH = 24;

/** The part of the store's `PluginState` the keys need. */
export interface KeyStateStore {
  get(plugin: string, key: string): { value: JsonValue } | null;
  set(plugin: string, key: string, value: JsonValue, v?: number): void;
}

/** One key added in the panel, as stored. */
interface StoredKey {
  id: string;
  provider: string;
  label: string | null;
  value: string;
  disabled: boolean;
  created_at: string;
  created_by: string;
}

export type KeySource = "config" | "panel";

/** One key of a provider as the panel lists it. Never its value. */
export interface KeyRow {
  /** `config:<n>` for the config file's, `panel:<uuid>` for one added in the panel. */
  id: string;
  /** Its place in the rotation (`#1` = 1); `null` while disabled. */
  position: number | null;
  label: string | null;
  source: KeySource;
  state: KeyState | "disabled";
  /** Skipped until then (cooling or bad). */
  until: string | null;
  failures: number;
  last_error: string | null;
  last_error_at: string | null;
  /** When it was added in the panel; `null` for the config file's. */
  added_at: string | null;
  /** `…` and its last four characters, for a key of `HINT_MIN_LENGTH` or more; else `null`. */
  hint: string | null;
}

export interface ProviderKeyList {
  provider: string;
  /** Whether keys can be added, disabled and removed here without a restart. */
  editable: boolean;
  /** The model a test request goes to; `null` when no purpose uses the provider. */
  test_model: string | null;
  keys: KeyRow[];
  /** A provider without keys in rotation: its own breaker; else `null`. */
  breaker: Pick<KeyRow, "state" | "until" | "failures" | "last_error" | "last_error_at"> | null;
}

/** How a key's test request went. */
export interface KeyTestResult {
  ok: boolean;
  /** Why it failed: `auth`, `rate_limit`, `http_5xx`, `http_4xx`, `connect_timeout`, ... */
  kind: string | null;
  /** The HTTP status of a refusal. */
  status: number | null;
  model: string;
  ms: number;
}

export type KeyErrorCode = "not_found" | "invalid" | "duplicate" | "unsupported" | "unavailable";

/** A refused key change; the message never contains a key. */
export class KeyManageError extends Error {
  override name = "KeyManageError";

  constructor(
    readonly code: KeyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What an audit entry says about a key: never its value. */
export interface KeyRef {
  provider: string;
  id: string;
  position: number | null;
  label: string | null;
  source: KeySource;
}

const hintOf = (value: string) => (value.length >= HINT_MIN_LENGTH ? `…${value.slice(-4)}` : null);

/** Why `value` is no key, or `null`. Never echoes it. */
export function keyProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "金鑰是空的";
  if (/\s/.test(value)) return "金鑰裡不能有空白或換行";
  if (value.length > MAX_KEY_LENGTH) return `金鑰太長了(最多 ${MAX_KEY_LENGTH} 個字元)`;
  if (!/^[\x21-\x7e]+$/.test(value)) return "金鑰只能有英數字和符號(可見的 ASCII 字元)";
  return null;
}

function parseStored(raw: JsonValue | undefined): StoredKey[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const keys = (raw as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return [];
  return keys.flatMap((k): StoredKey[] => {
    if (typeof k !== "object" || k === null) return [];
    const r = k as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.provider !== "string" || typeof r.value !== "string") {
      return [];
    }
    return [
      {
        id: r.id,
        provider: r.provider,
        label: typeof r.label === "string" ? r.label : null,
        value: r.value,
        disabled: r.disabled === true,
        created_at: typeof r.created_at === "string" ? r.created_at : "",
        created_by: typeof r.created_by === "string" ? r.created_by : "",
      },
    ];
  });
}

/** The panel's keys of every provider, and what the router sends with. */
export class LlmKeys {
  readonly #router: LlmRouter;
  readonly #config: ReadonlyMap<string, readonly string[]>;
  readonly #store: KeyStateStore | null;
  readonly #clock: Clock;
  #keys: StoredKey[];

  /** `config`: each provider's keys from the config file, in order (`usableKeys`). */
  constructor(
    router: LlmRouter,
    config: ReadonlyMap<string, readonly string[]>,
    store: KeyStateStore | null,
    clock: Clock = systemClock,
  ) {
    this.#router = router;
    this.#config = config;
    this.#store = store;
    this.#clock = clock;
    this.#keys = store ? parseStored(store.get(PANEL_KEYS_PLUGIN, PANEL_KEYS_STATE)?.value) : [];
  }

  /** Puts the stored keys into rotation (once, at start). Returns how many are in use. */
  load(): number {
    let used = 0;
    for (const provider of this.#router.providerNames()) {
      const mine = this.#keys.filter((k) => k.provider === provider && !k.disabled);
      if (mine.length === 0 || !this.#router.takesKeys(provider)) continue;
      try {
        this.#apply(provider);
        used += mine.length;
      } catch (error) {
        log.warn({ provider, err: errorMessage(error) }, "cannot use the panel's API keys");
      }
    }
    return used;
  }

  #configOf(provider: string): readonly string[] {
    return this.#config.get(provider) ?? [];
  }

  /** The rotation of `provider`: the config file's keys, then the enabled panel keys. */
  #rotation(provider: string): { id: string; value: string }[] {
    const ids = configKeyIds(this.#configOf(provider).length);
    return [
      ...this.#configOf(provider).map((value, i) => ({ id: ids[i] as string, value })),
      ...this.#keys
        .filter((k) => k.provider === provider && !k.disabled)
        .map((k) => ({ id: `panel:${k.id}`, value: k.value })),
    ];
  }

  #apply(provider: string): void {
    this.#router.setProviderKeys(provider, this.#rotation(provider));
  }

  #save(): void {
    if (!this.#store) throw new KeyManageError("unavailable", "沒有資料庫,不能存金鑰");
    const value = { keys: this.#keys.map((k) => ({ ...k })) } as unknown as JsonValue;
    this.#store.set(PANEL_KEYS_PLUGIN, PANEL_KEYS_STATE, value, 1);
  }

  #requireProvider(provider: string): void {
    if (!this.#router.providerNames().includes(provider)) {
      throw new KeyManageError("not_found", `沒有叫 \`${provider}\` 的供應商`);
    }
  }

  #requireEditable(provider: string): void {
    this.#requireProvider(provider);
    if (!this.#router.takesKeys(provider)) {
      throw new KeyManageError("unsupported", `\`${provider}\` 這種供應商不能在面板加金鑰`);
    }
    if (!this.#store) throw new KeyManageError("unavailable", "沒有資料庫,不能存金鑰");
  }

  #panelKey(provider: string, id: string): StoredKey {
    const raw = id.startsWith("panel:") ? id.slice("panel:".length) : id;
    const key = this.#keys.find((k) => k.provider === provider && k.id === raw);
    if (!key) {
      if (id.startsWith("config:")) {
        throw new KeyManageError("invalid", "設定檔裡的金鑰只能在設定檔改");
      }
      throw new KeyManageError("not_found", "沒有這把金鑰");
    }
    return key;
  }

  #row(provider: string, id: string, value: string, extra: Partial<KeyRow>): KeyRow {
    const status = this.#router.keyStatus(provider, id);
    const position = this.#rotation(provider).findIndex((k) => k.id === id);
    return {
      id,
      position: position < 0 ? null : position + 1,
      label: null,
      source: id.startsWith("config:") ? "config" : "panel",
      state: status?.state ?? "disabled",
      until: status?.until ?? null,
      failures: status?.failures ?? 0,
      last_error: status?.last_error ?? null,
      last_error_at: status?.last_error_at ?? null,
      added_at: null,
      hint: hintOf(value),
      ...extra,
    };
  }

  #rowOf(key: StoredKey): KeyRow {
    const id = `panel:${key.id}`;
    return this.#row(key.provider, id, key.value, {
      label: key.label,
      added_at: key.created_at || null,
      ...(key.disabled ? { state: "disabled", position: null } : {}),
    });
  }

  /** Every provider with its keys: the config file's first, then the panel's in the order added. */
  list(): ProviderKeyList[] {
    return this.#router.providerNames().map((provider) => {
      const ids = configKeyIds(this.#configOf(provider).length);
      const own = this.#router.keyStatus(provider, KEYLESS_SLOT);
      return {
        provider,
        editable: this.#router.takesKeys(provider) && this.#store !== null,
        test_model: this.#router.testModel(provider),
        breaker:
          own === null
            ? null
            : {
                state: own.state,
                until: own.until,
                failures: own.failures,
                last_error: own.last_error,
                last_error_at: own.last_error_at,
              },
        keys: [
          ...this.#configOf(provider).map((value, i) =>
            this.#row(provider, ids[i] as string, value, {}),
          ),
          ...this.#keys.filter((k) => k.provider === provider).map((k) => this.#rowOf(k)),
        ],
      };
    });
  }

  /** What an audit entry names for key `id` of `provider`. */
  ref(provider: string, id: string): KeyRef {
    const row =
      this.list()
        .find((p) => p.provider === provider)
        ?.keys.find((k) => k.id === id) ?? null;
    return {
      provider,
      id,
      position: row?.position ?? null,
      label: row?.label ?? null,
      source: id.startsWith("config:") ? "config" : "panel",
    };
  }

  /**
   * Adds `value` to `provider`'s rotation (at its end). Refuses an empty key, one with white
   * space, one too long, and one the provider already has (from the config file too).
   */
  add(provider: string, value: unknown, label: unknown, by: string): KeyRow {
    this.#requireEditable(provider);
    const problem = keyProblem(value);
    if (problem !== null) throw new KeyManageError("invalid", problem);
    const key = value as string;
    let name: string | null = null;
    if (label !== undefined && label !== null) {
      if (typeof label !== "string") throw new KeyManageError("invalid", "名稱要是文字");
      const trimmed = label.trim();
      if ([...trimmed].length > MAX_LABEL_LENGTH) {
        throw new KeyManageError("invalid", `名稱最多 ${MAX_LABEL_LENGTH} 個字`);
      }
      if (/[\p{Cc}]/u.test(trimmed)) throw new KeyManageError("invalid", "名稱裡不能有控制字元");
      name = trimmed === "" ? null : trimmed;
    }
    const rotation = this.#rotation(provider);
    const inConfig = this.#configOf(provider).findIndex((k) => k.trim() === key);
    if (inConfig >= 0) {
      throw new KeyManageError("duplicate", `這把金鑰已經在設定檔裡了(#${inConfig + 1})`);
    }
    const twin = this.#keys.find((k) => k.provider === provider && k.value === key);
    if (twin) {
      const at = rotation.findIndex((k) => k.id === `panel:${twin.id}`);
      throw new KeyManageError(
        "duplicate",
        at >= 0
          ? `這把金鑰已經加過了(#${at + 1})`
          : `這把金鑰已經加過了(停用中的${twin.label ? `「${twin.label}」` : "那把"})`,
      );
    }
    const stored: StoredKey = {
      id: randomUUID(),
      provider,
      label: name,
      value: key,
      disabled: false,
      created_at: toTimestamp(this.#clock.now()),
      created_by: by,
    };
    const before = this.#keys;
    this.#keys = [...before, stored];
    try {
      this.#save();
      this.#apply(provider);
    } catch (error) {
      this.#keys = before;
      throw error;
    }
    const row = this.#rowOf(stored);
    log.info(
      { provider, key: `#${row.position}`, id: row.id, label: name },
      "API key added in the panel",
    );
    return row;
  }

  /** Takes a panel key out of the rotation (`disabled`) or puts it back at its place. */
  setDisabled(provider: string, id: string, disabled: boolean): KeyRow {
    this.#requireEditable(provider);
    const key = this.#panelKey(provider, id);
    if (key.disabled !== disabled) {
      const before = this.#keys;
      this.#keys = before.map((k) => (k === key ? { ...k, disabled } : k));
      try {
        this.#save();
        this.#apply(provider);
      } catch (error) {
        this.#keys = before;
        throw error;
      }
      log.info(
        { provider, id: `panel:${key.id}`, label: key.label },
        disabled ? "API key disabled in the panel" : "API key enabled in the panel",
      );
    }
    return this.#rowOf(this.#panelKey(provider, id));
  }

  /** Deletes a panel key; what it was, for the audit entry. */
  remove(provider: string, id: string): KeyRef {
    this.#requireEditable(provider);
    const key = this.#panelKey(provider, id);
    const ref = this.ref(provider, `panel:${key.id}`);
    const before = this.#keys;
    this.#keys = before.filter((k) => k !== key);
    try {
      this.#save();
      this.#apply(provider);
    } catch (error) {
      this.#keys = before;
      throw error;
    }
    log.info({ provider, id: ref.id, label: ref.label }, "API key deleted in the panel");
    return ref;
  }

  /**
   * Sends one request of one token with key `id` alone (enabled or not): `ok`, or why it failed.
   * The breaker is left as it is.
   */
  async test(provider: string, id: string, signal?: AbortSignal): Promise<KeyTestResult> {
    this.#requireProvider(provider);
    let value: string;
    if (id.startsWith("config:")) {
      const n = Number(id.slice("config:".length));
      const v = Number.isInteger(n) ? this.#configOf(provider)[n - 1] : undefined;
      if (v === undefined) throw new KeyManageError("not_found", "沒有這把金鑰");
      value = v;
    } else {
      value = this.#panelKey(provider, id).value;
    }
    if (!this.#router.testsKeys(provider)) {
      throw new KeyManageError("unsupported", `\`${provider}\` 這種供應商不能測試金鑰`);
    }
    const model = this.#router.testModel(provider);
    if (model === null) {
      throw new KeyManageError("unsupported", `沒有用途用到 \`${provider}\`,不知道用哪個模型測試`);
    }
    const started = this.#clock.now();
    try {
      await this.#router.checkKey(provider, value, signal);
      return { ok: true, kind: null, status: null, model, ms: this.#clock.now() - started };
    } catch (error) {
      return {
        ok: false,
        kind: testKind(error),
        status: error instanceof ProviderHttpError ? error.status : null,
        model,
        ms: this.#clock.now() - started,
      };
    }
  }
}

/** Why a test request failed, in the kinds the panel names. */
export function testKind(error: unknown): string {
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) return "auth";
    if (error.status === 429) return "rate_limit";
  }
  return errorKind(error);
}
