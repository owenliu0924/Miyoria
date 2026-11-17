// The daily card through the store's tables: the price (the first card too), the daily cap by her
// local day, too few coins, a refund when a card cannot be written, the pity counter, the dex with
// series titles, wishlists and their events, and forgetting and merging a person.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { PersonId } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CardPayer,
  CardService,
  type CardServiceOptions,
  CardStore,
  type CardWallet,
  cardsConfig,
  cardsSchema,
  dayStart,
  drawRules,
  type IssueInput,
  type Part,
  SEED_PARTS,
  seededRandom,
} from "../src/index.js";

/** 2026-11-17 10:00 in her time zone (UTC+8). */
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const DAY = 86_400_000;
const FACE = {
  name: "小明",
  avatar_url: null,
  call_name: null,
  line: "今天也來了呢",
  stamp: null,
  fields: [],
  number: 1,
};
const FRIEND = {
  tier: "朋友",
  tier_label: "朋友 I",
  closeness: "不錯",
  trust: "有點信任",
  familiarity: "見過幾次",
  public_feeling: null,
};

class FakeWallet implements CardWallet {
  readonly balances = new Map<PersonId, number>();
  readonly charges: { person: PersonId; amount: number; reason: string; key: string }[] = [];
  readonly refunds: { person: PersonId; receipt: string }[] = [];

  async balance({ person }: CardPayer) {
    return this.balances.get(person) ?? 0;
  }

  async spend({ person }: CardPayer, amount: number, reason: string, key: string) {
    const balance = this.balances.get(person) ?? 0;
    if (balance < amount) return { ok: false as const, reason: "insufficient" as const, balance };
    this.balances.set(person, balance - amount);
    this.charges.push({ person, amount, reason, key });
    return { ok: true as const, receipt: `r-${key}`, balance: balance - amount };
  }

  async refund({ person }: CardPayer, receipt: string) {
    const charge = this.charges.find((c) => `r-${c.key}` === receipt);
    this.balances.set(person, (this.balances.get(person) ?? 0) + (charge?.amount ?? 0));
    this.refunds.push({ person, receipt });
  }
}

/** The person paying through a Discord account of theirs. */
const payer = (person: PersonId): CardPayer => ({
  person,
  account: { platform: "discord", id: `acc-${person}` },
});
const face = async () => FACE;

let t: TestDb;
let store: CardStore;
let wallet: FakeWallet;
let now: number;
let serials: number;

beforeEach(() => {
  now = T0;
  serials = 0;
  t = openTestDb({ identity: true, plugins: [cardsSchema], clock: { now: () => now } });
  store = new CardStore(t.db, t.events);
  wallet = new FakeWallet();
});

afterEach(() => t.close());

function service(overrides: Partial<CardServiceOptions> = {}): CardService {
  return new CardService(store, {
    config: cardsConfig(),
    clock: { now: () => now },
    wallet: () => wallet,
    relationship: () => FRIEND,
    random: seededRandom(1),
    newSerial: () => `MYR-TEST-0000-${String(++serials).padStart(4, "0")}`,
    ...overrides,
  });
}

/** One card straight through the store: `random` always 0 gives an N card, the first parts. */
function issue(person: PersonId, overrides: Partial<IssueInput> = {}) {
  return store.issue({
    person,
    kind: "daily",
    serial: `MYR-DRAW-0000-${String(++serials).padStart(4, "0")}`,
    price: 30,
    face: FACE,
    relationship: FRIEND,
    rules: drawRules(cardsConfig()),
    random: () => 0,
    now,
    ...overrides,
  });
}

function events(type: string) {
  return t.events.query({ types: [type], order: "asc", limit: 1000 }).map((e) => e.envelope);
}

describe("the catalogue", () => {
  it("is seeded with every part of SEED_PARTS, as they are", () => {
    const byId = (a: Part, b: Part) => (a.id < b.id ? -1 : 1);
    expect([...store.catalogue()].sort(byId)).toEqual([...SEED_PARTS].sort(byId));
  });
});

