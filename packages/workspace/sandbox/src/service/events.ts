// Every job's events in one ring (docs/design/v6-sandbox.md §3.5): Core keeps one long poll per
// machine, because the relay carries at most 16 streams per machine and one per exec or proc would
// use them up. The cursor is `<boot>:<seq>`; a cursor of another start, or older than what is kept,
// gets `reset` (Core reconciles with `GET /v1/jobs`).

import type { EventsPage, SandboxEvent } from "@miyoria/contracts/workers";

/** Events kept, by count and by their JSON size. */
export const MAX_EVENTS = 4096;
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
/** Longest wait of one poll, and the most one page carries. */
export const MAX_WAIT_MS = 25_000;
export const MAX_PAGE_BYTES = 1024 * 1024;

/** An event before it has its number. */
export type NewEvent = SandboxEvent extends infer E
  ? E extends SandboxEvent
    ? Omit<E, "seq">
    : never
  : never;

interface Kept {
  event: SandboxEvent;
  bytes: number;
}

export class EventRing {
  readonly #kept: Kept[] = [];
  #bytes = 0;
  #seq = 0;
  readonly #waiters = new Set<() => void>();

  constructor(
    readonly boot: string,
    readonly limits: { maxEvents: number; maxBytes: number } = {
      maxEvents: MAX_EVENTS,
      maxBytes: MAX_EVENT_BYTES,
    },
  ) {}

  /** The newest number given out. */
  get seq(): number {
    return this.#seq;
  }

  push(event: NewEvent): SandboxEvent {
    this.#seq += 1;
    const full = { ...event, seq: this.#seq } as SandboxEvent;
    const bytes = JSON.stringify(full).length;
    this.#kept.push({ event: full, bytes });
    this.#bytes += bytes;
    while (
      this.#kept.length > 0 &&
      (this.#kept.length > this.limits.maxEvents || this.#bytes > this.limits.maxBytes)
    ) {
      const dropped = this.#kept.shift() as Kept;
      this.#bytes -= dropped.bytes;
    }
    for (const wake of [...this.#waiters]) wake();
    return full;
  }

  /** `<boot>:<seq>` of everything so far. */
  cursor(seq = this.#seq): string {
    return `${this.boot}:${seq}`;
  }

  /**
   * The events after `after` (none: everything kept), at most `maxBytes` of them (at least one).
   * `reset` when the cursor is not this start's, cannot be read, or points before what is kept.
   */
  page(after: string | null, maxBytes: number): EventsPage {
    let from = 0;
    let reset = false;
    if (after !== null) {
      const at = after.lastIndexOf(":");
      const boot = at < 0 ? "" : after.slice(0, at);
      const seq = at < 0 ? Number.NaN : Number(after.slice(at + 1));
      if (boot !== this.boot || !Number.isInteger(seq) || seq < 0 || seq > this.#seq) {
        reset = true;
      } else {
        from = seq;
        const oldest = this.#kept[0]?.event.seq ?? this.#seq + 1;
        // Something between the cursor and the oldest kept event was dropped.
        if (from + 1 < oldest && from < this.#seq) reset = true;
      }
    }
    const events: SandboxEvent[] = [];
    let bytes = 0;
    let last = reset ? (this.#kept[0]?.event.seq ?? this.#seq + 1) - 1 : from;
    for (const kept of this.#kept) {
      if (!reset && kept.event.seq <= from) continue;
      if (events.length > 0 && bytes + kept.bytes > maxBytes) break;
      events.push(kept.event);
      bytes += kept.bytes;
      last = kept.event.seq;
    }
    if (reset && events.length === 0) last = this.#seq;
    return { cursor: this.cursor(last), events, reset };
  }

  /** Resolves when an event comes, after `ms`, or when `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Wakes every waiting poll (the service is closing). */
  wakeAll(): void {
    for (const wake of [...this.#waiters]) wake();
  }
}
