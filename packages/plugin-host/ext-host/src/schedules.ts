// An extension's own alarms: `schedule.set { id, at | daily, payload }`, `schedule.cancel`,
// `schedule.list`; when one comes due the host sends `schedule.fire` to the extension. Kept in
// the settings store (`ext:<id>:schedule:<sid>`, no migration), so they outlive a restart. A
// one-off whose time passed while Core was down fires once on the next start (`due` says when it
// was meant); a daily one skips the days it missed. Long work started from a fire goes through
// the extension's task executor (`tasks.register`), as any other background work.

import {
  type ExtScheduleEntry,
  type ExtScheduleFireParams,
  type ExtScheduleListResult,
  type ExtScheduleSetParams,
  ExtScheduleSetParamsSchema,
} from "@miyoria/contracts/ext";
import { errorMessage, sleep } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import type { Clock, JsonValue } from "@miyoria/types";
import { isJsonObject } from "@miyoria/types";
import { RpcError } from "./rpc.js";

/** Schedules one extension may keep. */
export const MAX_SCHEDULES = 32;
/** Largest payload, as JSON, in bytes. */
export const MAX_SCHEDULE_PAYLOAD = 4096;
/** The loop looks at least this often, so a clock that jumps is caught up with. */
const MAX_SLEEP_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

interface Stored {
  id: string;
  at?: number;
  daily?: string;
  payload: JsonValue | null;
}

/** The next time `daily` ("HH:MM" on a clock `offsetMinutes` east of UTC) comes after `now`. */
export function nextDaily(daily: string, now: number, offsetMinutes: number): number {
  const [h, m] = daily.split(":").map(Number) as [number, number];
  const offset = offsetMinutes * 60_000;
  const local = now + offset;
  const midnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  let next = midnight + (h * 60 + m) * 60_000 - offset;
  while (next <= now) next += DAY_MS;
  return next;
}

export interface SchedulesOptions {
  extension: string;
  store: SettingsStore;
  profile: string;
  clock: Clock;
  offsetMinutes: number;
  /** Sends `schedule.fire`; `false`: the extension could not take it now (tried again later). */
  fire(params: ExtScheduleFireParams): boolean;
  warn(message: string, fields: Record<string, unknown>): void;
}

