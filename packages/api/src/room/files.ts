// What a member gets of a line of her room (docs/design/her-room.md §3.7, §3.9): a file she handed
// them, and "do not remember this" for a line of their own. Each takes only ids of this account's
// room, and checks them again against what the room knows; anything else is a 404, the same as
// "there is no such thing".
//
// A file is checked once more at the artifact store (still there, seen in this room, the bytes it
// recorded), an image is handed out cleaned as it would be to Discord, and nothing she made is ever
// shown on the site's own origin: always a download, an image type only for an image's bytes, and
// a sandbox policy besides.

import { ArtifactStoreKey, messageKey, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  AttachmentError,
  AttachmentSourceKey,
  attachmentErrorOf,
  MessageActionsKey,
  roomContext,
  sniffImage,
} from "@miyoria/types";
import { ApiError } from "../errors.js";
import { disposition } from "../files/serve.js";
import type { ApiState } from "../state.js";
import type { RoomHub } from "./channel.js";
import { roomBytes } from "./config.js";
import type { Room } from "./room.js";
import { roomTooMany } from "./send.js";
import { ROOM_TEXT } from "./texts.js";

const notFound = () => ApiError.notFound(ROOM_TEXT.notFound);

/** `GET /api/member/room/files/{id}/{n}`. */
export async function herFile(
  state: ApiState,
  room: Room,
  hub: RoomHub,
  line: string,
  n: number,
  signal?: AbortSignal,
): Promise<Response> {
  const her = hub.lines.get(line);
  const artifactId = Number.isInteger(n) && n >= 0 ? her?.artifacts[n] : undefined;
  if (artifactId === undefined) throw notFound();
  const source = state.optional(AttachmentSourceKey);
  if (source === undefined) throw ApiError.unavailable(ROOM_TEXT.away);
  let file: Awaited<ReturnType<typeof source.open>>;
  try {
    file = await source.open(artifactId, roomContext(hub.account), {
      maxBytes: roomBytes(room.config).file,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof AttachmentError || attachmentErrorOf(error) !== null) throw notFound();
    throw error;
  }
  let data = file.data;
  let image = sniffImage(data);
  const cleaner = state.files?.cleaner;
  const store = state.optional(ArtifactStoreKey);
  if (image !== null) {
    // An image is never handed out with its metadata: without a cleaner, not at all.
    const artifact = store?.get(artifactId) ?? null;
    if (cleaner === undefined || store === undefined || artifact === null) throw notFound();
    const out = await cleaner.handOut(artifact, signal);
    data = await store.readContent(out.artifact, signal);
    image = sniffImage(data);
  }
  return new Response(data.slice(), {
    status: 200,
    headers: {
      "content-type": image ?? "application/octet-stream",
      "content-length": String(data.byteLength),
      "content-disposition": disposition("attachment", file.filename),
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/** `POST /api/member/room/lines/{id}/exclude`: their own line of this room only. */
export async function excludeLine(
  state: ApiState,
  room: Room,
  account: AccountRef,
  id: string,
): Promise<{ excluded: boolean }> {
  const key = `${account.platform}:${account.id}`;
  const wait = room.excludes.hit(key, state.now());
  if (wait !== null) throw roomTooMany(wait);
  const hub = room.channel.existing(account);
  // A line the room gave them (sent, or shown in their backlog) and still in the chat log.
  if (hub === undefined || !hub.own.has(id)) return { excluded: false };
  const ref = { context: roomContext(account), id };
  const chat = state.optional(StoreKey)?.chat;
  if (chat !== undefined) {
    const events = await chat.eventsOf(messageKey(ref));
    if (events.length === 0) return { excluded: false };
    const gone = await chat.redacted(events);
    if (events.every((e) => gone.has(e))) return { excluded: false };
  }
  const actions = state.optional(MessageActionsKey);
  if (actions === undefined) return { excluded: false };
  const outcome = await actions.dontRemember({
    message: ref,
    author: account,
    requested_by: account,
  });
  if (outcome.ok) hub.own.delete(id);
  return { excluded: outcome.ok };
}
