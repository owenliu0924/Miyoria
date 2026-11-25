// The API keys of a provider and what the router remembers about them: a circuit breaker per
// key (closed → open for a cooldown → half-open, one request probes it). A provider whose keys
// are all cooling is skipped by the router, so a hung provider stops costing every call its
// connect timeouts. Keys are only ever named by their position (`#1`, `#2`): neither the pool
// nor what it reports sees a key itself.
//
// The pool is the router's (its clock); the provider picks keys for each call through the
// `KeyChooser` the router hands it and reports how each attempt went.

import { getLogger } from "@miyoria/runtime/kernel";
import { type Clock, toTimestamp } from "@miyoria/types";
import { z } from "zod";
import type { KeyChooser, KeyFailure, KeyOutcome } from "./types.js";

const log = getLogger("llm.keys");

/** `[llm.providers.<name>]` breaker settings. */
export interface KeyBreakerSettings {
  /** Consecutive failures of a key that open it; `0` turns the breaker off. */
  failures: number;
  /** The first cooldown, in ms; each failed probe doubles it. */
  cooldownMs: number;
  /** The longest cooldown (also caps a `Retry-After`), in ms. */
  maxCooldownMs: number;
  /** How long a key the provider refused (401 / 403) is skipped, in ms. */
  badKeyCooldownMs: number;
}

/** Open after 2 failures in a row (one call's connect timeout and its retry), 60 s, at most 10 min. */
export const DEFAULT_KEY_BREAKER: KeyBreakerSettings = {
  failures: 2,
  cooldownMs: 60_000,
  maxCooldownMs: 600_000,
  badKeyCooldownMs: 3_600_000,
};

/** The breaker keys of a provider table (seconds), parsed with the rest of the provider. */
export const KeyBreakerFieldsSchema = z.object({
  breaker_failures: z.number().int().nonnegative().nullable().optional(),
  breaker_cooldown_secs: z.number().nonnegative().nullable().optional(),
  breaker_max_cooldown_secs: z.number().nonnegative().nullable().optional(),
  bad_key_cooldown_secs: z.number().nonnegative().nullable().optional(),
});

export function keyBreakerSettings(
  fields: z.output<typeof KeyBreakerFieldsSchema>,
): KeyBreakerSettings {
  const d = DEFAULT_KEY_BREAKER;
  const ms = (secs: number | null | undefined, fallback: number) =>
    secs == null ? fallback : Math.round(secs * 1000);
  const cooldownMs = ms(fields.breaker_cooldown_secs, d.cooldownMs);
  return {
    failures: fields.breaker_failures ?? d.failures,
    cooldownMs,
    maxCooldownMs: Math.max(cooldownMs, ms(fields.breaker_max_cooldown_secs, d.maxCooldownMs)),
    badKeyCooldownMs: ms(fields.bad_key_cooldown_secs, d.badKeyCooldownMs),
  };
}

/**
 * The keys to use: `api_key` first, then `api_keys`; blank ones (an unset `${ENV}` expands to
 * `""`) and repeats dropped.
 */
export function usableKeys(apiKey: string | null, apiKeys: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [apiKey, ...apiKeys]) {
    const trimmed = raw?.trim() ?? "";
    if (raw == null || trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(raw);
  }
  return out;
}

/** What one call did with one key: answered, failed, or was skipped as cooling. */
export interface KeyAttempt {
  provider: string;
  /** 1-based position. */
  key: number;
  result: "ok" | "failed" | "skipped";
  /**
   * `failed`: a breaker failure (`connect_timeout`, `auth`, `rate_limit`, `http_5xx`, `network`)
   * or what else ended it (`http_4xx`, `aborted`, `error`); `skipped`: `cooling` or `bad`.
   */
  kind: string | null;
}

/** Kinds of `KeyAttempt` failures the breaker counts. */
export const KEY_FAILURE_KINDS: Readonly<Record<KeyFailure, string>> = {
  connect_timeout: "connect_timeout",
  auth: "auth",
  rate_limit: "rate_limit",
  server: "http_5xx",
  network: "network",
};

