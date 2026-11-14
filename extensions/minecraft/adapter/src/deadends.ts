// Dead-end memory (design doc P1). On 2026-11-08 she spent the last half hour exploring the same
// sea: every `explore` started from where she stood, Baritone picked the nearest unexplored
// chunks, and the next one did the same. Now an explore that saw nothing new marks the ground it
// covered as dull, one that looked for something and did not find it marks that too, and the
// next explore without a center starts from the direction with the fewest dull places around.
// Kept per dimension in cells of `CELL` blocks, forgotten after `TTL_MS`. Pure; times are epoch ms.

/** Size of one remembered cell, in blocks. */
export const CELL = 48;
/** How far an explore is sent away from the dull places, in blocks. */
export const STEER_BLOCKS = 96;
/** How long a dull place is remembered. */
export const TTL_MS = 60 * 60_000;
/** Dull cells within this many cells of her make the next explore steer away. */
const NEAR_CELLS = 3;

interface Pos {
  x: number;
  z: number;
}

interface Mark {
  at: number;
  /** Nothing new at all here (`*`), or the things looked for and not found. */
  missing: Set<string>;
}

/** The eight directions, clockwise from north (-z), with their names. */
const DIRECTIONS: ReadonlyArray<{ dx: number; dz: number; name: string }> = [
  { dx: 0, dz: -1, name: "北" },
  { dx: 1, dz: -1, name: "東北" },
  { dx: 1, dz: 0, name: "東" },
  { dx: 1, dz: 1, name: "東南" },
  { dx: 0, dz: 1, name: "南" },
  { dx: -1, dz: 1, name: "西南" },
  { dx: -1, dz: 0, name: "西" },
  { dx: -1, dz: -1, name: "西北" },
];

export interface Steer {
  x: number;
  z: number;
  /** `往東南` */
  direction: string;
  /** Dull cells near her when it was chosen. */
  dull: number;
}

function cellOf(p: Pos): [number, number] {
  return [Math.floor(p.x / CELL), Math.floor(p.z / CELL)];
}

export class DeadEnds {
  readonly #cells = new Map<string, Mark>();

  #key(dimension: string, cx: number, cz: number): string {
    return `${dimension}:${cx}:${cz}`;
  }

  /**
   * Marks the cells on the straight line from `from` to `to` (where an explore started and
   * ended): nothing new there (`missing` empty), or none of `missing` there.
   */
  mark(dimension: string, from: Pos, to: Pos, missing: string[], now: number): void {
    const [ax, az] = cellOf(from);
    const [bx, bz] = cellOf(to);
    const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az), 0);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const cx = Math.round(ax + (bx - ax) * t);
      const cz = Math.round(az + (bz - az) * t);
      const key = this.#key(dimension, cx, cz);
      const mark = this.#cells.get(key);
      const fresh = !mark || now - mark.at > TTL_MS;
      const what = missing.length === 0 ? ["*"] : missing;
      if (fresh) this.#cells.set(key, { at: now, missing: new Set(what) });
      else {
        mark.at = now;
        for (const m of what) mark.missing.add(m);
      }
    }
  }

  /** Whether cell (`cx`, `cz`) is dull for an explore looking for `find` (anything when empty). */
  #dull(dimension: string, cx: number, cz: number, find: string[], now: number): boolean {
    const mark = this.#cells.get(this.#key(dimension, cx, cz));
    if (!mark || now - mark.at > TTL_MS) return false;
    if (mark.missing.has("*")) return true;
    return find.length > 0 && find.every((f) => mark.missing.has(f));
  }

  /** Dull cells within `radius` cells of `p`. */
  #around(dimension: string, p: Pos, radius: number, find: string[], now: number): number {
    const [cx, cz] = cellOf(p);
    let n = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (this.#dull(dimension, cx + dx, cz + dz, find, now)) n++;
      }
    }
    return n;
  }

  /**
   * Where the next explore from `here` should be centered: `null` when no dull place is near
   * (Baritone's own choice is fine), else the point `STEER_BLOCKS` away in the direction with the
   * fewest dull places around it (ties: the one facing most directly away from them).
   */
  steer(dimension: string, here: Pos, find: string[], now: number): Steer | null {
    const near = this.#around(dimension, here, NEAR_CELLS, find, now);
    if (near === 0) return null;
    // Which way the dull places lie, to break ties by facing away from them.
    const [hx, hz] = cellOf(here);
    let ax = 0;
    let az = 0;
    for (let dx = -NEAR_CELLS; dx <= NEAR_CELLS; dx++) {
      for (let dz = -NEAR_CELLS; dz <= NEAR_CELLS; dz++) {
        if (this.#dull(dimension, hx + dx, hz + dz, find, now)) {
          ax -= dx;
          az -= dz;
        }
      }
    }
    let best: Steer | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestAway = Number.NEGATIVE_INFINITY;
    for (const d of DIRECTIONS) {
      const len = Math.hypot(d.dx, d.dz);
      const x = Math.round(here.x + (d.dx / len) * STEER_BLOCKS);
      const z = Math.round(here.z + (d.dz / len) * STEER_BLOCKS);
      const score = this.#around(dimension, { x, z }, 1, find, now);
      const away = (d.dx * ax + d.dz * az) / len;
      if (score < bestScore || (score === bestScore && away > bestAway)) {
        best = { x, z, direction: `往${d.name}`, dull: near };
        bestScore = score;
        bestAway = away;
      }
    }
    return best;
  }

  /** Remembered cells (tests, logs). */
  get size(): number {
    return this.#cells.size;
  }
}
