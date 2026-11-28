// The room's routes (docs/design/her-room.md §3): `roomRpc` on the route table (state, stream,
// send, backlog, relation, forget one memory, leave a line out) and three member routes that are
// not JSON (an upload's raw bytes, her voice as a WAV, her file as a download). Every one of them
// takes the session's account as the only "who", and ids only of that account's own things.

import { ROOM_LINE_ID, type RoomEvent } from "@miyoria/contracts/api";
import { type AccountRef, accountRefString, sniffImage } from "@miyoria/types";
import { withEventMeta } from "@orpc/server";
import { os } from "../contract.js";
import { ApiError } from "../errors.js";
import { limitMember } from "../public.js";
import { memberStillIn, RECHECK_MS } from "../recheck.js";
import { json, param, type Route } from "../route.js";
import { CSRF_HEADER, hasCsrfHeader, type SessionRecord } from "../session.js";
import type { ApiContext, ApiState } from "../state.js";
import { backlog } from "./backlog.js";
import { hello, type Outgoing } from "./channel.js";
import { roomBytes } from "./config.js";
import { excludeLine, herFile } from "./files.js";
import { forgetMemory, relation } from "./relation.js";
import type { Room } from "./room.js";
import { roomTooMany, sendLine } from "./send.js";
import { roomState, roomWho } from "./state.js";
import { ROOM_TEXT } from "./texts.js";
import { lineVoice } from "./voice.js";

/** A stream with nothing to say sends a `ping` this often. */
export const ROOM_PING_MS = 15_000;

/** The room of a running module; the routes exist only while it does. */
export function roomOf(state: ApiState): Room {
  const room = state.room;
  if (room === null || room === undefined) throw ApiError.notFound("no such endpoint");
  return room;
}

const sessionOf = (c: ApiContext): SessionRecord => c.get("member");
const accountOf = (c: ApiContext): AccountRef => sessionOf(c).account;

// ---- the stream ----------------------------------------------------------------------------

/** Ends the request's connection at once (a reader that stopped cannot be told otherwise). */
function dropConnection(c: ApiContext): void {
  const env = c.env as { incoming?: { socket?: { destroy(): void } } } | undefined;
  env?.incoming?.socket?.destroy();
}

async function* events(
  state: ApiState,
  room: Room,
  c: ApiContext,
  lastEventId: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<RoomEvent, void, unknown> {
  const account = accountOf(c);
  const side = state.publicSide;
  const wait = side.admit(side.client(c));
  if (wait !== null) throw roomTooMany(wait);
  const hub = room.channel.hub(account);
  // Counted at once, not when it starts listening: tabs opened together are each counted.
  if (
    hub.tabs >= room.config.streams_per_account ||
    room.channel.streams >= room.config.streams_total
  ) {
    throw roomTooMany(5_000);
  }
  const release = room.channel.opened();
  hub.tabs += 1;
  const queue: Outgoing[] = [];
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  let unlisten: (() => void) | null = null;
  const onAbort = () => poke();
  signal.addEventListener("abort", onAbort);
  try {
    const now = await roomState(state, room, account);
    // From here to the first yield nothing awaits: no event can slip between the replay and the
    // listener.
    hub.sentState = JSON.stringify(now);
    unlisten = hub.listen((out) => {
      queue.push(out);
      poke();
    });
    const head: Outgoing[] = [{ id: hub.latestId(), event: hello(now, hub) }];
    if (lastEventId !== undefined && lastEventId !== "") {
      const missed = hub.since(lastEventId);
      if (missed === null) head.push({ id: hub.latestId(), event: { kind: "reset" } });
      else for (const k of missed) head.push({ id: hub.idOf(k), event: k.event });
    }
    queue.unshift(...head);
    let checkedAt = state.now();
    let quietSince = state.now();
    while (!signal.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        quietSince = state.now();
        yield next.id === null ? next.event : withEventMeta(next.event, { id: next.id });
        continue;
      }
      if (state.now() - checkedAt >= RECHECK_MS) {
        checkedAt = state.now();
        if (!(await memberStillIn(state, c))) {
          dropConnection(c);
          return;
        }
      }
      const left = ROOM_PING_MS - (state.now() - quietSince);
      if (left <= 0) {
        quietSince = state.now();
        yield { kind: "ping" };
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(poke, Math.min(left, RECHECK_MS));
        timer.unref?.();
      });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    unlisten?.();
    hub.tabs -= 1;
    release();
  }
}

/**
 * Starts a stream: what refuses it (too many, the rate limit) is a status before it begins;
 * everything after is events. Returning it (the client went away) ends it at once.
 */
