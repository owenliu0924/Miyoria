// The backlog's gestures (docs/design/her-room.md §7.3, the mock): a swipe up from the capsule opens
// it, a swipe down on its head closes it, wheel up over the stage opens it. Pointer events, so a
// finger and a mouse drag both work. The decisions are here, without the DOM, so they are tested;
// every gesture also has a key and a button (PageUp, Escape, 紀錄, 關閉).

/** Movement before a press counts as a drag rather than a tap, px. */
export const DRAG_START = 8;
/** How far a drag goes before it is a swipe, px. */
export const SWIPE_MIN = 56;
/** Wheel travel upwards (summed) that opens the backlog. */
export const WHEEL_OPEN = 60;

export type SwipeEnd = "swipe" | "tap" | null;

/** One press, from down to up: `dir` -1 for a swipe up, 1 for down. */
export class SwipeTracker {
  readonly #dir: -1 | 1;
  #start: { x: number; y: number; id: number } | null = null;
  #moved = false;

  constructor(dir: -1 | 1) {
    this.#dir = dir;
  }

  get active(): boolean {
    return this.#start !== null;
  }

  down(x: number, y: number, id: number): void {
    this.#start = { x, y, id };
    this.#moved = false;
  }

  /** The distance to follow (0 until it is a drag), or `null` for another pointer. */
  move(x: number, y: number, id: number): number | null {
    const s = this.#start;
    if (!s || s.id !== id) return null;
    const dy = y - s.y;
    const dx = x - s.x;
    if (!this.#moved && Math.abs(dy) > DRAG_START && Math.abs(dy) > Math.abs(dx)) this.#moved = true;
    return this.#moved ? dy : 0;
  }

  /** How the press ended: a swipe the right way, a tap, or nothing (`cancel`: the browser took it). */
  up(x: number, y: number, id: number, cancel = false): SwipeEnd {
    const s = this.#start;
    if (!s || s.id !== id) return null;
    this.#start = null;
    if (cancel) return null;
    const dy = y - s.y;
    const dx = x - s.x;
    if (this.#moved) return dy * this.#dir > SWIPE_MIN && Math.abs(dy) > Math.abs(dx) ? "swipe" : null;
    return "tap";
  }
}

/** Sums wheel travel upwards; any downward turn starts again. */
export class WheelUp {
  #sum = 0;

  /** One wheel event's `deltaY`: whether it is time to open. */
  push(deltaY: number): boolean {
    this.#sum = deltaY < 0 ? this.#sum - deltaY : 0;
    if (this.#sum <= WHEEL_OPEN) return false;
    this.#sum = 0;
    return true;
  }
}