export type KeyState = "ok" | "cooling" | "bad";

/** One key as the admin sees it. */
export interface KeyStatus {
  key: number;
  state: KeyState;
  /** Until when it is skipped (ISO); `null` when it is not, or when its probe is due. */
  until: string | null;
  /** Consecutive failures. */
  failures: number;
  last_error: string | null;
  last_error_at: string | null;
}

/** A provider's keys; `keyed`: it has API keys (otherwise one slot stands for the provider). */
export interface ProviderKeys {
  provider: string;
  keyed: boolean;
  keys: KeyStatus[];
}

interface Slot {
  /** Stable across reshapes: `config:<n>` for a key of the config file, `panel:<id>` for one added in the panel. */
  id: string;
  failures: number;
  /** Skipped until then; past it, the next pick probes the key. `null`: closed. */
  openUntil: number | null;
  /** Failed probes since it last answered (the cooldown doubles with each). */
  level: number;
  /** The provider refused the key (401 / 403). */
  bad: boolean;
  /** A probe of it is under way: nobody else picks it meanwhile. */
  probing: boolean;
  lastFailureAt: number | null;
  lastError: string | null;
}

const slot = (id: string): Slot => ({
  id,
  failures: 0,
  openUntil: null,
  level: 0,
  bad: false,
  probing: false,
  lastFailureAt: null,
  lastError: null,
});

/** The ids of a provider's keys as the config file gives them (before the panel adds any). */
export const configKeyIds = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `config:${i + 1}`);

/** The id of the one slot of a provider without keys. */
export const KEYLESS_SLOT = "provider";

/** The keys of one provider and their breakers. */
export class KeyPool {
  readonly provider: string;
  #keyed: boolean;
  /** Replaced, never changed in place, by `reshape`: a call keeps the slots it started with. */
  #slots: readonly Slot[];
  readonly #settings: KeyBreakerSettings;
  readonly #clock: Clock;
  /** Where the next call's round-robin starts. */
  #cursor = 0;

  /** `count`: the provider's API keys (0: a keyless provider, one slot for the provider). */
  constructor(provider: string, count: number, settings: KeyBreakerSettings, clock: Clock) {
    this.provider = provider;
    this.#settings = settings;
    this.#clock = clock;
    this.#keyed = count > 0;
    this.#slots = count > 0 ? configKeyIds(count).map(slot) : [slot(KEYLESS_SLOT)];
  }

  get keyed(): boolean {
    return this.#keyed;
  }

  get size(): number {
    return this.#slots.length;
  }

  /** The ids of the keys in rotation, in order (position = index + 1). */
  ids(): string[] {
    return this.#keyed ? this.#slots.map((s) => s.id) : [];
  }

  /**
   * The provider's keys are now `ids`, in this order (none: keyless). A key that stays keeps what
   * the breaker knows about it; a new one starts closed. Calls under way finish on the keys they
   * started with.
   */
  reshape(ids: readonly string[]): void {
    const old = new Map(this.#slots.map((s) => [s.id, s]));
    this.#keyed = ids.length > 0;
    this.#slots = this.#keyed
      ? ids.map((id) => old.get(id) ?? slot(id))
      : [old.get(KEYLESS_SLOT) ?? slot(KEYLESS_SLOT)];
    this.#cursor %= this.#slots.length;
  }

  get #off(): boolean {
    return this.#settings.failures <= 0;
  }

  #usable(s: Slot, now: number): boolean {
    if (this.#off) return true;
    return !s.probing && (s.openUntil === null || now >= s.openUntil);
  }

  /** Whether some key may be sent with now (closed, or due for its probe). */
  usable(): boolean {
    const now = this.#clock.now();
    return this.#slots.some((s) => this.#usable(s, now));
  }

