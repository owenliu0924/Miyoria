// Module `cards`: it provides `CardsKey` over the store's tables, pays through whatever wallet
// `CardWalletKey` holds at the time, takes its numbers from `[modules.cards]`, and puts the heart's
// relationship (words only) on the card.

import { heartTables } from "@miyoria/heart/person";
import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { EventLogKey, type JsonObject } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CardFacesKey,
  CardsKey,
  CardsModule,
  type CardsModuleOptions,
  type CardWallet,
  CardWalletKey,
  cardRelationship,
  cardsTables,
  expressionsFor,
} from "../src/index.js";

const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const clock = { now: () => T0 };
const FACE = {
  name: "小明",
  avatar_url: null,
  call_name: null,
  line: null,
  stamp: null,
  fields: [],
  number: 1,
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start(config: JsonObject | null = null, options: CardsModuleOptions = {}) {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables, cardsTables], clock });
  cleanup.push(() => store.close());
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  sup.services.provide("app", StoreKey, store);
  await sup.register(new CardsModule({ clock, ...options }), config, true);
  await sup.startAll();
  return { store, sup };
}

function walletWith(coins: number): CardWallet & { spent: number } {
  return {
    spent: 0,
    async balance() {
      return coins;
    },
    async spend(_payer, amount) {
      if (coins < amount) return { ok: false, reason: "insufficient", balance: coins };
      coins -= amount;
      this.spent += amount;
      return { ok: true, receipt: "r", balance: coins };
    },
    async refund() {},
  };
}

const payer = (person: string) => ({ person, account: { platform: "discord", id: person } });
const face = async () => FACE;

