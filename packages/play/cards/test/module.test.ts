// Module `cards`: it provides `CardsKey` over the store's tables, pays through whatever wallet
// `CardWalletKey` holds at the time, takes its numbers from `[modules.cards]`, and puts the heart's
// relationship (words only) on the card.

import { heartTables } from "@miyoria/heart/person";
import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import type { JsonObject } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  CardsKey,
  CardsModule,
  type CardWallet,
  CardWalletKey,
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
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start(config: JsonObject | null = null) {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables, cardsTables], clock });
  cleanup.push(() => store.close());
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  sup.services.provide("app", StoreKey, store);
  await sup.register(new CardsModule({ clock }), config, true);
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
});
