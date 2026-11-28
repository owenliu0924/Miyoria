// The room's sink (docs/design/her-room.md §2.5): her text without Discord's markup, each line to
// the hub of the account whose room it is and nobody else's, her echo on the bus as her own
// (`ROOM_SELF`), and `typing` at most once a second.

import type { RoomEvent } from "@miyoria/contracts/api";
import { ModerationKey, ROOM_SELF, roomContext } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { Outgoing } from "../src/room/channel.js";
import { roomText, WebSink } from "../src/room/sink.js";
import { ALICE, BOB, makeRig } from "./room-rig.js";

function sinkRig(config: Record<string, unknown> = {}) {
  const rig = makeRig(config);
  const sink = new WebSink(rig.state as never, rig.room);
  const heard = (account: typeof ALICE) => {
    const got: Outgoing[] = [];
    rig.room.channel.hub(account).listen((out) => got.push(out));
    return got;
  };
  return { ...rig, sink, heard };
}

describe("her lines in the room", () => {
  it("leaves no mention and keeps custom emoji as :name:", () => {
    expect(roomText("hi <@123> and <@!456> <@&789> <#42>!")).toBe("hi and !");
    expect(roomText("<:smile:111> <a:wave:222>")).toBe(":smile: :wave:");
    expect(roomText("好 <@123> <:cat_2:333>")).toBe("好 :cat_2:");
    expect(roomText("line one\nline two")).toBe("line one\nline two");
  });

  it("reviews a line once more before it goes out, as Discord's sink does", async () => {
    const r = sinkRig();
    r.services.set(ModerationKey, {
      screen: () => ({ ok: false, blocked: [{ rule: "test.rule" }] }),
      filteredLine: "(這句不能說)",
      filteredVoiceLine: "(這句不能說)",
    });
    const alice = r.heard(ALICE);
    const sent = await r.sink.send(roomContext(ALICE), { text: "不該說的話", reply_to: null });
    expect(sent.blocked).toBe("test.rule");
    expect((alice[0]?.event as Extract<RoomEvent, { kind: "line" }>).text).toBe("(這句不能說)");
  });

  it("sends a line only to that account's hub, and echoes it as hers", async () => {
    const r = sinkRig({ voice_max_chars: 20 });
    const alice = r.heard(ALICE);
    const bob = r.heard(BOB);
    r.room.channel.hub(ALICE).lastTurn = "turn-1";
    const sent = await r.sink.send(roomContext(ALICE), {
      text: "好啊 <@900> <:heart:12>",
      reply_to: null,
    });
    expect(sent.context).toEqual(roomContext(ALICE));
    expect(bob).toEqual([]);
    expect(alice).toHaveLength(1);
    const line = alice[0]?.event as Extract<RoomEvent, { kind: "line" }>;
    expect(line).toEqual({
      kind: "line",
      id: sent.id,
      at: new Date(r.clock.t).toISOString(),
      turn: "turn-1",
      text: "好啊 :heart:",
      files: [],
      voice: true,
    });
    expect(alice[0]?.id).toBe("run1-1");
    // The hub knows it as hers (for its voice and files); Bob's has no hub at all for it.
    expect(r.room.channel.hub(ALICE).lines.get(sent.id)?.text).toBe("好啊 :heart:");
    expect(r.room.channel.hub(BOB).lines.has(sent.id)).toBe(false);
    expect(r.published).toEqual([
      {
        type: "platform.message.created",
        data: expect.objectContaining({
          id: { context: roomContext(ALICE), id: sent.id },
          author: expect.objectContaining({ account: ROOM_SELF, is_bot: true }),
          text: "好啊 :heart:",
        }),
        meta: { turn: "turn-1" },
      },
    ]);
    // A line too long for her voice says so.
    await r.sink.send(roomContext(ALICE), { text: "長".repeat(21), reply_to: null });
    expect(alice[1]?.event).toMatchObject({ kind: "line", voice: false });
  });

  it("refuses a context that is nobody's room", async () => {
    const r = sinkRig();
    const discordDm = { platform: "discord", scope: null, channel: "1", kind: "dm" as const };
    await expect(r.sink.send(discordDm, { text: "x", reply_to: null })).rejects.toThrow();
    expect(r.published).toEqual([]);
  });

  it("says typing at most once a second, to that room only", async () => {
    const r = sinkRig();
    const alice = r.heard(ALICE);
    const bob = r.heard(BOB);
    await r.sink.typing(roomContext(ALICE));
    await r.sink.typing(roomContext(ALICE));
    r.clock.t += 999;
    await r.sink.typing(roomContext(ALICE));
    r.clock.t += 1;
    await r.sink.typing(roomContext(ALICE));
    expect(alice).toEqual([
      { id: null, event: { kind: "typing" } },
      { id: null, event: { kind: "typing" } },
    ]);
    expect(bob).toEqual([]);
    // Not kept for a reconnect.
    expect(r.room.channel.hub(ALICE).latestId()).toBe("run1-0");
  });

  it("puts a reaction in the room of the line it answers", async () => {
    const r = sinkRig();
    const alice = r.heard(ALICE);
    const bob = r.heard(BOB);
    await r.sink.react({ context: roomContext(BOB), id: "L1" }, "👍");
    expect(alice).toEqual([]);
    expect(bob.map((o) => o.event)).toEqual([{ kind: "reaction", to: "L1", emoji: "👍" }]);
  });
});
