// The room's own counters (docs/design/her-room.md §5): transport limits per account, in fixed
// windows. Each keeps a bounded number of keys; a key whose window is over starts again.

const MAX_KEYS = 10_000;

export class Window {
  readonly #hits = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Counts one; how many ms until one more is allowed, `null` when this one was. */
  hit(key: string, now: number): number | null {
    const wait = this.wait(key, now);
    if (wait !== null) return wait;
    const entry = this.#hits.get(key);
    if (entry !== undefined && now - entry.start < this.windowMs) entry.count += 1;
    else {
      this.#hits.delete(key);
      if (this.#hits.size >= MAX_KEYS) this.#evict(now);
      this.#hits.set(key, { start: now, count: 1 });
    }
    return null;
  }

  /** Like `hit` without counting: `null` when one more would be allowed now. */
  wait(key: string, now: number): number | null {
    const entry = this.#hits.get(key);
    if (entry === undefined || now - entry.start >= this.windowMs) return null;
    return entry.count >= this.limit ? this.windowMs - (now - entry.start) : null;
  }

  /** Gives one back (what it counted did not happen after all). */
  undo(key: string): void {
    const entry = this.#hits.get(key);
    if (entry !== undefined && entry.count > 0) entry.count -= 1;
  }

  #evict(now: number): void {
    for (const [key, entry] of this.#hits) {
      if (now - entry.start >= this.windowMs) this.#hits.delete(key);
    }
    while (this.#hits.size >= MAX_KEYS) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
  }
}

/** How many run at once, per key and in all. */
export class Slots {
  readonly #per = new Map<string, number>();
  #all = 0;

  constructor(
    readonly perKey: number,
    readonly total: number,
  ) {}

  /** A slot for `key`, or `null` when none is free; call the release once. */
  take(key: string): (() => void) | null {
    const mine = this.#per.get(key) ?? 0;
    if (mine >= this.perKey || this.#all >= this.total) return null;
    this.#per.set(key, mine + 1);
    this.#all += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#all -= 1;
      const left = (this.#per.get(key) ?? 1) - 1;
      if (left <= 0) this.#per.delete(key);
      else this.#per.set(key, left);
    };
  }
}
