// Her room's hubs (docs/design/her-room.md §3.4): event ids `<run>-<n>`, what a reconnect with
// `Last-Event-ID` is told, the ring of 200 events or 10 minutes, and one account's hub never
// hearing another's.

import type { RoomEvent } from "@miyoria/contracts/api";
import type { AccountRef } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type Outgoing, RING_EVENTS, RING_MS, RoomChannel } from "../src/room/channel.js";

const ALICE: AccountRef = { platform: "discord", id: "1" };
const BOB: AccountRef = { platform: "discord", id: "2" };
const T0 = Date.UTC(2026, 10, 28, 4, 0, 0);

const thinking = (turn: string): RoomEvent => ({ kind: "thinking", turn });

function channel() {
  const clock = { t: T0 };
  return { clock, channel: new RoomChannel(() => clock.t, "run1") };
}

describe("a room's hub", () => {
  it("numbers its events <run>-<n> and hands each to its streams", () => {
    const { channel: ch } = channel();
    const hub = ch.hub(ALICE);
    expect(ch.hub(ALICE)).toBe(hub);
    expect(hub.latestId()).toBe("run1-0");
    const got: Outgoing[] = [];
    const stop = hub.listen((out) => got.push(out));
    expect(hub.streams).toBe(1);
    hub.push(thinking("t1"));
    hub.push(thinking("t2"));
    hub.tell({ kind: "typing" });
    stop();
    hub.push(thinking("t3"));
    expect(got).toEqual([
      { id: "run1-1", event: thinking("t1") },
      { id: "run1-2", event: thinking("t2") },
      // Told, not kept: no id.
      { id: null, event: { kind: "typing" } },
    ]);
    expect(hub.streams).toBe(0);
    expect(hub.latestId()).toBe("run1-3");
  });

  it("replays what came after a Last-Event-ID of this run", () => {
    const { channel: ch } = channel();
    const hub = ch.hub(ALICE);
    for (const t of ["t1", "t2", "t3"]) hub.push(thinking(t));
    const replayed = (id: string) => hub.since(id)?.map((k) => [hub.idOf(k), k.event]);
    expect(replayed("run1-1")).toEqual([
      ["run1-2", thinking("t2")],
      ["run1-3", thinking("t3")],
    ]);
    expect(replayed("run1-0")).toHaveLength(3);
    // Up to date: nothing to replay, but nothing lost either.
    expect(replayed("run1-3")).toEqual([]);
  });

  it("cannot tell another run, an id from the future, or one it never gave", () => {
    const { channel: ch } = channel();
    const hub = ch.hub(ALICE);
    hub.push(thinking("t1"));
    hub.push(thinking("t2"));
    expect(hub.since("run2-1")).toBeNull();
    expect(hub.since("run1-3")).toBeNull();
    expect(hub.since("run1-99")).toBeNull();
    expect(hub.since("run1")).toBeNull();
    expect(hub.since("run1-x")).toBeNull();
    expect(hub.since("")).toBeNull();
  });

  it(`keeps the last ${RING_EVENTS} events only`, () => {
    const { channel: ch } = channel();
    const hub = ch.hub(ALICE);
    for (let i = 1; i <= RING_EVENTS + 5; i++) hub.push(thinking(`t${i}`));
    // Event 6 is the oldest kept: after 5 everything is there, after 4 event 5 is gone.
    const fromFive = hub.since("run1-5");
    expect(fromFive).toHaveLength(RING_EVENTS);
    expect(fromFive?.[0] && hub.idOf(fromFive[0])).toBe("run1-6");
    expect(hub.since("run1-4")).toBeNull();
    expect(hub.since("run1-0")).toBeNull();
  });

  it("keeps an event 10 minutes only", () => {
    const { channel: ch, clock } = channel();
    const hub = ch.hub(ALICE);
    hub.push(thinking("t1"));
    clock.t += 5 * 60_000;
    hub.push(thinking("t2"));
    clock.t = T0 + RING_MS;
    // Exactly 10 minutes old is still kept.
    expect(hub.since("run1-0")).toHaveLength(2);
    clock.t = T0 + RING_MS + 1;
    expect(hub.since("run1-0")).toBeNull();
    expect(hub.since("run1-1")?.map((k) => k.event)).toEqual([thinking("t2")]);
    clock.t += 5 * 60_000;
    // Both gone: after the newest, nothing was lost; after the first, the second was.
    expect(hub.since("run1-2")).toEqual([]);
    expect(hub.since("run1-1")).toBeNull();
  });

  it("never lets one account's stream hear another's room", () => {
    const { channel: ch } = channel();
    const alice: Outgoing[] = [];
    const bob: Outgoing[] = [];
    ch.hub(ALICE).listen((out) => alice.push(out));
    ch.hub(BOB).listen((out) => bob.push(out));
    ch.hub(BOB).push(thinking("bob-turn"));
    ch.hub(BOB).tell({ kind: "typing" });
    expect(alice).toEqual([]);
    expect(bob.map((o) => o.event.kind)).toEqual(["thinking", "typing"]);
    ch.hub(ALICE).push(thinking("alice-turn"));
    expect(alice).toEqual([{ id: "run1-1", event: thinking("alice-turn") }]);
    // Each hub counts its own: Bob's ids say nothing of Alice's.
    expect(ch.hub(BOB).latestId()).toBe("run1-1");
    expect(
      ch
        .watched()
        .map((h) => h.account.id)
        .sort(),
    ).toEqual(["1", "2"]);
    // A lookup never makes a hub.
    expect(ch.existing({ platform: "discord", id: "3" })).toBeUndefined();
    expect(ch.watched()).toHaveLength(2);
  });

  it("counts every open stream once, and knows whose room a turn ran in", () => {
    const { channel: ch } = channel();
    const a = ch.opened();
    const b = ch.opened();
    expect(ch.streams).toBe(2);
    a();
    a();
    expect(ch.streams).toBe(1);
    b();
    expect(ch.streams).toBe(0);
    ch.turnIn("turn-a", ALICE);
    expect(ch.turnOf("turn-a")).toEqual(ALICE);
    expect(ch.turnOf("turn-b")).toBeUndefined();
  });
});
