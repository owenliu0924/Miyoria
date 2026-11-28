// Her room's routes through the shell (docs/design/her-room.md §3.1, §3.3, §3.4): the stream starts
// with `hello`, a good `Last-Event-ID` gets what it missed and a stale one `reset`, a person has
// `streams_per_account` tabs; an upload is refused as soon as it passes its cap while it is read,
// an image's cap is the image's, and `uploads_per_hour` holds.

import { ROOM_BODY_BYTES, type RoomEvent } from "@miyoria/contracts/api";
import { PlacesKey } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import { RING_MS } from "../src/room/channel.js";
import { roomRoutes, roomRpc } from "../src/room/routes.js";
import { ROOM_TEXT } from "../src/room/texts.js";
import { tableRoutes } from "../src/rpc.js";
import { ALICE, appOf, BOB, makeRig, settle } from "./room-rig.js";

const MB = 1024 * 1024;

function routeRig(config: Record<string, unknown> = {}) {
  const rig = makeRig(config);
  const as = { account: ALICE };
  const table: AnyRouter = { room: roomRpc };
  const app = appOf(
    [
      ...tableRoutes(rig.state as never, table, { responseCheck: "strict" }),
      ...roomRoutes(rig.state as never),
    ],
    as,
  );
  return { ...rig, as, app };
}

interface Sse {
  id: string | null;
  data: RoomEvent;
}

/** Reads the stream's messages one at a time; comments (keep-alives) are skipped. */
class Reader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(res: Response) {
    this.#reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }

  async next(): Promise<Sse> {
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        const lines = block.split("\n");
        if (lines.every((l) => l.startsWith(":") || l === "")) continue;
        let id: string | null = null;
        let data = "";
        for (const line of lines) {
          if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        return { id, data: JSON.parse(data) as RoomEvent };
      }
      const { value, done } = await this.#reader.read();
      if (done) throw new Error("the stream ended");
      this.#buffer += this.#decoder.decode(value, { stream: true });
    }
  }

  async take(n: number): Promise<Sse[]> {
    const out: Sse[] = [];
    for (let i = 0; i < n; i++) out.push(await this.next());
    return out;
  }

  cancel(): Promise<void> {
    return this.#reader.cancel().catch(() => {});
  }
}

const open: Reader[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.cancel();
});

async function stream(
  r: ReturnType<typeof routeRig>,
  account = ALICE,
  lastEventId?: string,
): Promise<Response> {
  r.as.account = account;
  return r.app.request("/api/member/room/stream", {
    headers: lastEventId === undefined ? {} : { "last-event-id": lastEventId },
  });
}

async function reader(r: ReturnType<typeof routeRig>, account = ALICE, lastEventId?: string) {
  const res = await stream(r, account, lastEventId);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const sse = new Reader(res);
  open.push(sse);
  return sse;
}

/** Until every stream let go of its slot. */
async function released(r: ReturnType<typeof routeRig>): Promise<void> {
  for (let i = 0; i < 50 && r.room.channel.streams > 0; i++) await settle();
}

describe("the room's stream", () => {
  it("says hello first, then the room's events as they come", async () => {
    const r = routeRig();
    const sse = await reader(r);
    const hello = await sse.next();
    expect(hello.id).toBe("run1-0");
    expect(hello.data).toMatchObject({ kind: "hello", turn: null, state: { open: true } });
    r.room.channel.hub(BOB).push({ kind: "thinking", turn: "bob-turn" });
    r.room.channel.hub(ALICE).push({ kind: "thinking", turn: "t1" });
    // Bob's event was never Alice's: the next she reads is her own.
    expect(await sse.next()).toEqual({ id: "run1-1", data: { kind: "thinking", turn: "t1" } });
  });

  it("replays what a good Last-Event-ID missed, then goes on", async () => {
    const r = routeRig();
    const hub = r.room.channel.hub(ALICE);
    for (const t of ["t1", "t2", "t3"]) hub.push({ kind: "thinking", turn: t });
    const sse = await reader(r, ALICE, "run1-1");
    const head = await sse.take(3);
    expect(head.map((m) => [m.id, m.data.kind])).toEqual([
      ["run1-3", "hello"],
      ["run1-2", "thinking"],
      ["run1-3", "thinking"],
    ]);
    expect(head.slice(1).map((m) => m.data)).toEqual([
      { kind: "thinking", turn: "t2" },
      { kind: "thinking", turn: "t3" },
    ]);
    hub.push({ kind: "done", turn: "t3" });
    expect(await sse.next()).toEqual({ id: "run1-4", data: { kind: "done", turn: "t3" } });
  });

  it("says hello and reset for a stale Last-Event-ID", async () => {
    const r = routeRig();
    const hub = r.room.channel.hub(ALICE);
    hub.push({ kind: "thinking", turn: "t1" });
    hub.push({ kind: "thinking", turn: "t2" });
    for (const stale of ["run0-1", "run1-9"]) {
      const sse = await reader(r, ALICE, stale);
      expect((await sse.take(2)).map((m) => [m.id, m.data.kind])).toEqual([
        ["run1-2", "hello"],
        ["run1-2", "reset"],
      ]);
      await sse.cancel();
      await released(r);
    }
    // Trimmed out of the ring by age.
    r.clock.t += RING_MS + 1;
    hub.push({ kind: "thinking", turn: "t3" });
    const sse = await reader(r, ALICE, "run1-1");
    expect((await sse.take(2)).map((m) => m.data.kind)).toEqual(["hello", "reset"]);
  });

  it("gives a person streams_per_account tabs, and another person their own", async () => {
    const r = routeRig({ streams_per_account: 1 });
    const first = await reader(r);
    await first.next();
    const refused = await stream(r);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toMatchObject({ error: ROOM_TEXT.tooFast });
    const bob = await reader(r, BOB);
    expect((await bob.next()).data.kind).toBe("hello");
    await first.cancel();
    await released(r);
    expect(r.room.channel.streams).toBe(1);
    const again = await reader(r);
    expect((await again.next()).data.kind).toBe("hello");
  });

  it("counts tabs opened at the same moment", async () => {
    const r = routeRig({ streams_per_account: 1 });
    const both = await Promise.all([stream(r), stream(r)]);
    for (const res of both) if (res.status === 200) open.push(new Reader(res));
    expect(both.map((res) => res.status).sort()).toEqual([200, 429]);
  });

  it("holds streams_total for everyone together", async () => {
    const r = routeRig({ streams_total: 1 });
    const first = await reader(r);
    await first.next();
    expect((await stream(r, BOB)).status).toBe(429);
  });
});

