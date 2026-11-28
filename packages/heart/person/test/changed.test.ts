// Every change told once committed (`onChanged`), with the turn it came from, and the turn carried
// into the nightly reflection's day: her room marks the bond moving after her line of that turn.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { type HeartChange, toTimestamp } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeartService, HeartStore, heartPersonConfig, heartSchema } from "../src/index.js";

const rules = heartPersonConfig();
/** 2026-11-17 10:00 in her time zone (UTC+8). */
const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const MIN = 60_000;
const clock = { now: () => NOW };

const bondUp = { field: "bond" as const, direction: "up" as const, quote: "一起熬夜" };

let t: TestDb;
let store: HeartStore;
let heart: HeartService;

beforeEach(() => {
  t = openTestDb({ identity: true, plugins: [heartSchema], clock });
  store = new HeartStore(t.db, t.events, { rules, clock });
  heart = new HeartService(store, clock);
});

afterEach(() => t.close());

describe("onChanged", () => {
  it("tells every change once committed, with its turn and event", () => {
    const told: HeartChange[] = [];
    heart.onChanged((c) => told.push(c));
    heart.feel("amy", [bondUp, { field: "trust", direction: "up", quote: "" }], { turn: "t1" });
    const events = t.events.query({ types: ["heart.changed"], order: "asc" });
    expect(told).toEqual([
      {
        person: "amy",
        field: "bond",
        delta: 3,
        quote: "一起熬夜",
        cause: "feel",
        turn: "t1",
        at: toTimestamp(NOW),
        event_id: events[0]?.envelope.id,
      },
      expect.objectContaining({ field: "trust", turn: "t1", event_id: events[1]?.envelope.id }),
    ]);
    // A change with no turn (an owner's edit) is told with `null`.
    store.adminSet("amy", "bond", 20);
    expect(told.at(-1)).toMatchObject({ cause: "admin", turn: null, quote: "" });
  });

  it("waits for the caller's commit and never tells a rolled-back write", () => {
    const told: HeartChange[] = [];
    heart.onChanged((c) => told.push(c));
    expect(() =>
      t.db.tx(() => {
        heart.feel("amy", [bondUp], { turn: "t1" });
        throw new Error("the caller failed");
      }),
    ).toThrow("the caller failed");
    expect(told).toEqual([]);
    t.db.tx(() => {
      heart.feel("amy", [bondUp], { turn: "t2" });
      expect(told).toEqual([]);
    });
    expect(told.map((c) => c.turn)).toEqual(["t2"]);
  });

  it("tells a proposal the caps took all of, with delta 0", () => {
    // At the top of the scale a rise has nowhere to go.
    store.adminSet("amy", "bond", 1000);
    const told: HeartChange[] = [];
    heart.onChanged((c) => told.push(c));
    heart.feel("amy", [bondUp], { turn: "t1" });
    expect(told).toEqual([expect.objectContaining({ field: "bond", delta: 0, turn: "t1" })]);
  });

  it("stops telling once unsubscribed, and a throwing listener harms no one", () => {
    const told: string[] = [];
    heart.onChanged(() => {
      throw new Error("a broken listener");
    });
    const off = heart.onChanged((c) => told.push(c.turn ?? "none"));
    expect(heart.feel("amy", [bondUp], { turn: "t1" })).toBe(1);
    expect(store.get("amy")?.bond).toBe(3);
    expect(told).toEqual(["t1"]);
    off();
    heart.feel("amy", [bondUp], { turn: "t2" });
    expect(told).toEqual(["t1"]);
  });
});

describe("the day's changes", () => {
  it("carry the turn from the event's envelope, null when there is none", () => {
    store.adminSet("amy", "bond", 10);
    heart.feel("amy", [bondUp], { turn: "t1" });
    const day = heart.day("amy", NOW - MIN, NOW + MIN);
    expect(day?.changes.map((c) => [c.cause, c.turn])).toEqual([
      ["admin", null],
      ["feel", "t1"],
    ]);
  });
});
