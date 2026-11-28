// A member's line in her room (docs/design/her-room.md §3.3): checked, written to the chat log
// first (that resolves identity's room, session and person, so the host's first look at the line
// already finds `web:dm:<person>`), then published as an ordinary `platform.message.created` whose
// author is the member's own account. From there everything runs as for a Discord DM: the input
// defence, the block list, the chat record, identity, the heart, the files book, vision, the lane,
// the Floor, the quota and her `<feel>`.
//
// A blocked person's line is shown back to them and goes nowhere else: no bus, no log, no quota.

import type { RoomFile, RoomSendRequest, RoomSendResult } from "@miyoria/contracts/api";
import { StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  accountRefString,
  Events,
  type IncomingMessage,
  incomingText,
  inspectInput,
  newId,
  PlatformSinksKey,
  ROOM_PLATFORM,
  roomContext,
  toTimestamp,
} from "@miyoria/types";
import { ApiError } from "../errors.js";
import type { SessionRecord } from "../session.js";
import type { ApiState } from "../state.js";
import type { Room } from "./room.js";
import { herHere, roomWho } from "./state.js";
import { ROOM_TEXT } from "./texts.js";

/** `429` in the room's words, with how long to wait. */
export function roomTooMany(waitMs: number): ApiError {
  return new ApiError(429, ROOM_TEXT.tooFast, {
    "cache-control": "no-store",
    "retry-after": String(Math.max(Math.ceil(waitMs / 1000), 1)),
  });
}

/** Whether her room's sink is registered (the module that serves the room is running it). */
function sinkHere(state: ApiState): boolean {
  return state.optional(PlatformSinksKey)?.get(ROOM_PLATFORM) !== undefined;
}

/** `POST /api/member/room/messages`. */
export async function sendLine(
  state: ApiState,
  room: Room,
  session: SessionRecord,
  request: RoomSendRequest,
): Promise<RoomSendResult> {
  const account: AccountRef = session.account;
  const key = accountRefString(account);
  const who = await roomWho(state, account);
  if (!who.open) throw new ApiError(403, ROOM_TEXT.closed);
  if (!herHere(state) || !sinkHere(state)) throw ApiError.unavailable(ROOM_TEXT.away);
  const now = state.now();
  const wait = room.perMinute.wait(key, now) ?? room.perDay.wait(key, now);
  if (wait !== null) throw roomTooMany(wait);
  const text = request.text.trim();
  if ([...text].length > room.config.max_text_chars) throw new ApiError(413, ROOM_TEXT.tooLong);
  const ids = request.uploads ?? [];
  if (ids.length > room.config.max_files) throw new ApiError(413, ROOM_TEXT.tooManyFiles);
  if (text === "" && ids.length === 0) throw new ApiError(422, ROOM_TEXT.empty);
  const taken = room.uploads.take(account, ids);
  if (taken === null) throw ApiError.conflict(ROOM_TEXT.uploadGone);
  room.perMinute.hit(key, now);
  room.perDay.hit(key, now);

  const context = roomContext(account);
  const id = newId();
  const at = toTimestamp(now);
  const msg: IncomingMessage = {
    id: { context, id },
    author: { account, display_name: session.name, is_bot: false },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: taken.map((u) => ({
      url: u.url,
      filename: u.name,
      content_type: u.type === "" ? null : u.type,
      id: u.id,
      size: u.size,
    })),
    ts: at,
  };
  const files: RoomFile[] = taken.map((u) => ({
    name: u.name,
    size: u.size,
    kind: u.kind,
    download: false,
  }));
  const hub = room.channel.hub(account);
  hub.own.set(id, true);
  const you = { kind: "you" as const, id, at, text, files, client_id: request.client_id };
  if (who.blocked) {
    hub.push(you);
    return { id, at, heard: "ok", notice: null };
  }

  // The verdict is kept by message id: the agent asking again for this line gets the same one.
  const verdict = inspectInput(state.ctx.services, {
    id,
    text: incomingText(msg),
    source: "chat",
    author: account,
    context,
  });
  const chat = state.optional(StoreKey)?.chat;
  if (chat !== undefined) await chat.message(msg, { self: false, source: "api" });
  state.ctx.publish(Events.PlatformMessageCreated, msg);
  hub.push(you);
  if (verdict?.action === "ignore") return { id, at, heard: "ignored", notice: ROOM_TEXT.ignored };
  if (verdict?.action === "rate_limit") return { id, at, heard: "held", notice: ROOM_TEXT.held };
  return { id, at, heard: "ok", notice: null };
}