// ---- uploads --------------------------------------------------------------------------------

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytes(size: number, head: number[] = []): Uint8Array {
  const out = new Uint8Array(size).fill(0x61);
  out.set(head.slice(0, size));
  return out;
}

async function upload(
  r: ReturnType<typeof routeRig>,
  body: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Promise<Response> {
  r.as.account = ALICE;
  return r.app.request("/api/member/room/uploads", {
    method: "POST",
    body,
    headers: { "x-miyoria-filename": encodeURIComponent("f.bin"), ...headers },
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** A body that never ends, counting what was read of it. */
function endless(chunk = 64 * 1024) {
  const read = { bytes: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      read.bytes += chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      read.cancelled = true;
    },
  });
  return { body, read };
}

describe("the room's uploads route", () => {
  const config = { max_image_mb: 0.25, max_file_mb: 0.5 };

  it("keeps a file and answers what it kept", async () => {
    const r = routeRig(config);
    const res = await upload(r, bytes(1000), { "content-type": "application/pdf" });
    expect(res.status).toBe(201);
    const kept = (await res.json()) as { id: string; kind: string; size: number; name: string };
    expect(kept).toMatchObject({ kind: "file", size: 1000, name: "f.bin" });
    expect(kept.id).toMatch(/^up_[A-Za-z0-9_-]{22}$/);
    expect(r.room.uploads.take(ALICE, [kept.id])).toHaveLength(1);
  });

  it("refuses a body over the cap while reading it, and a declared length over it unread", async () => {
    const r = routeRig(config);
    const { body, read } = endless();
    const res = await upload(r, body);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: ROOM_TEXT.fileTooBig(0.25, 0.5) });
    // Stopped a little past the cap, never read to the end (there is none).
    expect(read.bytes).toBeLessThanOrEqual(0.5 * MB + 3 * 64 * 1024);
    expect(read.cancelled).toBe(true);
    const declared = endless();
    const big = await upload(r, declared.body, { "content-length": String(MB) });
    expect(big.status).toBe(413);
    expect(declared.read.bytes).toBeLessThanOrEqual(2 * 64 * 1024);
    expect(r.room.uploads.total).toBe(0);
  });

  it("holds an image to the image's cap", async () => {
    const r = routeRig(config);
    const size = Math.floor(0.25 * MB) + 1;
    expect((await upload(r, bytes(size, PNG_HEAD))).status).toBe(413);
    // The same size, not an image: under the file's cap.
    expect((await upload(r, bytes(size))).status).toBe(201);
    const ok = await upload(r, bytes(size - 1, PNG_HEAD));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ kind: "image" });
    expect((await upload(r, bytes(Math.floor(0.5 * MB) + 1))).status).toBe(413);
    expect((await upload(r, new Uint8Array())).status).toBe(422);
  });

  it("allows uploads_per_hour uploads an hour", async () => {
    const r = routeRig({ ...config, uploads_per_hour: 2 });
    expect((await upload(r, bytes(10))).status).toBe(201);
    expect((await upload(r, bytes(10))).status).toBe(201);
    const refused = await upload(r, bytes(10));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("3600");
    r.clock.t += 60 * 60_000;
    expect((await upload(r, bytes(10))).status).toBe(201);
  });

  it("is closed to someone the room is not open to", async () => {
    const r = routeRig(config);
    r.services.set(PlacesKey, { spacesOf: () => [] });
    const res = await upload(r, bytes(10));
    expect(res.status).toBe(403);
    expect(r.room.uploads.total).toBe(0);
  });
});

// ---- JSON bodies ----------------------------------------------------------------------------

describe("the room's JSON bodies", () => {
  const send = (
    r: ReturnType<typeof routeRig>,
    body: string | ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
  ) =>
    r.app.request("/api/member/room/messages", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);

  it("refuses a body over ROOM_BODY_BYTES in the room's words, without reading it all", async () => {
    const r = routeRig();
    const padded = JSON.stringify({ text: "嗨", client_id: "c-12345678", pad: "a".repeat(20_000) });
    const big = await send(r, padded);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: ROOM_TEXT.tooLong });
    // A body with no declared length that never ends: stopped a little past the cap.
    const { body, read } = endless(4 * 1024);
    const endlessRes = await send(r, body);
    expect(endlessRes.status).toBe(413);
    expect(read.bytes).toBeLessThanOrEqual(ROOM_BODY_BYTES + 3 * 4 * 1024);
    expect(read.cancelled).toBe(true);
    // A line as long as the room allows still fits.
    const longest = JSON.stringify({ text: "字".repeat(2_000), client_id: "c-12345678" });
    const ok = await send(r, longest);
    expect(ok.status).not.toBe(413);
  });
});
