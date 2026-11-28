// Her room (docs/design/her-room.md): one logged-in member alone with her. A DM on the `web`
// platform: the session's account is the author, and nothing here takes anyone else's id. Her bond
// stays words and the ring (`MemberBondSchema`); a change in it is a direction and her quote, never
// a number.

import { eventIterator } from "@orpc/contract";
import { z } from "zod";
import { MemberBondSchema } from "./member.js";
import { route } from "./route.js";

/** A line's id: the ULID the room gave it. */
export const ROOM_LINE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** An upload's id: 128 random bits. */
export const ROOM_UPLOAD_ID = /^up_[A-Za-z0-9_-]{22}$/;
/** A tab's id for one send, so the tab that sent a line knows it again. */
export const ROOM_CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** An opaque page cursor of the backlog. */
export const ROOM_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;
/** A memory's id as the relation gives it. */
export const ROOM_MEMORY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `POST` a file here as the raw body; its name in `X-Miyoria-Filename` (URI-encoded). */
export const ROOM_UPLOAD_PATH = "/api/member/room/uploads";
export const roomVoicePath = (line: string) => `/api/member/room/voice/${encodeURIComponent(line)}`;
export const roomFilePath = (line: string, n: number) =>
  `/api/member/room/files/${encodeURIComponent(line)}/${n}`;

/** Her emotion name, as her avatar's `[emotion]` keys are written (`happy`, `shy`). */
export const RoomFaceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,23}$/)
  .meta({ id: "ApiRoomFace" });

/** What she is doing, from the public status and this room. */
export const RoomDoingSchema = z
  .enum(["offline", "idle", "singing", "playing", "live", "in_voice", "browsing", "working"])
  .meta({ id: "ApiRoomDoing" });
export type RoomDoing = z.output<typeof RoomDoingSchema>;

export const RoomStateSchema = z
  .object({
    /** The room is open to them. */
    open: z.boolean(),
    /** Why not, in zh-TW, when it is closed. */
    closed: z.string().nullable(),
    /** One word of how she feels (`得意`) and her face now; `null`: nothing to say. */
    mood: z.object({ word: z.string(), face: RoomFaceSchema.nullable() }).nullable(),
    doing: RoomDoingSchema,
    /** The song (screened) while `singing`, the game id while `playing`; else `null`. */
    detail: z.string().nullable(),
    /** She is on `/watch` now. */
    watch: z.boolean(),
    /** The emergency stop: she hears and keeps, and answers nothing. */
    paused: z.boolean(),
    /** Her voice can be played here; `reason` in zh-TW when it cannot. */
    voice: z.object({ available: z.boolean(), reason: z.string().nullable() }),
    /** Their AI quota: capped until when (ISO), or `null`. Her own fixed line says it too. */
    quota: z.object({ capped: z.enum(["hour", "day"]).nullable(), until: z.string().nullable() }),
    limits: z.object({
      max_text_chars: z.number().int(),
      max_files: z.number().int(),
      max_image_bytes: z.number().int(),
      max_file_bytes: z.number().int(),
    }),
  })
  .meta({ id: "ApiRoomState" });
export type RoomState = z.output<typeof RoomStateSchema>;

/** A file on a line: theirs (never served back) or hers (`download`: `roomFilePath`). */
export const RoomFileSchema = z
  .object({
    name: z.string(),
    size: z.number().int().nullable(),
    kind: z.enum(["image", "file"]),
    download: z.boolean(),
  })
  .meta({ id: "ApiRoomFile" });
export type RoomFile = z.output<typeof RoomFileSchema>;

export const RoomEntrySchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("line"),
      id: z.string(),
      /** ISO 8601 UTC. */
      at: z.string(),
      who: z.enum(["you", "her"]),
      text: z.string(),
      files: z.array(RoomFileSchema),
    }),
    /** Her bond moved in this conversation: after her line of that turn. */
    z.object({
      type: z.literal("mark"),
      id: z.string(),
      at: z.string(),
      sign: z.enum(["plus", "minus"]),
      /** Her reason as she wrote it, screened; `null` when it could not be shown. */
      quote: z.string().nullable(),
    }),
  ])
  .meta({ id: "ApiRoomEntry" });
export type RoomEntry = z.output<typeof RoomEntrySchema>;

/** `GET /api/member/room/backlog`: oldest first; `older` reads the page before it. */
export const RoomBacklogSchema = z
  .object({ entries: z.array(RoomEntrySchema), older: z.string().nullable() })
  .meta({ id: "ApiRoomBacklog" });
export type RoomBacklog = z.output<typeof RoomBacklogSchema>;

export const RoomMemorySchema = z
  .object({ id: z.string(), text: z.string(), kind: z.string(), date: z.string() })
  .meta({ id: "ApiRoomMemory" });
export type RoomMemory = z.output<typeof RoomMemorySchema>;

/** `GET /api/member/room/relation`: `/api/member/me`'s bond, line and memories, with ids. */
export const RoomRelationSchema = z
  .object({
    /** `null` for someone she does not know (or will not say). */
    bond: MemberBondSchema.nullable(),
    /** The line she wrote for them (`public_feeling`), screened. */
    feeling: z.string().nullable(),
    /** At most 30, newest first. */
    memories: z.array(RoomMemorySchema),
  })
  .meta({ id: "ApiRoomRelation" });
export type RoomRelation = z.output<typeof RoomRelationSchema>;

export const RoomSendRequestSchema = z
  .strictObject({
    /** Trimmed; at most `limits.max_text_chars` (checked by the handler). May be empty with files. */
    text: z.string().max(8000),
    uploads: z.array(z.string().regex(ROOM_UPLOAD_ID)).max(8).default([]),
    client_id: z.string().regex(ROOM_CLIENT_ID),
  })
  .meta({ id: "ApiRoomSendRequest" });
