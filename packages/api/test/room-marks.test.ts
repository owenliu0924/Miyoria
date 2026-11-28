// Her bond's marks in the room (docs/design/her-room.md §3.5): only her `<feel>` really moving the
// bond is a mark, it says a direction and her quote and never a number, a quote naming someone
// else is no quote, and the mark goes to the room whose turn it was and nobody else's.

import type { HeartChange } from "@miyoria/types";
import { HeartKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { isBondMark, markId, markQuote } from "../src/room/backlog.js";
import type { Outgoing } from "../src/room/channel.js";
import { startRoom } from "../src/room/start.js";
import { ALICE, BOB, makeRig, personOf, settle } from "./room-rig.js";

const member = (account = ALICE) => ({
  account,
  person: personOf(account),
  row: null,
  hidden: false,
});

describe("what a bond mark is", () => {
  it("is her feel moving the bond, and nothing else", () => {
    expect(isBondMark({ cause: "feel", field: "bond", delta: 3 })).toBe(true);
    expect(isBondMark({ cause: "feel", field: "bond", delta: -2 })).toBe(true);
    // The caps took it all: the bond did not move.
    expect(isBondMark({ cause: "feel", field: "bond", delta: 0 })).toBe(false);
    expect(isBondMark({ cause: "feel", field: "trust", delta: 3 })).toBe(false);
    for (const cause of ["reflect", "evidence", "decay", "admin", "migrate"] as const) {
      expect(isBondMark({ cause, field: "bond", delta: 3 })).toBe(false);
    }
  });

  it("quotes her only when nobody else is named and moderation passes it", async () => {
    const r = makeRig();
    const quote = (text: string) => markQuote(r.state as never, member() as never, text);
    expect(await quote(" 她記得我愛吃布丁 ")).toBe("她記得我愛吃布丁");
    // Their own name is fine; somebody else's is not.
    expect(await quote("Alice 記得我愛吃布丁")).toBe("Alice 記得我愛吃布丁");
    expect(await quote("和 Bobby 不一樣")).toBeNull();
    expect(await quote("<@900000000000000012> 也是")).toBeNull();
    expect(await quote("   ")).toBeNull();
    r.refused.add("壞話");
    expect(await quote("一句壞話")).toBeNull();
  });

  it("has the same id in the stream and the backlog", () => {
    expect(markId("turn-1", "2026-11-28T04:00:00.000Z")).toBe(
      `m-turn-1-${Date.UTC(2026, 10, 28, 4)}`,
    );
  });
});

describe("a bond mark on the stream", () => {
  function started() {
    const rig = makeRig();
    let listener: ((change: HeartChange) => void) | null = null;
    rig.services.set(HeartKey, {
      onChanged: (l: (change: HeartChange) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    });
    const ctl = new AbortController();
    const ctx = {
      ...rig.state.ctx,
      provide: () => {},
      subscribe: () => ({}),
      // The bus and the timer are not run here: only the heart's listener is.
      spawn: () => {},
      signal: ctl.signal,
    };
    startRoom(ctx as never, rig.state as never, rig.room);
    const heard = (account = ALICE) => {
      const got: Outgoing[] = [];
      rig.room.channel.hub(account).listen((out) => got.push(out));
      return got;
    };
    const change = async (over: Partial<HeartChange>) => {
      if (listener === null) throw new Error("not following the heart");
      listener({
        person: "p-1" as never,
        field: "bond",
        delta: 2,
        quote: "她記得我愛吃布丁",
        cause: "feel",
        turn: "turn-a",
        at: "2026-11-28T04:00:05.000Z" as never,
        event_id: "ev-1",
        ...over,
      });
      await settle();
      await settle();
    };
    return { ...rig, ctl, heard, change, listening: () => listener !== null };
  }

  it("goes to the room whose turn moved it, with a sign and a quote only", async () => {
    const r = started();
    r.room.channel.turnIn("turn-a", ALICE);
    r.room.channel.turnIn("turn-b", BOB);
    const alice = r.heard(ALICE);
    const bob = r.heard(BOB);
    await r.change({});
    await r.change({ delta: -1, quote: "Bobby 比較好", at: "2026-11-28T04:00:06.000Z" as never });
    expect(bob).toEqual([]);
    expect(alice.map((o) => o.event)).toEqual([
      {
        kind: "bond",
        id: markId("turn-a", "2026-11-28T04:00:05.000Z"),
        at: "2026-11-28T04:00:05.000Z",
        turn: "turn-a",
        sign: "plus",
        quote: "她記得我愛吃布丁",
      },
      {
        kind: "bond",
        id: markId("turn-a", "2026-11-28T04:00:06.000Z"),
        at: "2026-11-28T04:00:06.000Z",
        turn: "turn-a",
        sign: "minus",
        quote: null,
      },
    ]);
    expect(JSON.stringify(alice)).not.toContain("delta");
    r.ctl.abort();
    expect(r.listening()).toBe(false);
  });

  it("is not a mark when the bond did not move, it is not hers to show, or not this room's", async () => {
    const r = started();
    r.room.channel.turnIn("turn-a", ALICE);
    const alice = r.heard(ALICE);
    await r.change({ delta: 0 });
    await r.change({ field: "trust" });
    await r.change({ cause: "reflect" });
    await r.change({ turn: null });
    // A turn of no room (a Discord DM), and her feel about Bob in Alice's room.
    await r.change({ turn: "turn-discord" });
    await r.change({ person: "p-2" as never });
    // Alice blocked: she is a stranger, no mark.
    r.blocked.add(ALICE.id);
    await r.change({});
    expect(alice).toEqual([]);
  });
});