export class ExtensionSchedules {
  readonly #o: SchedulesOptions;
  readonly #entries = new Map<string, Stored & { next: number }>();
  #loaded: Promise<void> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: SchedulesOptions) {
    this.#o = options;
  }

  get #prefix(): string {
    return `ext:${this.#o.extension}:schedule:`;
  }

  /** Reads what was kept; entries that do not parse are dropped from the store. */
  load(): Promise<void> {
    this.#loaded ??= (async () => {
      const saved = await this.#o.store.list(this.#o.profile, this.#prefix);
      const now = this.#o.clock.now();
      for (const [key, value] of saved) {
        const entry = parseStored(value);
        if (entry === null || key !== this.#prefix + entry.id) {
          this.#o.warn("dropping an unreadable extension schedule", { key });
          await this.#o.store.set(this.#o.profile, key, null);
          continue;
        }
        this.#entries.set(entry.id, { ...entry, next: this.#nextOf(entry, now) });
      }
    })();
    return this.#loaded;
  }

  #nextOf(entry: Stored, now: number): number {
    if (entry.daily !== undefined) return nextDaily(entry.daily, now, this.#o.offsetMinutes);
    return entry.at ?? now;
  }

  async set(raw: JsonValue): Promise<ExtScheduleEntry> {
    const parsed = ExtScheduleSetParamsSchema.safeParse(raw);
    if (!parsed.success) throw RpcError.invalidParams(parsed.error.issues[0]?.message ?? "bad");
    const p: ExtScheduleSetParams = parsed.data;
    if ((p.at === undefined) === (p.daily === undefined)) {
      throw RpcError.invalidParams("a schedule needs exactly one of `at` or `daily`");
    }
    if (p.at !== undefined && !Number.isFinite(p.at)) {
      throw RpcError.invalidParams("`at` must be epoch milliseconds");
    }
    const payload = p.payload ?? null;
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SCHEDULE_PAYLOAD) {
      throw RpcError.invalidParams(`the payload is over ${MAX_SCHEDULE_PAYLOAD} bytes`);
    }
    await this.load();
    if (!this.#entries.has(p.id) && this.#entries.size >= MAX_SCHEDULES) {
      throw RpcError.invalidParams(`an extension keeps at most ${MAX_SCHEDULES} schedules`);
    }
    const stored: Stored = {
      id: p.id,
      ...(p.at !== undefined ? { at: p.at } : {}),
      ...(p.daily !== undefined ? { daily: p.daily } : {}),
      payload,
    };
    await this.#o.store.set(this.#o.profile, this.#prefix + p.id, stored as unknown as JsonValue);
    const entry = { ...stored, next: this.#nextOf(stored, this.#o.clock.now()) };
    this.#entries.set(p.id, entry);
    this.#wake?.();
    return view(entry);
  }

  async cancel(id: string): Promise<boolean> {
    await this.load();
    const had = this.#entries.delete(id);
    if (had) await this.#o.store.set(this.#o.profile, this.#prefix + id, null);
    return had;
  }

  async list(): Promise<ExtScheduleListResult> {
    await this.load();
    const schedules = [...this.#entries.values()]
      .sort((a, b) => a.next - b.next || a.id.localeCompare(b.id))
      .map(view);
    return { schedules };
  }

  /** Fires what is due at `now`; returns when the next one is (or `null`: none). */
  async tick(now: number): Promise<number | null> {
    await this.load();
    for (const entry of [...this.#entries.values()]) {
      if (entry.next > now) continue;
      const sent = this.#o.fire({ id: entry.id, payload: entry.payload, due: entry.next });
      if (!sent) continue;
      if (entry.daily !== undefined) {
        entry.next = nextDaily(entry.daily, now, this.#o.offsetMinutes);
      } else {
        this.#entries.delete(entry.id);
        try {
          await this.#o.store.set(this.#o.profile, this.#prefix + entry.id, null);
        } catch (error) {
          this.#o.warn("cannot forget a fired schedule", {
            id: entry.id,
            err: errorMessage(error),
          });
        }
      }
    }
    let next: number | null = null;
    for (const entry of this.#entries.values()) {
      if (next === null || entry.next < next) next = entry.next;
    }
    return next;
  }

  /** Fires schedules as they come due until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = this.#o.clock.now();
      let next: number | null;
      try {
        next = await this.tick(now);
      } catch (error) {
        this.#o.warn("extension schedules failed", { err: errorMessage(error) });
        next = null;
      }
      const wait = next === null ? MAX_SLEEP_MS : Math.min(Math.max(next - now, 50), MAX_SLEEP_MS);
      // A new or changed schedule may be due sooner than the one slept for.
      const woken = new AbortController();
      this.#wake = () => woken.abort();
      try {
        await sleep(wait, AbortSignal.any([signal, woken.signal]));
      } catch {
        if (signal.aborted) return;
      } finally {
        this.#wake = null;
      }
    }
  }
}

function view(entry: Stored & { next: number }): ExtScheduleEntry {
  return {
    id: entry.id,
    ...(entry.at !== undefined ? { at: entry.at } : {}),
    ...(entry.daily !== undefined ? { daily: entry.daily } : {}),
    payload: entry.payload,
    next: entry.next,
  };
}

function parseStored(value: JsonValue): Stored | null {
  if (!isJsonObject(value) || typeof value.id !== "string") return null;
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : undefined;
  const daily =
    typeof value.daily === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.daily)
      ? value.daily
      : undefined;
  if ((at === undefined) === (daily === undefined)) return null;
  return {
    id: value.id,
    ...(at !== undefined ? { at } : {}),
    ...(daily !== undefined ? { daily } : {}),
    payload: value.payload ?? null,
  };
}