describe("module cards", () => {
  it("provides the cards and charges through the wallet it finds", async () => {
    const { sup } = await start({ price: 12, daily_cap: 2 });
    const cards = sup.services.get(CardsKey);
    expect(cards?.config).toMatchObject({ price: 12, daily_cap: 2, pity: 20 });
    expect(await cards?.issueDaily(payer("p1"), face)).toEqual({ ok: false, reason: "no_wallet" });
    const wallet = walletWith(100);
    sup.services.provide("economy", CardWalletKey, wallet);
    expect((await cards?.issueDaily(payer("p1"), face))?.ok).toBe(true);
    expect((await cards?.issueDaily(payer("p1"), face))?.ok).toBe(true);
    expect(await cards?.issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "daily_cap",
      cap: 2,
    });
    expect(wallet.spent).toBe(24);
    expect(cards?.odds().rarities.map((r) => r.shown)).toEqual(["70.00", "22.00", "7.00", "1.00"]);
  });

  it("puts the heart's words on the card, and her expression follows them", async () => {
    const { sup, store } = await start({ price: 0 });
    const heart = store.plugin(heartTables).people;
    heart.edit("p1", {}, { now: T0 });
    heart.adminSet("p1", "bond", -80, { now: T0 });
    const cards = sup.services.get(CardsKey);
    const stranger = await cards?.issueDaily(payer("nobody"), face);
    const disliked = await cards?.issueDaily(payer("p1"), face);
    if (!stranger?.ok || !disliked?.ok) throw new Error("refused");
    expect(stranger.issued.card.relationship.tier).toBe("陌生人");
    expect(disliked.issued.card.relationship).toMatchObject({
      tier: "很討厭",
      tier_label: "很討厭",
    });
    expect(JSON.stringify(disliked.issued.card.relationship)).not.toContain("-80");
    expect(expressionsFor("很討厭").map((e) => e.id)).toContain(disliked.issued.card.expression.id);
  });

  it("puts a person's cards in the relationships data category: exported and wiped with it", async () => {
    const { sup, store } = await start({ price: 0 });
    const cards = sup.services.get(CardsKey);
    await cards?.issueDaily(payer("p1"), face);
    cards?.setWishlist("p1", ["pose.sway"]);
    const exported = await store.profileData.export("p", ["relationships"]);
    expect(JSON.stringify(exported)).toContain("cards_card");
    const counts = await store.profileData.wipe("p", ["relationships"]);
    expect(counts).toMatchObject({ cards_card: 1, cards_pity: 1, cards_wishlist: 1 });
    expect(cards?.cards("p1")).toEqual([]);
    // The catalogue is not anyone's data and stays.
    expect(cards?.catalogue().length).toBeGreaterThan(0);
  });

  it("gives a milestone card for each tier a bond enters, once, with her words when it can", async () => {
    const { sup, store } = await start();
    const heart = store.plugin(heartTables).people;
    const cards = sup.services.get(CardsKey);
    const mei = await store.people.upsertAccount({ platform: "discord", id: "a1" }, "小美");
    // Without the api's words: their name, nothing she wrote.
    heart.adminSet(mei, "bond", 50, { now: T0 });
    await vi.waitFor(() => expect(cards?.cards(mei)).toHaveLength(2));
    const first = cards?.cards(mei) ?? [];
    expect(first.map((c) => [c.kind, c.issue_key, c.price, c.face.name]).sort()).toEqual([
      ["milestone", "milestone:15", 0, "小美"],
      ["milestone", "milestone:45", 0, "小美"],
    ]);
    // Down and up again: nothing new. A new tier, with the api's words and the anchor's memory.
    const asked: unknown[] = [];
    sup.services.provide("api", CardFacesKey, {
      async face(person, occasion) {
        asked.push(occasion);
        return {
          face: { ...FACE, line: "那天一起看完了流星" },
          relationship: cardRelationship(heart.get(person)),
        };
      },
    });
    heart.adminSet(mei, "bond", 10, { now: T0 });
    heart.adminSet(mei, "bond", 119, { now: T0 });
    heart.setAnchor(mei, {
      tier: 120,
      note_ref: "n1",
      quote: "一起看流星",
      at: "2026-11-17T02:00:00.000Z",
      by: "reflect",
    });
    heart.adminSet(mei, "bond", 121, { now: T0 });
    await vi.waitFor(() => expect(cards?.cards(mei)).toHaveLength(4));
    expect(asked).toEqual([
      { kind: "milestone", tier: "摯友", scene: null },
      { kind: "milestone", tier: "知心", scene: "一起看流星" },
    ]);
    expect(cards?.cards(mei, { limit: 1 })[0]?.face.line).toBe("那天一起看完了流星");
  });

  it("gives a keepsake to someone the heart's migration brought over, and to nobody else", async () => {
    const notes: unknown[] = [];
    const { sup, store } = await start();
    sup.services.provide("facts", EventLogKey, { observe: (o: unknown) => notes.push(o) } as never);
    const heart = store.plugin(heartTables).people;
    const cards = sup.services.get(CardsKey);
    heart.edit("old", {}, { now: T0 });
    const row = heart.get("old");
    if (row === null) throw new Error("no row");
    heart.upsert({ ...row, legacy: { migrated_at: "2026-11-17T02:00:00.000Z" } });
    heart.edit("new", {}, { now: T0 });
    const words = async () => ({ face: FACE, relationship: cardRelationship(null) });
    expect((await cards?.keepsake("old", words))?.ok).toBe(true);
    expect(await cards?.keepsake("new", words)).toEqual({ ok: false, reason: "not_eligible" });
    expect(cards?.cards("old").map((c) => c.kind)).toEqual(["keepsake"]);
    // She is not told of it, and nobody is sent anything.
    expect(notes).toEqual([]);
  });

  it("tells her of a rare card as a note she may react to, and not of an ordinary one", async () => {
    const notes: { source: string; silent: boolean; summary: string; attention_key: string }[] = [];
    const log = { observe: (o: (typeof notes)[number]) => notes.push(o) };
    // The last of every pick: an SSR card.
    const { sup } = await start({ price: 0 }, { random: () => 0.999_999 });
    sup.services.provide("facts", EventLogKey, log as never);
    const cards = sup.services.get(CardsKey);
    const rare = await cards?.issueDaily(payer("p1"), face);
    if (!rare?.ok) throw new Error("refused");
    expect(rare.issued.card.rarity).toBe("SSR");
    expect(notes).toEqual([
      expect.objectContaining({
        source: "cards.drawn",
        silent: false,
        attention_key: `cards:${rare.issued.card.serial}`,
        summary: expect.stringMatching(/^小明 抽到一張 SSR 的卡/),
      }),
    ]);
  });
});