describe("a daily card", () => {
  it("costs the price, the first card of the day too", async () => {
    wallet.balances.set("p1", 100);
    const result = await service().issueDaily(payer("p1"), face);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(wallet.charges).toEqual([
      { person: "p1", amount: 30, reason: "card_daily", key: result.issued.card.serial },
    ]);
    expect(wallet.balances.get("p1")).toBe(70);
    const card = store.card(result.issued.card.serial);
    expect(card).toMatchObject({
      person: "p1",
      kind: "daily",
      price: 30,
      face: FACE,
      relationship: FRIEND,
    });
    expect(card?.parts).toHaveLength(5);
  });

  it("stops at five a day, without charging the sixth, and starts again the next local day", async () => {
    wallet.balances.set("p1", 1000);
    const cards = service();
    for (let i = 0; i < 5; i++) expect((await cards.issueDaily(payer("p1"), face)).ok).toBe(true);
    expect(await cards.issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "daily_cap",
      cap: 5,
    });
    expect(wallet.charges).toHaveLength(5);
    expect(cards.dailyLeft("p1")).toBe(0);
    // Someone else is not affected.
    wallet.balances.set("p2", 30);
    expect((await cards.issueDaily(payer("p2"), face)).ok).toBe(true);
    // Her day starts at midnight UTC+8 (16:00 UTC).
    now = dayStart(T0, 480) + DAY;
    expect(cards.dailyLeft("p1")).toBe(5);
    expect((await cards.issueDaily(payer("p1"), face)).ok).toBe(true);
  });

  it("holds the cap when several are asked for at once", async () => {
    wallet.balances.set("p1", 1000);
    const cards = service();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => cards.issueDaily(payer("p1"), face)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(wallet.charges).toHaveLength(5);
  });

  it("is refused without enough coins, and nothing is written", async () => {
    wallet.balances.set("p1", 29);
    expect(await service().issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "insufficient",
      price: 30,
      balance: 29,
    });
    expect(store.cards("p1")).toEqual([]);
    expect(store.pitySince("p1")).toBe(0);
    expect(events("cards.drawn")).toEqual([]);
  });

  it("is refused without a wallet, unless it is free", async () => {
    expect(await service({ wallet: () => null }).issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "no_wallet",
    });
    const free = service({ wallet: () => null, config: cardsConfig({ price: 0 }) });
    expect((await free.issueDaily(payer("p1"), face)).ok).toBe(true);
  });

  it("gives the coins back when the card cannot be written", async () => {
    wallet.balances.set("p1", 30);
    t.db.run("UPDATE cards_parts SET enabled = 0");
    await expect(service().issueDaily(payer("p1"), face)).rejects.toThrow(/nothing to draw/);
    expect(wallet.refunds).toHaveLength(1);
    expect(wallet.balances.get("p1")).toBe(30);
    expect(store.cards("p1")).toEqual([]);
  });

  it("writes cards.drawn in her DM scope with the card's parts", async () => {
    wallet.balances.set("p1", 30);
    const result = await service().issueDaily(payer("p1"), face);
    if (!result.ok) throw new Error("refused");
    const [event] = events("cards.drawn");
    expect(event).toMatchObject({ person_id: "p1", scope: "dm", tier: "long", source: "cards" });
    expect(event?.data).toMatchObject({
      serial: result.issued.card.serial,
      rarity: result.issued.card.rarity,
      parts: result.issued.card.parts.map((p) => p.id),
      pity_hit: false,
      pity_since: result.issued.pity.since,
      wished: [],
      price: 30,
    });
  });
});