async function begin(
  state: ApiState,
  c: ApiContext,
  lastEventId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<AsyncIteratorObject<RoomEvent, void, unknown>> {
  const room = roomOf(state);
  const stop = new AbortController();
  const ended = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const stream = events(state, room, c, lastEventId, ended);
  let head: IteratorResult<RoomEvent, void> | null = await stream.next();
  const iterator: AsyncIteratorObject<RoomEvent, void, unknown> = {
    next: async () => {
      if (head !== null) {
        const first = head;
        head = null;
        return first;
      }
      return stream.next();
    },
    return: async (value) => {
      stop.abort();
      return stream.return(value);
    },
    throw: async (error) => {
      stop.abort();
      return stream.throw(error);
    },
    [Symbol.asyncDispose]: async () => {
      stop.abort();
      await stream.return(undefined);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

// ---- the table -----------------------------------------------------------------------------

export const roomRpc = {
  state: os.room.state.handler(({ context }) =>
    roomState(context.state, roomOf(context.state), accountOf(context.c)),
  ),
  stream: os.room.stream.handler(({ context, signal, lastEventId }) =>
    begin(context.state, context.c, lastEventId, signal),
  ),
  send: os.room.send.handler(({ input, context }) =>
    sendLine(context.state, roomOf(context.state), sessionOf(context.c), input.body),
  ),
  backlog: os.room.backlog.handler(({ input, context }) =>
    backlog(context.state, roomOf(context.state), accountOf(context.c), input.query.before),
  ),
  relation: os.room.relation.handler(({ context }) =>
    relation(context.state, accountOf(context.c)),
  ),
  forgetMemory: os.room.forgetMemory.handler(({ input, context }) =>
    forgetMemory(context.state, roomOf(context.state), accountOf(context.c), input.params.id),
  ),
  excludeLine: os.room.excludeLine.handler(({ input, context }) =>
    excludeLine(context.state, roomOf(context.state), accountOf(context.c), input.params.id),
  ),
};

// ---- the routes that are not JSON ----------------------------------------------------------

/**
 * The body, read as it comes: `null` as soon as it passes `max` (a declared length over it is not
 * read at all). The cap may tighten once the first bytes say what it is (`capFor`).
 */
export async function bodyCapped(
  c: ApiContext,
  max: number,
  capFor: (head: Uint8Array) => number = () => max,
): Promise<Uint8Array | null> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  const stream = c.req.raw.body;
  if (stream === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cap = max;
  let sniffed = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (!sniffed && total >= 16) {
      sniffed = true;
      cap = Math.min(max, capFor(concat(chunks, total)));
    }
    if (total > cap) {
      await reader.cancel();
      return null;
    }
  }
  const out = concat(chunks, total);
  if (!sniffed && out.byteLength > Math.min(max, capFor(out))) return null;
  return out;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** `POST /api/member/room/uploads`: the file as the body, its name in `X-Miyoria-Filename`. */
async function upload(state: ApiState, c: ApiContext): Promise<Response> {
  const room = roomOf(state);
  limitMember(state, c);
  const account = accountOf(c);
  const key = accountRefString(account);
  const who = await roomWho(state, account);
  if (!who.open) throw new ApiError(403, ROOM_TEXT.closed);
  const wait = room.uploadsPerHour.hit(key, state.now());
  if (wait !== null) throw roomTooMany(wait);
  const bytes = roomBytes(room.config);
  const max = Math.max(bytes.image, bytes.file);
  const tooBig = () =>
    new ApiError(413, ROOM_TEXT.fileTooBig(room.config.max_image_mb, room.config.max_file_mb));
  const isImage = (head: Uint8Array) => (sniffImage(head) !== null ? bytes.image : bytes.file);
  const body = await bodyCapped(c, max, isImage);
  if (body === null) throw tooBig();
  if (body.byteLength === 0) throw new ApiError(422, ROOM_TEXT.empty);
  const kept = room.uploads.put(
    account,
    c.req.header("x-miyoria-filename"),
    c.req.header("content-type"),
    body,
  );
  if (kept === "full") throw ApiError.unavailable(ROOM_TEXT.poolFull);
  return json(kept, 201);
}

/** `GET /api/member/room/voice/{id}`: a GET, and still only with the CSRF header. */
async function voice(state: ApiState, c: ApiContext): Promise<Response> {
  const room = roomOf(state);
  if (!hasCsrfHeader(c.req.header(CSRF_HEADER))) {
    throw new ApiError(403, `this needs the \`${CSRF_HEADER}: 1\` header`);
  }
  limitMember(state, c);
  const line = param(c, "id");
  if (!ROOM_LINE_ID.test(line)) throw ApiError.notFound(ROOM_TEXT.notFound);
  const hub = room.channel.existing(accountOf(c));
  if (hub === undefined) throw ApiError.notFound(ROOM_TEXT.notFound);
  return lineVoice(state, room, hub, line, c.req.raw.signal);
}

/** `GET /api/member/room/files/{id}/{n}`. */
async function file(state: ApiState, c: ApiContext): Promise<Response> {
  const room = roomOf(state);
  limitMember(state, c);
  const line = param(c, "id");
  const n = param(c, "n");
  if (!ROOM_LINE_ID.test(line) || !/^\d{1,2}$/.test(n)) throw ApiError.notFound(ROOM_TEXT.notFound);
  const hub = room.channel.existing(accountOf(c));
  if (hub === undefined) throw ApiError.notFound(ROOM_TEXT.notFound);
  return herFile(state, room, hub, line, Number(n), c.req.raw.signal);
}

/** The room's member routes that are not on the route table; none while the room is off. */
export function roomRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled || state.room === null || state.room === undefined) {
    return [];
  }
  const routes: Route[] = [
    { method: "POST", path: "/api/member/room/uploads", handler: (c) => upload(state, c) },
    { method: "GET", path: "/api/member/room/voice/:id", handler: (c) => voice(state, c) },
    { method: "GET", path: "/api/member/room/files/:id/:n", handler: (c) => file(state, c) },
  ];
  return routes.map((r) => ({ ...r, member: true }));
}
