// The progress watchdog (design doc P1). A body task that runs but changes nothing — Baritone
// pacing on one spot, a path it keeps recomputing, a plan step waiting on a block it cannot reach —
// used to run until its budget (up to 15 minutes for `build`). Now each one says what progress
// looks like and is ended with `stuck` when none came for its window: she moved, her inventory
// changed, a workbench job ran, a plan reported a step, or a reflex had her body (not the task's
// fault). A step that waits on purpose (a furnace burning) says how long it will be quiet. Pure;
// times are epoch ms.

import type { Snapshot } from "./summary.js";

/**
 * Seconds without progress before a goal's task counts as stuck. Goals not listed are not
 * watched: `follow` (the player may stand still), `shelter` (waiting out the night is the
 * plan), instant ones, and `idle` (the goal it runs is watched instead).
 */
export const STALL_SECS: Readonly<Record<string, number>> = {
  goto: 45,
  explore: 45,
  mine: 60,
  farm: 60,
  obtain: 60,
  hunt: 60,
  recover: 60,
  get: 90,
  build: 90,
};

/** Blocks she has to move from the last point of progress for it to count. */
export const MOVE_BLOCKS = 2;

interface Pos {
  x: number;
  y: number;
  z: number;
}

function positionOf(s: Snapshot): Pos | null {
  return s.block_position ?? s.position ?? null;
}

function inventoryKey(s: Snapshot): string | null {
  const inv = s.inventory;
  if (!inv) return null;
  return Object.keys(inv)
    .sort()
    .map((k) => `${k}=${inv[k]}`)
    .join(",");
}

export class StallWatch {
  readonly #windowMs: number;
  #since: number;
  #quietUntil = 0;
  #anchor: Pos | null = null;
  #inventory: string | null = null;
  #why = "";

  constructor(windowMs: number, now: number) {
    this.#windowMs = windowMs;
    this.#since = now;
  }

  /** Something the task reported counts as progress (a plan step). */
  bump(now: number): void {
    this.#since = Math.max(this.#since, now);
  }

  /** The task waits on purpose until `until` (a furnace burning): no progress is expected. */
  quiet(until: number): void {
    this.#quietUntil = Math.max(this.#quietUntil, until);
  }

  /** What it last saw that counted, for the failure's detail. */
  get lastProgress(): string {
    return this.#why;
  }

  /**
   * Looks at a snapshot: whether the task is stuck now (no progress for its window, outside a
   * quiet wait). A missing snapshot (disconnected, menu) is not her fault and resets nothing.
   */
  look(s: Snapshot | null, now: number): boolean {
    if (s) {
      const pos = positionOf(s);
      if (pos) {
        const a = this.#anchor;
        if (a === null) {
          this.#anchor = pos;
        } else if (Math.hypot(pos.x - a.x, pos.y - a.y, pos.z - a.z) >= MOVE_BLOCKS) {
          this.#anchor = pos;
          this.#progress(now, "移動了");
        }
      }
      const inv = inventoryKey(s);
      if (inv !== null) {
        if (this.#inventory !== null && inv !== this.#inventory) this.#progress(now, "背包有變化");
        this.#inventory = inv;
      }
      if (s.crafting) this.#progress(now, "在合成或燒東西");
      if (s.reflex?.active) this.#progress(now, "身體的本能反應在動");
    }
    // The window starts again where a quiet wait ends.
    this.#since = Math.max(this.#since, Math.min(now, this.#quietUntil));
    if (now < this.#quietUntil) return false;
    return now - this.#since >= this.#windowMs;
  }

  /** Seconds since the last progress. */
  idleSecs(now: number): number {
    return Math.round(Math.max(now - this.#since, 0) / 1000);
  }

  #progress(now: number, why: string): void {
    this.#since = now;
    this.#why = why;
  }
}
