// What a member may do with the lines and memories of their own room (docs/design/her-room.md §3.7):
// "do not remember this" only for a line of theirs that the room gave them and the chat log still
// has; forget one memory only when it is among what they may see now.

import { MemoryEngineKey } from "@miyoria/memory/memory";
import { StoreKey } from "@miyoria/store";
import { type AccountRef, AuthorizerKey, MessageActionsKey, roomContext } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { excludeLine } from "../src/room/files.js";
import { forgetMemory, relation } from "../src/room/relation.js";
import { ALICE, BOB, makeRig, refusal } from "./room-rig.js";

const MINE = "01JF0000000000000000000001";
const HERS = "01JF0000000000000000000002";
const BOBS = "01JF0000000000000000000003";
const GONE = "01JF0000000000000000000004";
const FORGOTTEN = "01JF0000000000000000000005";

function excludeRig() {
  const rig = makeRig();
  const events = new Map<string, string[]>([
    [`msg:web:${MINE}`, ["e1"]],
    [`msg:web:${HERS}`, ["e2"]],
    [`msg:web:${BOBS}`, ["e3"]],
    [`msg:web:${FORGOTTEN}`, ["e5", "e6"]],
  ]);
  const redacted = new Set(["e5", "e6"]);
  rig.services.set(StoreKey, {
    chat: {
      eventsOf: async (key: string) => events.get(key) ?? [],
      redacted: async (ids: string[]) => new Set(ids.filter((id) => redacted.has(id))),
    },
  });
  const asked: unknown[] = [];
  rig.services.set(MessageActionsKey, {
    dontRemember: async (request: unknown) => {
      asked.push(request);
      return { ok: true };
    },
  });
  const alice = rig.room.channel.hub(ALICE);
  for (const id of [MINE, GONE, FORGOTTEN]) alice.own.set(id, true);
  alice.lines.set(HERS, {
    id: HERS,
    at: rig.clock.t,
    text: "她的話",
    turn: null,
    emotion: null,
    artifacts: [],
    files: [],
  });
  rig.room.channel.hub(BOB).own.set(BOBS, true);
  return { ...rig, asked };
}

describe("leaving a line out of her memory", () => {
  it("takes their own line of this room only", async () => {
    const r = excludeRig();
    const exclude = (id: string, account: AccountRef = ALICE) =>
      excludeLine(r.state as never, r.room, account, id);
    // Her line, Bob's line, a line the log no longer has, one already left out: nothing asked.
    expect(await exclude(HERS)).toEqual({ excluded: false });
    expect(await exclude(BOBS)).toEqual({ excluded: false });
    expect(await exclude(GONE)).toEqual({ excluded: false });
    expect(await exclude(FORGOTTEN)).toEqual({ excluded: false });
    // Someone with no room at all.
    expect(await exclude(MINE, { platform: "discord", id: "3" })).toEqual({ excluded: false });
    expect(r.asked).toEqual([]);
    expect(await exclude(MINE)).toEqual({ excluded: true });
    expect(r.asked).toEqual([
      { message: { context: roomContext(ALICE), id: MINE }, author: ALICE, requested_by: ALICE },
    ]);
    // Done once: the hub no longer offers it.
    expect(await exclude(MINE)).toEqual({ excluded: false });
    expect(r.asked).toHaveLength(1);
    // Bob may leave out his own.
    expect(await exclude(BOBS, BOB)).toEqual({ excluded: true });
    expect(r.asked[1]).toEqual({
      message: { context: roomContext(BOB), id: BOBS },
      author: BOB,
      requested_by: BOB,
    });
  });

  it("is limited to 30 an hour", async () => {
    const r = excludeRig();
    for (let i = 0; i < 30; i++) await excludeLine(r.state as never, r.room, ALICE, HERS);
    const error = await refusal(() => excludeLine(r.state as never, r.room, ALICE, MINE));
    expect(error.status).toBe(429);
    expect(r.asked).toEqual([]);
  });
});

// ---- forgetting one memory ------------------------------------------------------------------

const memory = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "fact",
  scope: { type: "person", person: "p-1" },
  content: "愛吃布丁",
  subjects: ["p-1"],
  created_at: "2026-11-20T04:00:00.000Z",
  superseded_by: null,
  source: null,
  origin: "said",
  ...over,
});

function forgetRig() {
  const rig = makeRig();
  const records = [
    memory("m-shown"),
    memory("m-note", { kind: "self_note" }),
    memory("m-other", { content: "Bobby 也愛吃布丁" }),
    memory("m-bob-dm", { scope: { type: "dm", account: BOB } }),
    memory("m-told", { source: { account: BOB } }),
    memory("m-pref", { kind: "preference" }),
  ];
  const forgot: string[] = [];
  rig.services.set(MemoryEngineKey, {
    personOf: async (a: AccountRef) => `p-${a.id}`,
    memoriesOf: async (person: string) => (person === "p-1" ? records : []),
    derivedFrom: async () => ({ records: [] }),
    forgetRecord: async (id: string) => {
      forgot.push(id);
      return true;
    },
  });
  return { ...rig, forgot };
}

describe("forgetting one memory", () => {
  it("lists with ids exactly what may be forgotten", async () => {
    const r = forgetRig();
    const view = await relation(r.state as never, ALICE);
    expect(view.memories).toEqual([
      { id: "m-shown", text: "愛吃布丁", kind: "fact", date: "2026-11-20" },
    ]);
  });

  it("forgets only an id among what this person sees now", async () => {
    const r = forgetRig();
    const forget = (id: string, account: AccountRef = ALICE) =>
      forgetMemory(r.state as never, r.room, account, id);
    for (const id of ["m-note", "m-other", "m-bob-dm", "m-told", "m-pref", "nope"]) {
      expect(await forget(id), id).toEqual({ forgotten: false });
    }
    // Bob sees none of Alice's.
    expect(await forget("m-shown", BOB)).toEqual({ forgotten: false });
    expect(r.forgot).toEqual([]);
    expect(await forget("m-shown")).toEqual({ forgotten: true });
    expect(r.forgot).toEqual(["m-shown"]);
  });

  it("forgets nothing for someone blocked or without the node", async () => {
    const r = forgetRig();
    r.blocked.add(ALICE.id);
    expect(await forgetMemory(r.state as never, r.room, ALICE, "m-shown")).toEqual({
      forgotten: false,
    });
    r.blocked.clear();
    r.services.set(AuthorizerKey, {
      allows: (_a: unknown, node: string) => node !== "memory.self.forget",
    });
    expect(await forgetMemory(r.state as never, r.room, ALICE, "m-shown")).toEqual({
      forgotten: false,
    });
    expect(r.forgot).toEqual([]);
  });
});
