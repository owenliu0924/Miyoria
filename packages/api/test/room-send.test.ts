// A member's line in her room (docs/design/her-room.md §3.3, §3.10): the refusals in their fixed
// words, a blocked person's line that goes nowhere, the chat log written before the bus hears it,
// the input defence asked once with the line's id, and the room's own rate.

import { StoreKey } from "@miyoria/store";
import {
  AuthorizerKey,
  type IncomingMessage,
  ModerationKey,
  MouthKey,
  PlacesKey,
  PlatformSinks,
  PlatformSinksKey,
  roomContext,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { Outgoing } from "../src/room/channel.js";
import { sendLine } from "../src/room/send.js";
import { ROOM_TEXT } from "../src/room/texts.js";
import { ALICE, BOB, makeRig, refusal, sessionOf } from "./room-rig.js";

type Verdict = { action: string } | null;

function sendRig(config: Record<string, unknown> = {}) {
  const rig = makeRig(config);
  const logged: IncomingMessage[] = [];
  rig.services.set(StoreKey, {
    plugin: () => ({}),
    chat: {
      message: async (msg: IncomingMessage, opts: unknown) => {
        rig.order.push(`log:${JSON.stringify(opts)}`);
        logged.push(msg);
      },
    },
  });
  const asked: { id: string | null; author: unknown; context: unknown; source: string }[] = [];
  const verdict: { next: Verdict } = { next: null };
  rig.services.set(ModerationKey, {
    inspect: (input: { id: string | null; author: unknown; context: unknown; source: string }) => {
      asked.push(input);
      return verdict.next === null
        ? { action: "allow", flags: [], reasons: [], untrusted: true, mark: null }
        : { flags: [], reasons: ["x"], untrusted: true, mark: null, ...verdict.next };
    },
  });
  const heard: Outgoing[] = [];
  rig.room.channel.hub(ALICE).listen((out) => heard.push(out));
  const send = (text: string, uploads: string[] = [], account = ALICE) =>
    sendLine(rig.state as never, rig.room, sessionOf(account) as never, {
      text,
      uploads,
      client_id: "tab-0001",
    });
  return { ...rig, logged, asked, verdict, heard, send };
}

describe("sending a line", () => {
  it("is closed without chat.talk or a server in common", async () => {
    const r = sendRig();
    r.services.set(AuthorizerKey, { allows: (_a: unknown, node: string) => node !== "chat.talk" });
    let error = await refusal(() => r.send("hi"));
    expect([error.status, error.message]).toEqual([403, ROOM_TEXT.closed]);
    r.services.set(AuthorizerKey, {
      allows: (_a: unknown, node: string) => !node.startsWith("owner."),
    });
    r.services.set(PlacesKey, { spacesOf: () => [] });
    error = await refusal(() => r.send("hi"));
    expect([error.status, error.message]).toEqual([403, "她的房間現在沒有對你開放"]);
    r.services.delete(PlacesKey);
    expect((await refusal(() => r.send("hi"))).status).toBe(403);
    expect(r.published).toEqual([]);
    expect(r.heard).toEqual([]);
  });

  it("says she is not there without a mouth or the web sink", async () => {
    const r = sendRig();
    r.services.delete(MouthKey);
    let error = await refusal(() => r.send("hi"));
    expect([error.status, error.message]).toEqual([503, ROOM_TEXT.away]);
    r.services.set(MouthKey, {});
    r.services.set(PlatformSinksKey, new PlatformSinks());
    error = await refusal(() => r.send("hi"));
    expect([error.status, error.message]).toEqual([503, "她現在不在"]);
    expect(r.published).toEqual([]);
  });

  it("refuses too long, empty, and an upload that is not theirs", async () => {
    const r = sendRig({ max_text_chars: 5, max_files: 1 });
    let error = await refusal(() => r.send("一二三四五六"));
    expect([error.status, error.message]).toEqual([413, ROOM_TEXT.tooLong]);
    // Counted in characters, after trimming.
    expect((await r.send("  一二三四五  ")).heard).toBe("ok");
    error = await refusal(() => r.send("   "));
    expect([error.status, error.message]).toEqual([422, ROOM_TEXT.empty]);
    const bobs = r.room.uploads.put(BOB, "b.txt", undefined, new Uint8Array([1, 2, 3]));
    if (bobs === "full") throw new Error("full");
    error = await refusal(() => r.send("look", [bobs.id]));
    expect([error.status, error.message]).toEqual([409, ROOM_TEXT.uploadGone]);
    error = await refusal(() => r.send("look", [bobs.id, bobs.id.replace(/.$/, "x")]));
    expect(error.status).toBe(413);
    // Bob's upload is still his, untouched.
    expect(r.room.uploads.take(BOB, [bobs.id])).toHaveLength(1);
    expect(r.logged).toHaveLength(1);
  });

  it("shows a blocked person their line and tells nobody else", async () => {
    const r = sendRig();
    r.blocked.add(ALICE.id);
    const result = await r.send("你好");
    expect(result).toMatchObject({ heard: "ok", notice: null });
    expect(r.heard.map((o) => o.event)).toEqual([
      {
        kind: "you",
        id: result.id,
        at: result.at,
        text: "你好",
        files: [],
        client_id: "tab-0001",
      },
    ]);
    expect(r.published).toEqual([]);
    expect(r.logged).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it("writes the chat log before the bus hears the line, as theirs in their room", async () => {
    const r = sendRig();
    const up = r.room.uploads.put(ALICE, "note.txt", "text/plain", new Uint8Array([104, 105]));
    if (up === "full") throw new Error("full");
    const result = await r.send("  看這個 ", [up.id]);
    expect(result).toEqual({ id: result.id, at: result.at, heard: "ok", notice: null });
    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.order).toEqual([
      `log:${JSON.stringify({ self: false, source: "api" })}`,
      "publish:platform.message.created",
    ]);
    const msg = r.published[0]?.data as IncomingMessage;
    expect(r.logged[0]).toBe(msg);
    expect(msg).toMatchObject({
      id: { context: roomContext(ALICE), id: result.id },
      author: { account: ALICE, display_name: "Alice", is_bot: false },
      text: "看這個",
      mentions_self: false,
      reply_to_self: false,
      attachments: [
        {
          url: `https://uploads.room.invalid/${up.id}`,
          filename: "note.txt",
          content_type: "text/plain",
          id: up.id,
          size: 2,
        },
      ],
    });
    expect(r.heard.map((o) => o.event)).toEqual([
      {
        kind: "you",
        id: result.id,
        at: result.at,
        text: "看這個",
        files: [{ name: "note.txt", size: 2, kind: "file", download: false }],
        client_id: "tab-0001",
      },
    ]);
    expect(r.room.channel.hub(ALICE).own.has(result.id)).toBe(true);
    // The upload went with this line.
    expect(r.room.uploads.take(ALICE, [up.id])).toBeNull();
  });

  it("asks the input defence once, with the line's id", async () => {
    const r = sendRig();
    const ok = await r.send("hi");
    expect(r.asked).toEqual([
      expect.objectContaining({
        id: ok.id,
        source: "chat",
        author: { id: "discord:1", owner: false },
      }),
    ]);
    r.verdict.next = { action: "ignore" };
    const ignored = await r.send("spam");
    expect(ignored).toMatchObject({ heard: "ignored", notice: ROOM_TEXT.ignored });
    expect(ignored.notice).toBe("這句她收不到");
    r.verdict.next = { action: "rate_limit" };
    const held = await r.send("spam again");
    expect(held).toMatchObject({ heard: "held", notice: "你說得有點快,她先聽著" });
    expect(r.asked.map((a) => a.id)).toEqual([ok.id, ignored.id, held.id]);
    // Still logged and published: the agent asks again by id and gets the same verdict.
    expect(r.published).toHaveLength(3);
    expect(r.logged).toHaveLength(3);
  });

  it("allows messages_per_minute a minute, then 429 with retry-after", async () => {
    const r = sendRig({ messages_per_minute: 2 });
    await r.send("one");
    r.clock.t += 20_000;
    await r.send("two");
    const error = await refusal(() => r.send("three"));
    expect([error.status, error.message]).toEqual([429, ROOM_TEXT.tooFast]);
    expect(error.headers["retry-after"]).toBe("40");
    // A refused line costs nothing and goes nowhere.
    expect(r.published).toHaveLength(2);
    // Another person's minute is their own.
    expect((await r.send("bob", [], BOB)).heard).toBe("ok");
    r.clock.t += 40_000;
    expect((await r.send("four")).heard).toBe("ok");
  });
});
