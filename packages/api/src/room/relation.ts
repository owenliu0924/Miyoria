// The room's relation panel (docs/design/her-room.md §3.7): `/api/member/me`'s bond, line and
// memories, from the same functions, with the memories' ids. Forgetting one works it out again: the
// id must be among what this person may see now, so guessing an id deletes nothing else.

import type { RoomRelation } from "@miyoria/contracts/api";
import { MemoryEngineKey } from "@miyoria/memory/memory";
import { type AccountRef, AuthorizerKey, accountRefString } from "@miyoria/types";
import {
  bondView,
  cardView,
  loadMemberOf,
  type MemberContext,
  namesFor,
  shownMemoryRecords,
} from "../member.js";
import type { ApiState } from "../state.js";
import type { Room } from "./room.js";
import { roomTooMany } from "./send.js";

/** The node `/me memory forget` and the member page's forget need. */
const NODE_FORGET = "memory.self.forget";

async function visible(state: ApiState, member: MemberContext) {
  const names = member.hidden ? null : await namesFor(state, member);
  return { names, memories: await shownMemoryRecords(state, member, names) };
}

/** `GET /api/member/room/relation`. */
export async function relation(state: ApiState, account: AccountRef): Promise<RoomRelation> {
  const member = await loadMemberOf(state, account);
  if (member.hidden) return { bond: null, feeling: null, memories: [] };
  const { names, memories } = await visible(state, member);
  return {
    bond: bondView(member),
    feeling: cardView(state, member, names).public_feeling,
    memories: memories.map(({ record, text }) => ({
      id: record.id,
      text,
      kind: record.kind,
      date: record.created_at.slice(0, 10),
    })),
  };
}

/** `POST /api/member/room/memories/{id}/forget`: only one they can see now. */
export async function forgetMemory(
  state: ApiState,
  room: Room,
  account: AccountRef,
  id: string,
): Promise<{ forgotten: boolean }> {
  const actor = accountRefString(account);
  const wait = room.forgets.hit(actor, state.now());
  if (wait !== null) throw roomTooMany(wait);
  const member = await loadMemberOf(state, account);
  if (member.hidden || state.optional(AuthorizerKey)?.allows(account, NODE_FORGET) !== true) {
    return { forgotten: false };
  }
  const engine = state.optional(MemoryEngineKey);
  if (engine === undefined) return { forgotten: false };
  const { memories } = await visible(state, member);
  if (!memories.some(({ record }) => record.id === id)) return { forgotten: false };
  const forgotten = await engine.forgetRecord(id);
  await state.auditAs(actor, "member.forget.one", actor, { memory: id }, forgotten);
  return { forgotten };
}