export type RoomSendRequest = z.input<typeof RoomSendRequestSchema>;

/**
 * `heard`: `ok`; `held` (the input defence slowed them down: she reads it, it starts nothing);
 * `ignored` (it does not reach her). `notice`: the fixed zh-TW line for the last two.
 */
export const RoomSendResultSchema = z
  .object({
    id: z.string(),
    at: z.string(),
    heard: z.enum(["ok", "held", "ignored"]),
    notice: z.string().nullable(),
  })
  .meta({ id: "ApiRoomSendResult" });
export type RoomSendResult = z.output<typeof RoomSendResultSchema>;

/** Answer of `POST /api/member/room/uploads` (not on the table: a raw body). */
export const RoomUploadSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    size: z.number().int(),
    kind: z.enum(["image", "file"]),
    /** Unsent, it is dropped then. */
    expires_at: z.string(),
  })
  .meta({ id: "ApiRoomUpload" });
export type RoomUpload = z.output<typeof RoomUploadSchema>;

const Confirm = z.strictObject({ confirm: z.literal(true) });

/** One event of the room's stream. Ids are `<run>-<n>`; a reconnect sends `Last-Event-ID`. */
export const RoomEventSchema = z
  .union([
    /** First: where things are. `turn`: a run of hers going on in this room. */
    z.object({
      kind: z.literal("hello"),
      state: RoomStateSchema,
      turn: z.object({ id: z.string(), phase: z.enum(["thinking", "speaking"]) }).nullable(),
    }),
    /** Their line, as any of their tabs sent it (`client_id` of the tab, `null` from elsewhere). */
    z.object({
      kind: z.literal("you"),
      id: z.string(),
      at: z.string(),
      text: z.string(),
      files: z.array(RoomFileSchema),
      client_id: z.string().nullable(),
    }),
    z.object({ kind: z.literal("thinking"), turn: z.string() }),
    z.object({ kind: z.literal("typing") }),
    /** A tool of hers in this room: a few words of what, started or ended. */
    z.object({
      kind: z.literal("step"),
      turn: z.string(),
      label: z.string(),
      state: z.enum(["started", "ended"]),
    }),
    /** One line of hers: one step of the reply. `voice`: `roomVoicePath(id)` can be played. */
    z.object({
      kind: z.literal("line"),
      id: z.string(),
      at: z.string(),
      turn: z.string().nullable(),
      text: z.string(),
      files: z.array(RoomFileSchema),
      voice: z.boolean(),
    }),
    z.object({ kind: z.literal("face"), turn: z.string(), face: RoomFaceSchema }),
    /** She answered one of their lines with only an emoji. */
    z.object({ kind: z.literal("reaction"), to: z.string(), emoji: z.string() }),
    z.object({ kind: z.literal("done"), turn: z.string() }),
    z.object({
      kind: z.literal("bond"),
      id: z.string(),
      at: z.string(),
      turn: z.string(),
      sign: z.enum(["plus", "minus"]),
      quote: z.string().nullable(),
    }),
    z.object({ kind: z.literal("state"), state: RoomStateSchema }),
    /** The events since `Last-Event-ID` are gone: read the backlog again. */
    z.object({ kind: z.literal("reset") }),
    z.object({ kind: z.literal("ping") }),
  ])
  .meta({ id: "ApiRoomEvent" });
export type RoomEvent = z.output<typeof RoomEventSchema>;

/** The most a JSON body of the room may be (§3.1): a line of 2000 characters fits many times. */
export const ROOM_BODY_BYTES = 16 * 1024;

const member = (limited: boolean) =>
  route.meta({
    audience: "member",
    permission: null,
    maxBody: { bytes: ROOM_BODY_BYTES, refusal: "這段太長了,分幾次說" },
    ...(limited ? { limited: true } : {}),
  });

export const room = {
  state: member(true).route({ method: "GET", path: "/api/member/room" }).output(RoomStateSchema),
  stream: member(false)
    .route({ method: "GET", path: "/api/member/room/stream" })
    .output(eventIterator(RoomEventSchema)),
  /** `403` closed, `429` too many, `409` an upload gone, `413` too long, `503` she is not there. */
  send: member(true)
    .route({ method: "POST", path: "/api/member/room/messages" })
    .input(z.object({ body: RoomSendRequestSchema }))
    .output(RoomSendResultSchema),
  backlog: member(true)
    .route({ method: "GET", path: "/api/member/room/backlog" })
    .input(z.object({ query: z.object({ before: z.string().regex(ROOM_CURSOR).optional() }) }))
    .output(RoomBacklogSchema),
  relation: member(true)
    .route({ method: "GET", path: "/api/member/room/relation" })
    .output(RoomRelationSchema),
  /** Not theirs to see, or gone: `{ forgotten: false }` (a blocked person's too). */
  forgetMemory: member(true)
    .route({ method: "POST", path: "/api/member/room/memories/{id}/forget" })
    .input(z.object({ params: z.object({ id: z.string().regex(ROOM_MEMORY_ID) }), body: Confirm }))
    .output(z.object({ forgotten: z.boolean() }).meta({ id: "ApiRoomForgotten" })),
  /** "不要記住這句", their own line only. */
  excludeLine: member(true)
    .route({ method: "POST", path: "/api/member/room/lines/{id}/exclude" })
    .input(z.object({ params: z.object({ id: z.string().regex(ROOM_LINE_ID) }), body: Confirm }))
    .output(z.object({ excluded: z.boolean() }).meta({ id: "ApiRoomExcluded" })),
};
