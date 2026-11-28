// Her room's record on the chat log (docs/design/her-room.md §3.5, §6): a session's text messages a
// page at a time, newest first, without the redacted ones; "forget me" empties the room, her side
// of it included.

import {
  type ContextKey,
  type IncomingMessage,
  ROOM_SELF,
  roomContext,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_TYPES_SQL, SqliteStore } from "../src/index.js";
import { openTestDb } from "../src/testing.js";

const T0 = Date.UTC(2026, 10, 1, 12);
const OWEN = { account: { platform: "discord", id: "100" }, display_name: "Owen", is_bot: false };
const AMY = { account: { platform: "discord", id: "200" }, display_name: "Amy", is_bot: false };
const HER = { account: ROOM_SELF, display_name: "Miyori", is_bot: true };
const ROOM = roomContext(OWEN.account);
const DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
const CURSOR = /^[A-Za-z0-9_-]{1,64}$/;

let now = T0;
const clock = { now: () => now };
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  now = T0;
});

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", { clock });
  stores.push(store);
  return store;
}

function message(
  context: ContextKey,
  id: string,
  text: string,
  secs: number,
  author = OWEN,
): IncomingMessage {
  return {
    id: { context, id },
    author,
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(T0 + secs * 1000),
  };
}

/** A conversation in Owen's room: his, hers, his, two of hers at the same time. */
function talk(store: SqliteStore) {
  const said = (id: string, text: string, secs: number, self: boolean, turn?: string) =>
    store.chat.message(message(ROOM, id, text, secs, self ? HER : OWEN), {
      self,
      source: "api.room",
      ...(turn ? { turn } : {}),
    });
  return [
    said("m1", "嗨", 1, false),
    said("m2", "你來了", 2, true, "t1"),
    said("m3", "今天好累", 3, false),
    said("m4", "辛苦了", 4, true, "t2"),
    said("m5", "要不要休息一下", 4, true, "t2"),
  ];
}

describe("a page of the room's record", () => {
  it("is newest first, a page at a time, ties by the log's order", async () => {
    const store = await open();
    const lines = talk(store);
    const first = store.chat.page(ROOM, { limit: 2 });
    expect(first.lines.map((l) => l.message.id.id)).toEqual(["m5", "m4"]);
    expect(first.older).toMatch(CURSOR);
    expect(first.lines[0]).toEqual({
      event_id: lines[4]?.id,
      at: toTimestamp(T0 + 4000),
      seq: lines[4]?.seq,
      turn: "t2",
      self: true,
      message: message(ROOM, "m5", "要不要休息一下", 4, HER),
    });
    const second = store.chat.page(ROOM, { before: first.older, limit: 2 });
    expect(second.lines.map((l) => [l.message.id.id, l.self, l.turn])).toEqual([
      ["m3", false, null],
      ["m2", true, "t1"],
    ]);
    expect(second.lines[0]?.message.author).toEqual(OWEN);
    const last = store.chat.page(ROOM, { before: second.older, limit: 2 });
    expect(last.lines.map((l) => l.message.id.id)).toEqual(["m1"]);
    expect(last.older).toBeNull();
    // A page that ends exactly at the oldest line has no older one either.
    expect(store.chat.page(ROOM, { limit: 5 }).older).toBeNull();
    expect(store.chat.page(ROOM, { limit: 4 }).older).toMatch(CURSOR);
    // A cursor between two lines of the same time.
    const one = store.chat.page(ROOM, { limit: 1 });
    expect(one.lines.map((l) => l.message.id.id)).toEqual(["m5"]);
    const next = store.chat.page(ROOM, { before: one.older, limit: 1 });
    expect(next.lines.map((l) => l.message.id.id)).toEqual(["m4"]);
    // The payload's own `self` mark is the line's, not the message's.
    expect(first.lines[0]?.message).not.toHaveProperty("self");
  });

  it("leaves out redacted lines and other places' lines", async () => {
    const store = await open();
    talk(store);
    store.chat.message(message(DM, "d1", "Discord 私訊", 5), { self: false, source: "bot" });
    store.chat.redactMessage({ context: ROOM, id: "m3" }, "do not remember", "recorder");
    const page = store.chat.page(ROOM, { limit: 10 });
    expect(page.lines.map((l) => l.message.id.id)).toEqual(["m5", "m4", "m2", "m1"]);
    expect(page.older).toBeNull();
    expect(store.chat.page(DM, { limit: 10 }).lines.map((l) => l.message.text)).toEqual([
      "Discord 私訊",
    ]);
  });

  it("is empty for a room nobody has written in, a zero limit, or a cursor it did not give", async () => {
    const store = await open();
    talk(store);
    expect(store.chat.page(roomContext(AMY.account), { limit: 10 })).toEqual({
      lines: [],
      older: null,
    });
    expect(store.chat.page(ROOM, { limit: 0 })).toEqual({ lines: [], older: null });
    for (const before of ["not a cursor!", "abc", Buffer.from("1.x").toString("base64url")]) {
      expect(store.chat.page(ROOM, { before, limit: 10 })).toEqual({ lines: [], older: null });
    }
    // No cursor reads from the newest.
    expect(store.chat.page(ROOM, { before: null, limit: 1 }).lines).toHaveLength(1);
  });

  it("is read over the session index of core migration 3", () => {
    const t = openTestDb({ identity: true });
    try {
      const plan = t.db
        .all(
          "EXPLAIN QUERY PLAN SELECT id FROM events WHERE session = 's' AND " +
            `${CHAT_TYPES_SQL} AND type = 'platform.message.created' AND redacted_at IS NULL ` +
            "AND (at < 5 OR (at = 5 AND seq < 3)) ORDER BY at DESC, seq DESC LIMIT 51",
          {},
        )
        .map((r) => String(r.detail))
        .join(" | ");
      expect(plan).toMatch(/USING INDEX events_chat_session_idx/);
    } finally {
      t.close();
    }
  });
});

describe("forget me, in the room", () => {
  it("takes her lines in their room too, and nothing of hers elsewhere", async () => {
    const store = await open();
    const room = talk(store);
    store.chat.message(message(DM, "d1", "他在 Discord 說的", 5), { self: false, source: "bot" });
    const elsewhere = store.chat.message(message(DM, "d2", "她在 Discord 說的", 6, HER), {
      self: true,
      source: "bot",
    });
    const amyRoom = roomContext(AMY.account);
    store.chat.message(message(amyRoom, "a1", "Amy 的房間", 7, AMY), {
      self: false,
      source: "api.room",
    });
    const amyHers = store.chat.message(message(amyRoom, "a2", "嗨 Amy", 8, HER), {
      self: true,
      source: "api.room",
    });
    const owen = store.persons.personOf(OWEN.account)?.id ?? "";
    expect(room[1]?.session).toBe(`web:dm:${owen}`);
    // His three lines (two in the room, one in the DM) and her three in the room.
    expect(store.chat.forgetPerson(owen, "forget me", "memory")).toBe(6);
    expect(store.chat.page(ROOM, { limit: 10 })).toEqual({ lines: [], older: null });
    for (const e of room)
      expect(store.events.get(e?.id ?? "")?.envelope.data).toEqual({
        redacted: true,
      });
    for (const e of [elsewhere, amyHers]) {
      expect(store.events.get(e?.id ?? "")?.envelope.redacted_at).toBeNull();
    }
    expect(store.chat.page(amyRoom, { limit: 10 }).lines).toHaveLength(2);
    expect(store.chat.forgetPerson(owen, "again", "memory")).toBe(0);
  });
});
