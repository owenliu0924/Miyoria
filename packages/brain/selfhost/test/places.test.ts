// `say`'s places by name (`places.ts`): a DM by `私訊:名字`, never the member's room on the site
// (docs/design/her-room.md §2.5).

import type { TranscriptEntry, TranscriptStore } from "@miyoria/memory/transcript";
import { type ContextKey, contextKeyString, roomContext } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type PlaceBook, resolvePlace } from "../src/places.js";
import { account, channel, dm } from "./harness.js";

const C1 = channel("c1");
const DM = dm("dm-owen");
const ROOM = roomContext(account("owen"));

function entry(name: string): TranscriptEntry {
  return {
    kind: "other",
    bot: false,
    account: account(name),
    author: name,
    content: "嗨",
    redacted_at: null,
  } as TranscriptEntry;
}

/** A book of `places`, latest first, each with one line of `owen`. */
function book(places: readonly ContextKey[]): PlaceBook {
  const transcript = {
    sessions: () => places.map(contextKeyString),
    contextOf: (session: string) => places.find((p) => contextKeyString(p) === session) ?? null,
    tail: () => ({ entries: [entry("owen")] }),
  } as unknown as TranscriptStore;
  return { transcript, live: () => [], sessionOf: contextKeyString };
}

describe("私訊:名字", () => {
  it("is their DM though their room is the latest place", async () => {
    expect(await resolvePlace(book([ROOM, DM]), "私訊:owen", C1)).toEqual(DM);
    expect(await resolvePlace(book([ROOM, DM]), "@owen", C1)).toEqual(DM);
  });

  it("is nothing when only their room is known", async () => {
    expect(await resolvePlace(book([ROOM]), "私訊:owen", C1)).toBeNull();
    expect(await resolvePlace(book([ROOM]), `#${ROOM.channel}`, C1)).toBeNull();
  });
});
