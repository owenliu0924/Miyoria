// Who people are, on the heart (phase 4 step 5): the old `social` module's account map, `/me
// link`, `set_call_name` and `/me profile` now live with the rows. Module `heart` counts the lines
// people say itself and is `SocialSignalsKey` for everyone else.

import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type Clock,
  Events,
  HeartKey,
  RELATIONSHIP_LABELS,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  callNameCapability,
  checkCallName,
  FEELINGS,
  HeartModule,
  heartTables,
  labelOf,
  PeopleDirectory,
  PeopleDirectoryKey,
} from "../src/index.js";

const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);

class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function openStore(clock: Clock): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
  cleanup.push(() => store.close());
  return store;
}

const account = (id: string): AccountRef => ({ platform: "discord", id });

function directory(store: SqliteStore, clock: Clock): PeopleDirectory {
  return new PeopleDirectory(
    "p",
    "米優",
    ["miyo"],
    {
      people: store.people,
      identity: store.identity ?? null,
      heart: store.plugin(heartTables).people,
    },
    clock,
  );
}

describe("the people directory", () => {
  it("resolves accounts, makes a person on first sight, and answers attitudes from the rows", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = directory(store, clock);
    const amy = await people.resolve(account("1"), "Amy", T0);
    expect(amy).not.toBeNull();
    expect(people.personOf(account("1"))).toBe(amy);
    expect(people.displayName(amy as string)).toBe("Amy");
    // No row yet: nobody she feels anything about.
    expect(people.attitude(account("1"))).toBeNull();
    people.heart.adminSet(amy as string, "bond", 50);
    expect(people.attitude(account("1"))).toMatchObject({
      person: amy,
      affinity: 50,
      blocked: false,
      display_name: "Amy",
    });
    expect(people.mentionsHer("米優在嗎")).toBe(true);
    expect(await people.resolve(account("9"), null, T0)).toBeNull();
  });

  it("links two accounts into one person; the absorbed one's row moves", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = directory(store, clock);
    const code = await people.issueLinkCode(account("1"), "Amy", T0);
    expect(code).not.toBeNull();
    const other = await people.resolve(account("2"), "Amy2", T0);
    people.heart.edit(other as string, { call_name: "阿咪" });
    const outcome = await people.redeemLinkCode(account("2"), "Amy2", code as string, T0);
    expect(outcome.type).toBe("linked");
    const keep = people.personOf(account("1"));
    expect(people.personOf(account("2"))).toBe(keep);
    expect(people.heart.get(keep as string)?.call_name).toBe("阿咪");
  });
});

describe("/me profile lines", () => {
  it("has a line in her voice for every tier, and never the stranger's for a close tier", () => {
    for (const tier of RELATIONSHIP_LABELS) expect(FEELINGS[tier].length).toBeGreaterThan(0);
    const stranger = FEELINGS.陌生人;
    for (const tier of RELATIONSHIP_LABELS.slice(3)) expect(FEELINGS[tier]).not.toBe(stranger);
    expect(labelOf(null)).toBe("陌生人");
  });

  it("refuses call names by their shape", () => {
    expect(checkCallName("")).not.toBeNull();
    expect(checkCallName("@everyone")).not.toBeNull();
    expect(checkCallName("小明")).toBeNull();
  });
});

describe("set_call_name", () => {
  it("writes the speaker's own call name on their heart row", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = directory(store, clock);
    const amy = (await people.resolve(account("1"), "Amy", T0)) as string;
    const tool = callNameCapability(people);
    const ctx = {
      principal: { kind: "user", requester: account("1") },
      request: { why: null },
    } as never;
    await tool.execute({ name: "阿咪" } as never, ctx);
    expect(people.heart.get(amy)?.call_name).toBe("阿咪");
    await tool.execute({ name: "清除" } as never, ctx);
    expect(people.heart.get(amy)?.call_name).toBeNull();
  });
});

describe("the data page's call names", () => {
  it("exports and clears what she calls people on the heart's rows; the rows stay", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const heart = store.plugin(heartTables).people;
    heart.adminSet("p1", "bond", 40);
    heart.edit("p1", { call_name: "阿咪" });
    heart.adminSet("p2", "bond", 10);
    const backup = await store.profileData.export("p", ["call_names"]);
    expect(backup.parts.heart_call_names).toEqual([{ person_id: "p1", call_name: "阿咪" }]);
    const wiped = await store.profileData.wipe("p", ["call_names"]);
    expect(wiped.heart_call_names).toBe(1);
    expect(heart.get("p1")).toMatchObject({ call_name: null, bond: 40 });
  });
});

describe("module heart, who people are", () => {
  it("counts the lines people say itself and provides SocialSignalsKey from the rows", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", StoreKey, store);
    await sup.register(HeartModule.fromProfile(profileOf(), { clock }), null, true);
    await sup.startAll();
    expect(sup.services.get(PeopleDirectoryKey)).toBeInstanceOf(PeopleDirectory);
    sup.bus.publish("discord", Events.PlatformMessageCreated, {
      id: { context: { platform: "discord", scope: "g", channel: "c", kind: "channel" }, id: "m1" },
      author: { account: account("1"), display_name: "Amy", is_bot: false },
      text: "米優早安",
      mentions_self: false,
      reply_to_self: false,
    } as never);
    const signals = sup.services.require(SocialSignalsKey);
    await waitFor(() => signals.attitude(account("1")) !== null);
    const amy = signals.attitude(account("1"));
    // Her name in the line: said to her, an interaction.
    expect(sup.services.require(HeartKey).view(amy?.person as string)).toMatchObject({
      blocked: false,
    });
    expect(store.plugin(heartTables).people.get(amy?.person as string)?.interactions).toBe(1);
  });
});

function profileOf() {
  return { id: "p", displayName: "米優", names: () => ["miyo"] } as never;
}

async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error("timed out");
}
