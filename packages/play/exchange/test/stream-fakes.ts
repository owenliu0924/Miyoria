// A WebSocket the tests drive, and frames of Yahoo's streamer as it sends them (a protobuf
// `PricingData`, base64 in a JSON text frame), made here from made-up numbers.

import type { SocketLike } from "../src/real/yahoo-stream.js";

export class FakeSocket implements SocketLike {
  static made: FakeSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  readonly #listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }

  static reset(): void {
    FakeSocket.made = [];
  }

  static last(): FakeSocket {
    const s = FakeSocket.made.at(-1);
    if (!s) throw new Error("no socket was made");
    return s;
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  #emit(type: string, ev: unknown = {}): void {
    for (const l of this.#listeners.get(type) ?? []) l(ev);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.#emit("close");
  }

  /** The server accepts the connection. */
  open(): void {
    this.readyState = 1;
    this.#emit("open");
  }

  /** The server sends a text frame. */
  text(data: string): void {
    this.#emit("message", { data });
  }

  /** The connection drops from the other side. */
  drop(): void {
    this.closed = true;
    this.readyState = 3;
    this.#emit("close");
  }

  /** The subscriptions sent, parsed. */
  messages(): { subscribe?: string[]; unsubscribe?: string[] }[] {
    return this.sent.map((s) => JSON.parse(s) as { subscribe?: string[]; unsubscribe?: string[] });
  }
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 128) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const key = (field: number, wire: number) => varint(field * 8 + wire);
const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);

function f32(x: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return [...b];
}

function str(field: number, s: string): number[] {
  const b = [...new TextEncoder().encode(s)];
  return [...key(field, 2), ...varint(b.length), ...b];
}

/** A `PricingData` with the fields the stream reads, and an unknown one of each wire type to skip. */
export function pricing(p: {
  id: string;
  price: number;
  time: number;
  marketHours?: number;
  change?: number;
}): Uint8Array {
  return new Uint8Array([
    ...str(1, p.id),
    ...key(2, 5),
    ...f32(p.price),
    ...key(3, 0),
    ...varint(zigzag(p.time)),
    ...str(5, "NMS"),
    ...key(7, 0),
    ...varint(p.marketHours ?? 1),
    ...key(9, 0),
    ...varint(123_456_789),
    ...(p.change === undefined ? [] : [...key(12, 5), ...f32(p.change)]),
    ...key(40, 1),
    ...[1, 2, 3, 4, 5, 6, 7, 8],
    ...str(41, "skipped"),
  ]);
}

/** The text frame the streamer sends for `p`. */
export function frame(p: Parameters<typeof pricing>[0]): string {
  return JSON.stringify({
    type: "pricing",
    message: Buffer.from(pricing(p)).toString("base64"),
  });
}
