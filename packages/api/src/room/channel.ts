// The room's channel to the browser (docs/design/her-room.md §3.4): one hub per account, each with a
// ring of its last events, and the streams (tabs) of that account reading from it. Nothing here is
// ever broadcast to every room: a hub is reached by its account only (`roomAccount(context)`), so
// one member's events cannot reach another's stream.
//
// An event's id is `<run>-<n>`: `run` is random per start of the Core, `n` counts the hub's events.
// A reconnect with `Last-Event-ID` gets what came after it when it is of this run and still in the
// ring; otherwise `hello` and then `reset` (the page reads the backlog again). The first event of a
// stream is always `hello`.

import { randomBytes } from "node:crypto";
import type { RoomEvent, RoomFile, RoomState } from "@miyoria/contracts/api";
import { type AccountRef, accountRefString } from "@miyoria/types";

/** Events a hub keeps for reconnects. */
export const RING_EVENTS = 200;
/** How long a hub keeps an event for reconnects. */
export const RING_MS = 10 * 60_000;
/** Her lines a hub remembers for their voice and files (this run of the Core only). */
const KNOWN_LINES = 500;
/** Their own lines a hub remembers as theirs (for "do not remember this"). */
const KNOWN_OWN = 2_000;
/** Turns remembered as this room's (for her bond marks). */
const KNOWN_TURNS = 500;

/** An event as the stream sends it, with its id (`null`: none, a `ping`). */
export interface Outgoing {
  id: string | null;
  event: RoomEvent;
}

/** One line of hers in this room, as far as its voice and files need it. */
export interface HerLine {
  id: string;
  at: number;
  text: string;
  turn: string | null;
  /** Her face when she said it (`agent.emotion` of that turn), for the voice. */
  emotion: string | null;
  /** The artifact behind each file, in order. */
  artifacts: string[];
  files: RoomFile[];
}

interface Kept {
  n: number;
  at: number;
  event: RoomEvent;
}

/** A small map that forgets its oldest entries. */
class Bounded<K, V> {
  readonly #map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    return this.#map.get(key);
  }
  has(key: K): boolean {
    return this.#map.has(key);
  }
  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }
  delete(key: K): void {
    this.#map.delete(key);
  }
}

/** One account's room: its ring of events, its open streams and what it knows of its lines. */
export class RoomHub {
  readonly #ring: Kept[] = [];
  readonly #listeners = new Set<(out: Outgoing) => void>();
  #n = 0;
  /** Her run going on here, for `hello`. */
  turn: { id: string; phase: "thinking" | "speaking" } | null = null;
  /** The last turn of hers that started here: her lines of it go out after it started. */
  lastTurn: string | null = null;
  /** Her face in this room's last turn. */
  face: string | null = null;
  /** Tools of the running turn that have not ended (`working`). */
  readonly tools = new Map<string, string>();
  /** The state last sent (`state` goes out only when it changed). */
  sentState: string | null = null;
  lastTypingAt = 0;
  /** Streams of this account open or still starting (the per-account limit counts these). */
  tabs = 0;
  readonly lines = new Bounded<string, HerLine>(KNOWN_LINES);
  readonly own = new Bounded<string, true>(KNOWN_OWN);

  constructor(
    readonly account: AccountRef,
    private readonly run: string,
    private readonly now: () => number,
  ) {}

  /** Open streams. */
  get streams(): number {
    return this.#listeners.size;
  }

  /** The id of the newest event (what `hello` carries), or `<run>-0`. */
  latestId(): string {
    return `${this.run}-${this.#n}`;
  }

  /** Keeps `event` and hands it to every open stream of this account. */
  push(event: RoomEvent): void {
    this.#n += 1;
    const now = this.now();
    this.#ring.push({ n: this.#n, at: now, event });
    this.#trim(now);
    const out: Outgoing = { id: `${this.run}-${this.#n}`, event };
    for (const listener of this.#listeners) listener(out);
  }

  /** Hands `event` to the open streams now without keeping it (a `state` worked out per stream). */
  tell(event: RoomEvent): void {
    const out: Outgoing = { id: null, event };
    for (const listener of this.#listeners) listener(out);
  }

  /**
   * The events after `lastEventId`, or `null` when they cannot be told (another run, too old, an
   * id this hub never gave).
   */
  since(lastEventId: string): Kept[] | null {
    const m = /^([A-Za-z0-9_-]+)-(\d{1,12})$/.exec(lastEventId);
    if (m === null || m[1] !== this.run) return null;
    const n = Number(m[2]);
    if (n > this.#n) return null;
    this.#trim(this.now());
    const first = this.#ring[0];
    // The one right after it must still be here (or nothing came after it).
    if (n < this.#n && (first === undefined || first.n > n + 1)) return null;
    return this.#ring.filter((k) => k.n > n);
  }

  idOf(k: Kept): string {
    return `${this.run}-${k.n}`;
  }

  listen(listener: (out: Outgoing) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #trim(now: number): void {
    while (this.#ring.length > RING_EVENTS) this.#ring.shift();
    while (this.#ring.length > 0 && now - (this.#ring[0] as Kept).at > RING_MS) this.#ring.shift();
  }
}

/** Every account's hub, and the turns that are this room's. */
export class RoomChannel {
  readonly run: string;
  readonly #hubs = new Map<string, RoomHub>();
  /** Turn id → the account whose room it ran in. */
  readonly #turns = new Bounded<string, AccountRef>(KNOWN_TURNS);
  #streams = 0;

  constructor(
    private readonly now: () => number,
    run?: string,
  ) {
    this.run = run ?? randomBytes(6).toString("base64url");
  }

  hub(account: AccountRef): RoomHub {
    const key = accountRefString(account);
    let hub = this.#hubs.get(key);
    if (hub === undefined) {
      hub = new RoomHub(account, this.run, this.now);
      this.#hubs.set(key, hub);
    }
    return hub;
  }

  /** The hub of `account` if it has one (a lookup never makes one). */
  existing(account: AccountRef): RoomHub | undefined {
    return this.#hubs.get(accountRefString(account));
  }

  /** Hubs with an open stream. */
  watched(): RoomHub[] {
    return [...this.#hubs.values()].filter((h) => h.streams > 0);
  }

  /** Every open stream. */
  get streams(): number {
    return this.#streams;
  }

  /** A stream opens (`release` when it ends). */
  opened(): () => void {
    this.#streams += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#streams -= 1;
    };
  }

  /** `turn` ran in `account`'s room. */
  turnIn(turn: string, account: AccountRef): void {
    this.#turns.set(turn, account);
  }

  /** The account whose room `turn` ran in, if it did. */
  turnOf(turn: string): AccountRef | undefined {
    return this.#turns.get(turn);
  }
}

/** The `hello` event of a stream. */
export function hello(state: RoomState, hub: RoomHub): RoomEvent {
  return { kind: "hello", state, turn: hub.turn };
}
