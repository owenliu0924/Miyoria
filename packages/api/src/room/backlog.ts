// The room's record (docs/design/her-room.md §3.5): the chat lines of `web:dm:<person>`, a page at a
// time, oldest first, and her bond's marks after the turn that moved it. A mark is a direction and
// her quote (screened: nobody else named, passed by moderation; else no quote), never a number, and
// a proposal the caps took whole (`delta = 0`) is not a mark: the bond did not move.
//
// What a page shows becomes known to the account's hub: her files can then be downloaded, and their
// own lines left out of her memory, from the page that showed them.

import type { RoomBacklog, RoomEntry, RoomFile } from "@miyoria/contracts/api";
import { type ChatPageLine, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type HeartDayChange,
  HeartKey,
  IMAGE_TYPES,
  type IncomingMessage,
  imageType,
  roomContext,
} from "@miyoria/types";
import { type MemberContext, namesFor, shown } from "../member.js";
import type { ApiState } from "../state.js";
import type { RoomHub } from "./channel.js";
import type { Room } from "./room.js";
import { HER_FILE_HOST } from "./sink.js";
import { roomWho } from "./state.js";

/** A bond change as a mark: moved by her `<feel>`, on the bond, and really moved. */
export function isBondMark(change: Pick<HeartDayChange, "cause" | "field" | "delta">): boolean {
  return change.cause === "feel" && change.field === "bond" && change.delta !== 0;
}

/** A mark's id, the same in the stream and in the backlog. */
export function markId(turn: string, at: string): string {
  return `m-${turn}-${Date.parse(at)}`;
}

/** Her quote as a member may read it, `null` when it cannot be shown. */
export async function markQuote(
  state: ApiState,
  member: MemberContext,
  quote: string,
): Promise<string | null> {
  if (quote.trim() === "") return null;
  const names = await namesFor(state, member);
  return shown(state, quote, names);
}

/** Her artifact id behind a file of her echo. */
function herArtifact(a: IncomingMessage["attachments"][number]): string | null {
  try {
    const url = new URL(a.url);
    if (url.hostname !== HER_FILE_HOST) return null;
  } catch {
    return null;
  }
  return a.id ?? null;
}

function filesOf(msg: IncomingMessage, hers: boolean): RoomFile[] {
  return msg.attachments.map((a) => {
    const type = (a.content_type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const image = hers ? IMAGE_TYPES.includes(type) : imageType(a) !== null;
    return {
      name: a.filename,
      size: typeof a.size === "number" ? Math.round(a.size) : null,
      kind: image ? "image" : "file",
      download: hers,
    };
  });
}

/** Tells the hub what this page showed. */
function remember(hub: RoomHub, line: ChatPageLine): void {
  const id = line.message.id.id;
  if (!line.self) {
    hub.own.set(id, true);
    return;
  }
  if (hub.lines.has(id)) return;
  hub.lines.set(id, {
    id,
    at: Date.parse(line.at),
    text: line.message.text,
    turn: line.turn,
    emotion: null,
    artifacts: line.message.attachments.map(herArtifact).filter((a): a is string => a !== null),
    files: filesOf(line.message, true),
  });
}

/** `GET /api/member/room/backlog?before=`. */
export async function backlog(
  state: ApiState,
  room: Room,
  account: AccountRef,
  before: string | undefined,
): Promise<RoomBacklog> {
  const chat = state.optional(StoreKey)?.chat;
  if (chat === undefined) return { entries: [], older: null };
  const page = await chat.page(roomContext(account), {
    before: before ?? null,
    limit: room.config.backlog_page,
  });
  const lines = [...page.lines].reverse();
  const hub = room.channel.hub(account);
  for (const line of lines) remember(hub, line);
  const marks = await marksOf(state, account, lines, before === undefined);
  const entries: RoomEntry[] = [];
  for (const [i, line] of lines.entries()) {
    entries.push({
      type: "line",
      id: line.message.id.id,
      at: line.at,
      who: line.self ? "her" : "you",
      text: line.message.text,
      files: filesOf(line.message, line.self),
    });
    const turn = line.self ? line.turn : null;
    // After the last line of hers of that turn on this page.
    const next = lines[i + 1];
    if (turn === null || (next?.self === true && next.turn === turn)) continue;
    for (const mark of marks.get(turn) ?? []) entries.push(mark);
  }
  return { entries, older: page.older };
}

/** Her bond's marks of the turns on this page, by turn. */
async function marksOf(
  state: ApiState,
  account: AccountRef,
  lines: readonly ChatPageLine[],
  newest: boolean,
): Promise<Map<string, RoomEntry[]>> {
  const out = new Map<string, RoomEntry[]>();
  const turns = new Set(lines.filter((l) => l.self && l.turn !== null).map((l) => l.turn));
  const heart = state.optional(HeartKey);
  if (turns.size === 0 || heart?.day === undefined) return out;
  const who = await roomWho(state, account);
  const person = who.member.person?.id ?? null;
  if (person === null || who.member.hidden || who.blocked) return out;
  const first = Date.parse(lines[0]?.at ?? "");
  const last = Date.parse(lines.at(-1)?.at ?? "");
  // The feel of a turn is applied when its run ends, a little after its last line.
  const since = first - 60_000;
  const until = newest ? state.now() + 1 : last + 10 * 60_000;
  const day = heart.day(person, since, until);
  for (const change of day?.changes ?? []) {
    const turn = change.turn ?? null;
    if (turn === null || !turns.has(turn) || !isBondMark(change)) continue;
    const list = out.get(turn) ?? [];
    list.push({
      type: "mark",
      id: markId(turn, change.at),
      at: change.at,
      sign: change.delta > 0 ? "plus" : "minus",
      quote: await markQuote(state, who.member, change.quote),
    });
    out.set(turn, list);
  }
  return out;
}