describe("a milestone card", () => {
  const friends = { min: 15, label: "朋友" } as const;
  const occasion = (faces: number[]) => async () => {
    faces.push(1);
    return { face: FACE, relationship: FRIEND };
  };

  it("is free, once per tier, outside the day's cap and the pity", async () => {
    wallet.balances.set("p1", 1000);
    const cards = service();
    for (let i = 0; i < 5; i++) await cards.issueDaily(payer("p1"), face);
    const pity = store.pitySince("p1");
    const asked: number[] = [];
    const first = await cards.issueMilestone("p1", friends, occasion(asked));
    if (!first.ok) throw new Error("refused");
    expect(first.issued.again).toBe(false);
    expect(first.issued.card).toMatchObject({
      kind: "milestone",
      price: 0,
      issue_key: "milestone:15",
      pity_hit: false,
    });
    expect(wallet.charges).toHaveLength(5);
    expect(store.pitySince("p1")).toBe(pity);
    expect(cards.dailyLeft("p1")).toBe(0);
    // Asked again (down and up again, or a restart): the same card, her words not asked for.
    const again = await service().issueMilestone("p1", friends, occasion(asked));
    expect(again.ok && again.issued).toMatchObject({ again: true, card: first.issued.card });
    expect(asked).toHaveLength(1);
    expect(store.cards("p1").filter((c) => c.kind === "milestone")).toHaveLength(1);
    // Another tier is another card.
    expect(
      (await cards.issueMilestone("p1", { min: 45, label: "好朋友" }, occasion(asked))).ok,
    ).toBe(true);
    expect(events("cards.drawn").at(-1)?.data).toMatchObject({ kind: "milestone", price: 0 });
  });

  it("is only for a tier above 認識 on the ladder, and not without a face", async () => {
    const cards = service();
    const asked: number[] = [];
    for (const tier of [
      { min: 0, label: "認識" },
      { min: 16, label: "朋友" },
      { min: 15, label: "好朋友" },
    ] as const) {
      expect(await cards.issueMilestone("p1", tier, occasion(asked))).toEqual({
        ok: false,
        reason: "not_eligible",
      });
    }
    expect(await cards.issueMilestone("p1", friends, async () => null)).toEqual({
      ok: false,
      reason: "no_face",
    });
    expect(asked).toEqual([]);
    expect(store.cards("p1")).toEqual([]);
  });
});

describe("a keepsake card", () => {
  const LEGACY = { first_seen: "2025-03-01T00:00:00.000Z", old_tier: "摯友", cards: 4 };
  const migrated = (p: PersonId) => store.importedLegacy(p) !== null;
  const words = async () => ({ face: FACE, relationship: FRIEND });

  it("is for someone the import brought, once, free and outside the pity", async () => {
    t.db.run(
      "INSERT INTO persons (id, name, handle, created_at, legacy) VALUES ('p9', '小九', '小九', 1, $legacy)",
      { legacy: JSON.stringify(LEGACY) },
    );
    expect(store.importedLegacy("p9")).toEqual(LEGACY);
    expect(store.importedLegacy("p1")).toBeNull();
    const cards = service({ migrated });
    expect(await cards.keepsake("p1", words)).toEqual({ ok: false, reason: "not_eligible" });
    // Nobody is from before without being told who.
    expect(await service().keepsake("p9", words)).toEqual({ ok: false, reason: "not_eligible" });
    const first = await cards.keepsake("p9", words);
    if (!first.ok) throw new Error("refused");
    expect(first.issued.card).toMatchObject({ kind: "keepsake", price: 0, issue_key: "keepsake" });
    expect(store.pitySince("p9")).toBe(0);
    expect(wallet.charges).toEqual([]);
    const again = await cards.keepsake("p9", async () => {
      throw new Error("not asked again");
    });
    expect(again.ok && again.issued.again).toBe(true);
    expect(store.cards("p9")).toHaveLength(1);
  });
});

describe("the pity", () => {
  it("counts up to 20 and gives SR or better on the 21st, then starts again", () => {
    for (let i = 1; i <= 20; i++) {
      const issued = issue("p1");
      expect(issued.card.rarity).toBe("N");
      expect(issued.pity).toEqual({ since: i, pity: 20, until: 20 - i });
    }
    const hit = issue("p1");
    expect(["SR", "SSR"]).toContain(hit.card.rarity);
    expect(hit.card.pity_hit).toBe(true);
    expect(hit.pity.since).toBe(0);
    expect(store.pitySince("p1")).toBe(0);
    const drawn = events("cards.drawn");
    expect(drawn.at(-1)?.data).toMatchObject({ pity_hit: true, pity_since: 0 });
    expect(drawn.filter((e) => (e.data as { pity_hit: boolean }).pity_hit)).toHaveLength(1);
  });
});

