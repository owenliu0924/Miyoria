// What the room says of her and of the room itself (docs/design/her-room.md §3.6, §4): one `Watch`
// per account, which `GET /api/member/room` and the stream's `state` both go through, so the two
// never say different things.
//
// Nothing here is new information about her: the status follows `publicStatus` (singing, a game,
// live, in voice, but never which channel), her mood is one word of an emotion that is about nobody
// or about this person (never her missing someone else), and her face is the one of her last line
// in this room.

import { PersonQuotaKey } from "@miyoria/brain/self";
import type { RoomDoing, RoomState } from "@miyoria/contracts/api";
import { BLOCKED_TAG, hasTag } from "@miyoria/heart/person";
import { SingerKey } from "@miyoria/sing";
import {
  type AccountRef,
  ActivityManagerKey,
  ActuatorExecutorKey,
  AffectStateKey,
  AuthorizerKey,
  isOwnerAccount,
  LiveFeedKey,
  MouthKey,
  PlacesKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { loadMemberOf, type MemberContext } from "../member.js";
import { gameName, isPlaying, songText } from "../public.js";
import { quotaKey } from "../quota.js";
import type { ApiState } from "../state.js";
import type { Watch } from "../watch.js";
import type { RoomHub } from "./channel.js";
import { roomBytes } from "./config.js";
import type { Room } from "./room.js";
import { CALM, MOOD_WORDS, ROOM_TEXT } from "./texts.js";
import { voiceState } from "./voice.js";

/** The node that lets someone have her answer (the "make her answer this" menu's). */
export const NODE_TALK = "chat.talk";

/** How strong an emotion must be to name her mood. */
const MOOD_FLOOR = 0.35;

/** Who is in the room, as far as the room needs it. */
export interface RoomWho {
  member: MemberContext;
  /** She ignores them (her `blocked`): they see a room that never answers, like a stranger's. */
  blocked: boolean;
  /** The room is open to them. */
  open: boolean;
}

/**
 * Whether she ignores `account`: the social module's word, or the `blocked` tag on their heart
 * row. The same as the agent's own check (`isBlocked`), so the room never answers someone she
 * would not answer on Discord.
 */
function blockedOf(state: ApiState, member: MemberContext): boolean {
  if (state.optional(SocialSignalsKey)?.attitude(member.account)?.blocked === true) return true;
  return member.row !== null && hasTag(member.row, BLOCKED_TAG);
}

/**
 * The room is open to someone who may talk to her (`chat.talk`) and is a member of one of the
 * servers she is in, as a Discord DM needs a common server. Without the services to tell, it is
 * closed.
 */
function openTo(state: ApiState, member: MemberContext): boolean {
  const authorizer = state.optional(AuthorizerKey);
  if (authorizer === undefined || !authorizer.allows(member.account, NODE_TALK)) return false;
  const places = state.optional(PlacesKey);
  if (places === undefined || member.person === null) return false;
  return places.spacesOf(member.person.id).length > 0;
}

export async function roomWho(state: ApiState, account: AccountRef): Promise<RoomWho> {
  const member = await loadMemberOf(state, account);
  return { member, blocked: blockedOf(state, member), open: openTo(state, member) };
}

/** Whether she is there to answer at all: the agent runs and the room's sink is registered. */
export function herHere(state: ApiState): boolean {
  return state.optional(MouthKey) !== undefined;
}

function doing(
  state: ApiState,
  hub: RoomHub | undefined,
): { doing: RoomDoing; detail: string | null } {
  const snapshot = state.optional(ActivityManagerKey)?.snapshot();
  const singer = state.optional(SingerKey);
  if ((!snapshot && !singer) || !herHere(state)) return { doing: "offline", detail: null };
  if (singer?.singing()) {
    return { doing: "singing", detail: songText(state, singer.playing()?.song?.title) };
  }
  const activity = snapshot?.activity;
  if (isPlaying(activity)) {
    return {
      doing: "playing",
      detail: activity?.type === "game" ? gameName(activity.target) : null,
    };
  }
  if (snapshot?.broadcast.type === "live") return { doing: "live", detail: null };
  if (snapshot?.presence.type === "in") return { doing: "in_voice", detail: null };
  if (activity?.type === "browse") return { doing: "browsing", detail: null };
  if (hub !== undefined && hub.tools.size > 0) return { doing: "working", detail: null };
  return { doing: "idle", detail: null };
}

function mood(state: ApiState, who: RoomWho, hub: RoomHub | undefined): RoomState["mood"] {
  const affect = state.optional(AffectStateKey);
  const face = hub?.face ?? null;
  if (affect === undefined) return face === null ? null : { word: CALM, face };
  const person = who.member.person?.id ?? null;
  // Her feelings about someone else (missing them, jealous of them) are not this person's to read.
  const top = affect
    .emotions(MOOD_FLOOR)
    .find((e) => e.person === null || (person !== null && e.person === person));
  return { word: (top && MOOD_WORDS[top.name]) ?? CALM, face };
}

function quota(state: ApiState, who: RoomWho): RoomState["quota"] {
  const q = state.optional(PersonQuotaKey);
  const account = who.member.account;
  if (q === undefined || isOwnerAccount(state.optional(AuthorizerKey), account)) {
    return { capped: null, until: null };
  }
  const at = q.limitAt(quotaKey(account, who.member.person?.id ?? null), state.now());
  return at === null
    ? { capped: null, until: null }
    : { capped: at.which, until: toTimestamp(at.until) };
}

/** `RoomState` for `account` now. */
export async function roomState(
  state: ApiState,
  room: Room,
  account: AccountRef,
): Promise<RoomState> {
  const who = await roomWho(state, account);
  return roomStateOf(state, room, who);
}

export function roomStateOf(state: ApiState, room: Room, who: RoomWho): RoomState {
  const hub = room.channel.existing(who.member.account);
  const bytes = roomBytes(room.config);
  const now = doing(state, hub);
  return {
    open: who.open,
    closed: who.open ? null : ROOM_TEXT.closed,
    // A blocked person is a stranger: her mood is not theirs to read either.
    mood: who.open && !who.blocked ? mood(state, who, hub) : null,
    doing: now.doing,
    detail: now.detail,
    watch: state.optional(LiveFeedKey)?.snapshot().video.on === true,
    paused: state.optional(ActuatorExecutorKey)?.paused === true,
    voice: voiceState(state, room, who.member.account),
    quota: who.blocked ? { capped: null, until: null } : quota(state, who),
    limits: {
      max_text_chars: room.config.max_text_chars,
      max_files: room.config.max_files,
      max_image_bytes: bytes.image,
      max_file_bytes: bytes.file,
    },
  };
}

/** The room's state for `account`, as a `Watch` (its key is theirs: nobody else shares it). */
export function roomStateWatch(state: ApiState, room: Room, account: AccountRef): Watch<RoomState> {
  return {
    key: `room:${account.platform}:${account.id}`,
    build: () => roomState(state, room, account),
  };
}
