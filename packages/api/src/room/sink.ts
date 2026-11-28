// The room's `PlatformSink` (docs/design/her-room.md §2.5): her replies reach the room by the way
// they reach Discord (runner, mouth, output review, scheduler, `PlatformSinks.get("web")`), and this
// sink hands each line to the hub of the account whose room it is, never to anyone else's.
//
// Each line is echoed on the bus as her own `platform.message.created` (author `ROOM_SELF`), as a
// platform echoes what she sent, so the chat record has her words; the host skips its own lines.
// Her files go as their names only; the bytes are fetched later through the room's download route,
// which checks again that this room may see them.

import type { RoomFile } from "@miyoria/contracts/api";
import { type ChatLogStore, PeopleStoreKey, StoreKey } from "@miyoria/store";
import {
  type AttachmentFile,
  AttachmentSourceKey,
  CharacterKey,
  type ContextKey,
  DEFAULT_CHARACTER,
  Events,
  IMAGE_TYPES,
  type IncomingMessage,
  type MessageRef,
  newId,
  type OutgoingMessage,
  type PlatformSink,
  ROOM_PLATFORM,
  ROOM_SELF,
  roomAccount,
  type SentMessage,
  toTimestamp,
} from "@miyoria/types";
import type { ApiState } from "../state.js";
import type { RoomHub } from "./channel.js";
import { roomBytes } from "./config.js";
import type { Room } from "./room.js";
import { lineHasVoice } from "./voice.js";

/** The host of her files on a line's echo: nobody fetches it, and it never resolves. */
export const HER_FILE_HOST = "files.room.invalid";

/** `typing` goes out at most this often per room. */
const TYPING_EVERY_MS = 1_000;

/** Her text without a platform's markup: no mentions, custom emoji as `:name:`. */
export function roomText(text: string): string {
  return text
    .replace(/<a?:([A-Za-z0-9_~-]{1,64}):\d{1,24}>/g, ":$1:")
    .replace(/<(?:@[!&]?|#)\d{1,24}>/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

function fileOf(file: AttachmentFile): RoomFile {
  const type = file.content_type.split(";")[0]?.trim().toLowerCase() ?? "";
  return {
    name: file.filename,
    size: file.size,
    kind: IMAGE_TYPES.includes(type) ? "image" : "file",
    download: true,
  };
}

export class WebSink implements PlatformSink {
  readonly platform = ROOM_PLATFORM;

  constructor(
    private readonly state: ApiState,
    private readonly room: Room,
  ) {}

  #hub(context: ContextKey): RoomHub {
    const account = roomAccount(context);
    if (account === null) throw new Error("not a room of hers");
    return this.room.channel.hub(account);
  }

  async send(
    context: ContextKey,
    message: OutgoingMessage,
    signal?: AbortSignal,
  ): Promise<SentMessage> {
    const hub = this.#hub(context);
    const files: RoomFile[] = [];
    const artifacts: string[] = [];
    const attachments: IncomingMessage["attachments"] = [];
    const wanted = message.attachments ?? [];
    if (wanted.length > 0) {
      const source = this.state.optional(AttachmentSourceKey);
      const max = roomBytes(this.room.config).file;
      for (const a of wanted) {
        if (source === undefined) break;
        // Checked once now (there, may be downloaded, seen here, its size); the bytes go later.
        const file = await source.open(a.artifact_id, context, {
          maxBytes: max,
          ...(signal ? { signal } : {}),
        });
        files.push(fileOf(file));
        artifacts.push(file.artifact_id);
        attachments.push({
          url: `https://${HER_FILE_HOST}/${file.artifact_id}`,
          filename: file.filename,
          content_type: file.content_type,
          id: file.artifact_id,
          size: file.size,
        });
      }
    }
    const id = newId();
    const now = this.state.now();
    const text = roomText(message.text);
    const turn = hub.lastTurn;
    hub.lines.set(id, {
      id,
      at: now,
      text,
      turn,
      emotion: hub.face,
      artifacts,
      files,
    });
    if (hub.turn !== null) hub.turn = { id: hub.turn.id, phase: "speaking" };
    hub.push({
      kind: "line",
      id,
      at: toTimestamp(now),
      turn,
      text,
      files,
      voice: lineHasVoice(this.room, text),
    });
    const echo: IncomingMessage = {
      id: { context, id },
      author: {
        account: ROOM_SELF,
        display_name: this.state.optional(CharacterKey)?.name ?? DEFAULT_CHARACTER.name,
        is_bot: true,
      },
      text,
      mentions_self: false,
      reply_to_self: false,
      attachments,
      ts: toTimestamp(now),
      ...(message.reply_to ? { reply_to: message.reply_to } : {}),
    };
    await this.#record(echo, turn);
    this.state.ctx.publish(Events.PlatformMessageCreated, echo, turn === null ? {} : { turn });
    return { context, id };
  }

  /** Her line in the chat log now, with its turn (the chat record skips it later: same key). */
  async #record(echo: IncomingMessage, turn: string | null): Promise<void> {
    const chat: ChatLogStore | undefined = this.state.optional(StoreKey)?.chat;
    if (chat === undefined) return;
    try {
      await chat.message(echo, { self: true, source: "api", turn });
    } catch (error) {
      this.state.ctx.log.warn({ error: String(error) }, "room: cannot keep her line");
    }
  }

  async react(message: MessageRef, emoji: string): Promise<void> {
    const account = roomAccount(message.context);
    if (account === null) return;
    this.room.channel.hub(account).push({ kind: "reaction", to: message.id, emoji });
  }

  async typing(context: ContextKey): Promise<void> {
    const hub = this.#hub(context);
    const now = this.state.now();
    if (now - hub.lastTypingAt < TYPING_EVERY_MS) return;
    hub.lastTypingAt = now;
    hub.tell({ kind: "typing" });
  }

  attachmentLimit(_context: ContextKey): number | null {
    return roomBytes(this.room.config).file;
  }

  async describe(context: ContextKey): Promise<string | null> {
    const account = roomAccount(context);
    if (account === null) return null;
    const name =
      this.state.auth.sessions.nameOf(account) ??
      (await this.state.optional(PeopleStoreKey)?.personByAccount(account))?.display_name ??
      account.id;
    return `她的房間 · ${name}`;
  }

  mention(): string | null {
    return null;
  }
}