  /** When the first cooling key may be tried again (ms), or `null` when one is usable. */
  reopensAt(): number | null {
    if (this.usable()) return null;
    const times = this.#slots.map((s) => s.openUntil).filter((t): t is number => t !== null);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /**
   * The keys of one call (the slots in rotation now). `lastResort`: every key is cooling and
   * nothing else is left, so the least recently failed one is tried once
   * (`KeyChooser.lastResort`). `onAttempt` hears every pick's outcome and every key passed over.
   */
  chooser(lastResort: boolean, onAttempt: (attempt: KeyAttempt) => void): CallKeys {
    return new CallKeys(this, this.#slots, lastResort, onAttempt);
  }

  /** @internal The next key of a call among `slots`, not in `tried`; `null` when none is left. */
  pick(
    slots: readonly Slot[],
    tried: ReadonlySet<number>,
    lastResort: boolean,
    skipped: (index: number, kind: KeyState) => void,
  ): { index: number; probe: boolean } | null {
    const now = this.#clock.now();
    const n = slots.length;
    if (lastResort) {
      let best: number | null = null;
      for (let i = 0; i < n; i++) {
        if (tried.has(i)) continue;
        const s = slots[i] as Slot;
        const b = best === null ? null : (slots[best] as Slot);
        if (b === null || (s.lastFailureAt ?? -1) < (b.lastFailureAt ?? -1)) best = i;
      }
      if (best === null) return null;
      return { index: best, probe: this.#claim(slots[best] as Slot) };
    }
    // After the key a call last started with, so calls take turns over the usable keys.
    for (let step = 0; step < n; step++) {
      const i = (this.#cursor + step) % n;
      if (tried.has(i)) continue;
      const s = slots[i] as Slot;
      if (!this.#usable(s, now)) {
        skipped(i, s.bad ? "bad" : "cooling");
        continue;
      }
      if (tried.size === 0) this.#cursor = (i + 1) % n;
      return { index: i, probe: this.#claim(s) };
    }
    return null;
  }

  /** Marks an open key as being probed; whether it was open. */
  #claim(s: Slot): boolean {
    if (this.#off || s.openUntil === null) return false;
    s.probing = true;
    return true;
  }

  /**
   * @internal How an attempt on `s` (at `position`) ended; `probe`: it was the key's probe.
   * Whether the same key may be sent again in the call: not once this failure left it open (a
   * 429 aside).
   */
  settle(s: Slot, position: number, outcome: KeyOutcome, probe: boolean): boolean {
    this.#apply(s, position, outcome, probe);
    if (outcome.type !== "failed" || outcome.failure === "rate_limit" || this.#off) return true;
    return s.openUntil === null || this.#clock.now() >= s.openUntil;
  }

  #apply(s: Slot, position: number, outcome: KeyOutcome, probe: boolean): void {
    if (probe) s.probing = false;
    const now = this.#clock.now();
    if (outcome.type === "ok") {
      s.failures = 0;
      s.level = 0;
      s.openUntil = null;
      s.bad = false;
      return;
    }
    if (outcome.type === "ended") return;
    s.lastFailureAt = now;
    s.lastError = KEY_FAILURE_KINDS[outcome.failure];
    if (this.#off) return;
    const st = this.#settings;
    if (outcome.failure === "auth") {
      if (!s.bad && s.id !== KEYLESS_SLOT) {
        log.warn(
          {
            provider: this.provider,
            key: `#${position}`,
            cooldown_s: Math.round(st.badKeyCooldownMs / 1000),
          },
          "the provider refused this API key (401/403); skipping it",
        );
      }
      s.bad = true;
      s.failures += 1;
      s.openUntil = now + st.badKeyCooldownMs;
      return;
    }
    s.failures += 1;
    if (outcome.failure === "rate_limit" && outcome.retryAfterMs != null) {
      s.openUntil = now + Math.min(Math.max(0, outcome.retryAfterMs), st.maxCooldownMs);
      return;
    }
    if (probe) {
      // The probe failed: open again, for longer.
      s.level += 1;
      s.openUntil = now + Math.min(st.cooldownMs * 2 ** s.level, st.maxCooldownMs);
      return;
    }
    // A retry within the call that opened it changes nothing.
    if (s.openUntil !== null && now < s.openUntil) return;
    if (s.failures >= st.failures) s.openUntil = now + Math.min(st.cooldownMs, st.maxCooldownMs);
  }

  #statusOf(s: Slot, position: number, now: number): KeyStatus {
    const cooling = s.probing || (s.openUntil !== null && now < s.openUntil);
    const state: KeyState = s.bad && s.openUntil !== null ? "bad" : cooling ? "cooling" : "ok";
    return {
      key: position,
      state,
      until: s.openUntil !== null && now < s.openUntil ? toTimestamp(s.openUntil) : null,
      failures: s.failures,
      last_error: s.lastError,
      last_error_at: s.lastFailureAt === null ? null : toTimestamp(s.lastFailureAt),
    };
  }

  status(): ProviderKeys {
    const now = this.#clock.now();
    return {
      provider: this.provider,
      keyed: this.#keyed,
      keys: this.#slots.map((s, i) => this.#statusOf(s, i + 1, now)),
    };
  }

  /** The breaker state of the key `id` while it is in rotation, else `null`. */
  statusOf(id: string): KeyStatus | null {
    const i = this.#slots.findIndex((s) => s.id === id);
    if (i < 0) return null;
    return this.#statusOf(this.#slots[i] as Slot, i + 1, this.#clock.now());
  }
}

/** The keys one call goes through (`KeyChooser` for the provider). */
export class CallKeys implements KeyChooser {
  readonly lastResort: boolean;
  readonly #pool: KeyPool;
  /** The slots in rotation when the call started: the provider's keys at that moment, in order. */
  readonly #slots: readonly Slot[];
  readonly #onAttempt: (attempt: KeyAttempt) => void;
  readonly #tried = new Set<number>();
  /** Picks not reported yet, and whether each is a probe. */
  readonly #open = new Map<number, boolean>();
  readonly #skipped = new Set<number>();

  constructor(
    pool: KeyPool,
    slots: readonly Slot[],
    lastResort: boolean,
    onAttempt: (attempt: KeyAttempt) => void,
  ) {
    this.#pool = pool;
    this.#slots = slots;
    this.lastResort = lastResort;
    this.#onAttempt = onAttempt;
  }

  next(): number | null {
    const picked = this.#pool.pick(this.#slots, this.#tried, this.lastResort, (i, kind) => {
      if (this.#skipped.has(i)) return;
      this.#skipped.add(i);
      this.#onAttempt({ provider: this.#pool.provider, key: i + 1, result: "skipped", kind });
    });
    if (picked === null) return null;
    this.#tried.add(picked.index);
    this.#open.set(picked.index, picked.probe);
    return picked.index;
  }

  report(key: number, outcome: KeyOutcome): boolean {
    const s = this.#slots[key];
    if (s === undefined) return false;
    const probe = this.#open.get(key) ?? false;
    this.#open.delete(key);
    const again = this.#pool.settle(s, key + 1, outcome, probe);
    this.#onAttempt({
      provider: this.#pool.provider,
      key: key + 1,
      result: outcome.type === "ok" ? "ok" : "failed",
      kind:
        outcome.type === "ok"
          ? null
          : outcome.type === "failed"
            ? KEY_FAILURE_KINDS[outcome.failure]
            : outcome.kind,
    });
    return again;
  }

  /** Settles picks the provider never reported (so a probe never stays claimed). */
  close(): void {
    for (const [key, probe] of this.#open) {
      const s = this.#slots[key];
      if (s) this.#pool.settle(s, key + 1, { type: "ended", kind: "error" }, probe);
    }
    this.#open.clear();
  }
}

/** Every key once, in order: what a provider uses when no router hands it a chooser. */
export function plainKeys(count: number, start = 0): KeyChooser {
  const n = Math.max(1, count);
  let given = 0;
  return {
    lastResort: false,
    next: () => (given < n ? (start + given++) % n : null),
    report: () => true,
  };
}