describe("the dex", () => {
  it("collects parts, not blanks, and counts repeats", () => {
    const first = issue("p1");
    const second = issue("p1");
    const collected = first.card.parts.filter((p) => !p.blank).map((p) => p.id);
    expect(first.new_parts).toEqual(collected);
    expect(second.new_parts).toEqual([]);
    const dex = service().dex("p1");
    expect(dex.parts.map((p) => [p.part, p.count]).sort()).toEqual(
      collected.map((id) => [id, 2]).sort(),
    );
    expect(dex.parts.every((p) => p.first_card === first.card.serial)).toBe(true);
    expect(dex.parts.some((p) => p.part.endsWith(".none"))).toBe(false);
  });

  it("gives a series' title once, on the card that completes it", () => {
    // The 眼鏡系列 is the plain glasses and the monocle; they already have the monocle.
    t.db.run(
      "INSERT INTO cards_dex (person_id, part_id, first_at, count) VALUES ('p1', 'accessory.monocle', 1, 1)",
    );
    const issued = issue("p1");
    expect(issued.card.parts.map((p) => p.id)).toContain("accessory.glasses");
    expect(issued.titles).toMatchObject([{ series: "glasses", title: "眼鏡控", public: false }]);
    expect(issue("p1").titles).toEqual([]);
    const dex = service().dex("p1");
    expect(dex.titles).toHaveLength(1);
    expect(dex.series.find((s) => s.id === "glasses")).toMatchObject({
      owned: 2,
      total: 2,
      complete: true,
    });
    expect(events("cards.titled").map((e) => e.data)).toEqual([
      { person: "p1", series: "glasses", title: "眼鏡控", serial: issued.card.serial },
    ]);
  });
});

describe("the wishlist", () => {
  it("holds up to three parts, each once, each collectable", () => {
    const cards = service();
    expect(cards.setWishlist("p1", ["pose.sway", "pose.shy", "pose.front"])).toBeNull();
    expect(cards.wishlist("p1")).toEqual(["pose.sway", "pose.shy", "pose.front"]);
    expect(cards.setWishlist("p1", ["pose.sway", "pose.shy", "pose.front", "pose.look_up"])).toBe(
      "too_many",
    );
    expect(cards.setWishlist("p1", ["pose.sway", "pose.sway"])).toBe("duplicate");
    expect(cards.setWishlist("p1", ["pose.moonwalk"])).toBe("unknown_part");
    expect(cards.setWishlist("p1", ["hand.none"])).toBe("unknown_part");
    // A refused list leaves the old one.
    expect(cards.wishlist("p1")).toEqual(["pose.sway", "pose.shy", "pose.front"]);
    expect(cards.setWishlist("p1", ["background.aurora"])).toBeNull();
    expect(cards.wishlist("p1")).toEqual(["background.aurora"]);
    cards.clearWishlist("p1");
    expect(cards.wishlist("p1")).toEqual([]);
  });

  it("flags a draw with a wished part, and changes nothing about the draw", () => {
    const plain = issue("p2");
    const wished = plain.card.parts.find((p) => !p.blank)?.id as string;
    service().setWishlist("p1", ["background.aurora", wished]);
    const card = issue("p1").card;
    expect(card.parts).toEqual(plain.card.parts);
    expect(card.wished).toEqual([wished]);
    expect(events("cards.drawn").at(-1)?.data).toMatchObject({ wished: [wished] });
  });
});

describe("a person", () => {
  it("forgotten loses every row of theirs, nobody else's", () => {
    issue("p1");
    issue("p2");
    service().setWishlist("p1", ["pose.sway"]);
    const counts = store.forgetPerson(["p1"]);
    expect(counts).toMatchObject({ cards_card: 1, cards_pity: 1, cards_wishlist: 1 });
    expect(store.cards("p1")).toEqual([]);
    expect(store.dex("p1")).toEqual([]);
    expect(store.cards("p2")).toHaveLength(1);
  });

  it("merged into another keeps the cards, adds up the dex and keeps the longer pity run", () => {
    for (let i = 0; i < 3; i++) issue("a");
    issue("k");
    store.merge("k", "a");
    expect(store.cards("k")).toHaveLength(4);
    expect(store.cards("a")).toEqual([]);
    expect(store.pitySince("k")).toBe(3);
    expect(store.dex("k").every((e) => e.count === 4)).toBe(true);
    expect(store.dex("a")).toEqual([]);
  });
});
