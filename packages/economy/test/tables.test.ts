// The economy plugin's tables (`tables.ts`): the coin ledger's guarantees, the wallets' choices,
// the deals, and the economy's tables as data categories. A wallet is a person (with whoever they
// absorbed) or her purse. One database is one character: the profile a caller names is not part
// of any key.

import {
  type PluginContext,
  resolveCategories,
  SqliteStore,
  StoreError,
  type StorePlugin,
} from "@miyoria/store";
import { type AccountRef, newId, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type CoinEntry, type Deal, PURSE } from "../src/records.js";
import { type EconomyTables, economyTables } from "../src/tables.js";

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

/** The store's connection and identity, for what only SQL can show. */
const probe: StorePlugin<PluginContext> = {
  schema: { plugin: "probe", migrations: [] },
  open: (ctx) => ctx,
};

interface Rig {
  store: SqliteStore;
  economy: EconomyTables;
  ctx: PluginContext;
  /** A person seen on `account` (made on first sight). */
  person(account: AccountRef, name?: string): PersonId;
}

async function rig(): Promise<Rig> {
  const store = await SqliteStore.open(":memory:", { plugins: [economyTables] });
  stores.push(store);
  return {
    store,
    economy: store.plugin(economyTables),
    ctx: store.plugin(probe),
    person: (account, name = account.id) => store.persons.see(account, name).id,
  };
}

const discord = (id: string): AccountRef => ({ platform: "discord", id });
const at = (ms: number): Timestamp => toTimestamp(ms);

function coin(
  person: PersonId,
  delta: number,
  reason: string,
  key: string | null,
  ms: number,
): CoinEntry {
  return { id: newId(), person, delta, reason, ref: null, idem_key: key, ts: at(ms) };
}

describe("the coin ledger", () => {
  it("is a wallet's sum, a key once per wallet, the caps and the balance in one transaction", async () => {
    const { economy, person, store } = await rig();
    const ledger = economy.ledger;
    const id = person(discord("1"));
    const absorbed = person(discord("1b"));
    const other = person(discord("2"));

    const first = await ledger.post(coin(id, 10, "checkin", "checkin:1", 1_000));
    expect(first).toMatchObject({ status: "posted", balance: 10 });
    // Someone else's key is theirs.
    expect((await ledger.post(coin(other, 5, "checkin", "checkin:1", 2_000))).status).toBe(
      "posted",
    );
    // The person she later learns is the same one: their rows are the wallet's, and their key
    // was the wallet's click.
    await ledger.post(coin(absorbed, 2, "talked", "t:1", 2_500));
    store.persons.merge(id, absorbed);
    const again = await ledger.post(coin(absorbed, 10, "checkin", "checkin:1", 2_600));
    expect(again.status).toBe("duplicate");
    expect(again.status === "duplicate" && again.entry.id).toBe(
      first.status === "posted" && first.entry.id,
    );
    expect(again).toMatchObject({ balance: 12 });
    expect(await ledger.balance("p", absorbed)).toBe(12);

    // Caps: the voice cap is 4, the second earning gets what fits, the third nothing.
    const cap = { wallet: id, reasons: ["voice"], since: at(0), limit: 4 };
    const capped = { caps: [cap], partial: true };
    expect(await ledger.post(coin(id, 3, "voice", "v:1", 3_000), capped)).toMatchObject({
      status: "posted",
      balance: 15,
    });
    const part = await ledger.post(coin(id, 3, "voice", "v:2", 4_000), capped);
    expect(part).toMatchObject({ status: "posted", balance: 16 });
    expect(part.status === "posted" && part.entry.delta).toBe(1);
    expect(await ledger.post(coin(id, 3, "voice", "v:3", 5_000), capped)).toMatchObject({
      status: "capped",
      balance: 16,
    });
    // A cap over everyone (`wallet: null`), not partial.
    const total = { wallet: null, reasons: ["checkin"], since: at(0), limit: 16 };
    expect((await ledger.post(coin(id, 2, "checkin", null, 5_000), { caps: [total] })).status).toBe(
      "capped",
    );

    // Spending needs the coins.
    expect(await ledger.post(coin(id, -20, "feed", "f:1", 6_000), { covered: true })).toMatchObject(
      { status: "short", balance: 16 },
    );
    expect(await ledger.post(coin(id, -16, "feed", "f:2", 7_000), { covered: true })).toMatchObject(
      { status: "posted", balance: 0 },
    );
    await expect(ledger.post(coin(id, 1.5, "feed", null, 7_000))).rejects.toThrow(/whole/);

    expect(await ledger.balance("p", id)).toBe(0);
    expect(await ledger.balance("p", other)).toBe(5);
    expect(await ledger.balance("p", "nobody")).toBe(0);
    // One database is one character: another profile names the same wallet.
    expect(await ledger.balance("other", other)).toBe(5);

    const all = await ledger.entries("p", id, { limit: 10 });
    expect(all.map((e) => e.idem_key)).toEqual(["f:2", "v:2", "v:1", "t:1", "checkin:1"]);
    expect(all[0]).toMatchObject({ delta: -16, reason: "feed", person: id });
    expect(Date.parse(all[0]?.ts ?? "")).toBe(7_000);
    expect((await ledger.entries("p", id, { reasons: ["voice"], limit: 10 })).length).toBe(2);
    expect((await ledger.entries("p", id, { since: at(3_500), limit: 10 })).length).toBe(2);
    expect(await ledger.entries("p", id, { limit: 1 })).toHaveLength(1);
    expect(await ledger.entries("p", id, { reasons: [], limit: 9 })).toEqual([]);
    expect((await ledger.byKey("p", id, "v:2"))?.delta).toBe(1);
    expect(await ledger.byKey("p", other, "v:2")).toBeNull();
  });

  it("never takes a balance below zero, whatever runs at once", async () => {
    const { economy, person } = await rig();
    const id = person(discord("1"));
    await economy.ledger.post(coin(id, 30, "checkin", null, 1_000));
    const spends = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        economy.ledger.post(coin(id, -10, "feed", `f:${i}`, 2_000 + i), { covered: true }),
      ),
    );
    expect(spends.filter((s) => s.status === "posted")).toHaveLength(3);
    expect(await economy.ledger.balance("p", id)).toBe(0);
  });

  it("keeps a wallet nobody knows to itself, and her purse apart", async () => {
    const { economy, person } = await rig();
    const id = person(discord("1"));
    // As an account nobody saw had rows before: its own, never anyone's, never a spender.
    await economy.ledger.post(coin("nobody", 5, "checkin", null, 1_000));
    await economy.ledger.post(coin("nobody", -2, "feed", null, 1_000));
    expect(await economy.ledger.balance("p", "nobody")).toBe(3);
    expect(await economy.ledger.spent("p", ["feed"], at(0), 10)).toEqual([]);
    await economy.ledger.post(coin(PURSE, 7, "her_share", "share:x", 1_000));
    await economy.ledger.post(coin(PURSE, -3, "purse_treat", "treat:x", 2_000));
    expect(await economy.ledger.balance("p", PURSE)).toBe(4);
    expect(await economy.ledger.balance("p", id)).toBe(0);
    // Her keys are hers.
    expect((await economy.ledger.post(coin(PURSE, 7, "her_share", "share:x", 3_000))).status).toBe(
      "duplicate",
    );
    expect((await economy.ledger.post(coin(id, 7, "her_share", "share:x", 3_000))).status).toBe(
      "posted",
    );
    // What she spends is never on the sponsor board.
    expect(await economy.ledger.spent("p", ["purse_treat"], at(0), 10)).toEqual([]);
  });

  it("keeps the order rows were written in, also within one instant", async () => {
    const { economy, person } = await rig();
    const id = person(discord("1"));
    for (const key of ["a", "b", "c"]) await economy.ledger.post(coin(id, 1, "talked", key, 5_000));
    const rows = await economy.ledger.entries("p", id, { limit: 9 });
    expect(rows.map((r) => r.idem_key)).toEqual(["c", "b", "a"]);
    // The first row of a key is the earliest written (the key is unique, so there is one).
    expect((await economy.ledger.byKey("p", id, "a"))?.idem_key).toBe("a");
  });

  it("writes a posting and its checks together, inside a caller's transaction too", async () => {
    const { economy, person, ctx } = await rig();
    const id = person(discord("1"));
    await economy.ledger.post(coin(id, 10, "checkin", null, 1_000));
    // The caller's transaction fails after the posting: the posting goes with it.
    expect(() =>
      ctx.db.tx(() => {
        void economy.ledger.post(coin(id, -10, "feed", "f:1", 2_000), { covered: true });
        throw new Error("the caller failed");
      }),
    ).toThrow(/the caller failed/);
    expect(await economy.ledger.balance("p", id)).toBe(10);
    expect(await economy.ledger.byKey("p", id, "f:1")).toBeNull();
  });

  it("holds its keys, ids and whole numbers in the table itself", async () => {
    const { economy, person, ctx } = await rig();
    const id = person(discord("1"));
    const row = coin(id, 10, "checkin", "checkin:1", 1_000);
    await economy.ledger.post(row);
    const insert = (fields: Partial<Record<string, unknown>>) =>
      ctx.db.run(
        "INSERT INTO economy_ledger (id, person_id, delta, reason, ref, idem_key, ts) " +
          "VALUES ($id, $person, $delta, 'checkin', NULL, $key, 1)",
        { id: newId(), person: id, delta: 1, key: null, ...fields } as never,
      );
    // A key twice in one wallet, past the code's check.
    expect(() => insert({ key: "checkin:1" })).toThrow(/UNIQUE/);
    // A row id twice (a transfer's in row is its out row's id plus `~in`: written once).
    expect(() => insert({ id: row.id })).toThrow(/UNIQUE/);
    await expect(economy.ledger.post({ ...row, idem_key: null })).rejects.toThrow(StoreError);
    // A fraction of a coin (STRICT).
    expect(() => insert({ delta: 1.5 })).toThrow(/INTEGER/);
    // No key is no key: rows without one are never the same click.
    insert({});
    insert({});
    expect(await economy.ledger.balance("p", id)).toBe(12);
  });

  it("adds up a local day per reason, issued and recovered, all wallets", async () => {
    const { economy, person } = await rig();
    const x = person(discord("1"));
    const y = person(discord("2"));
    const base = Date.UTC(2026, 10, 3); // a UTC midnight
    const post = (who: PersonId, delta: number, reason: string, ms: number) =>
      economy.ledger.post(coin(who, delta, reason, null, ms));
    await post(x, 10, "checkin", base + HOUR);
    await post(y, 5, "checkin", base + 2 * HOUR);
    await post(x, 3, "talked", base + 22 * HOUR);
    await post(x, -4, "feed", base + 23 * HOUR);
    await post(y, -6, "feed", base + DAY + HOUR);
    await post(y, 8, "checkin", base + 2 * DAY);
    await post(y, 7, "checkin", base - DAY); // before `since`
    const since = at(base);
    const d0 = Math.floor(base / DAY);

    // UTC: rows of one reason are added across wallets.
    expect(await economy.ledger.dailyTotals("p", since, 0)).toEqual([
      { day: d0, reason: "checkin", positive: 15, negative: 0 },
      { day: d0, reason: "feed", positive: 0, negative: 4 },
      { day: d0, reason: "talked", positive: 3, negative: 0 },
      { day: d0 + 1, reason: "feed", positive: 0, negative: 6 },
      { day: d0 + 2, reason: "checkin", positive: 8, negative: 0 },
    ]);

    // Two hours east: the 22:00 and 23:00 rows fall on the next local day.
    const east = await economy.ledger.dailyTotals("p", since, 120);
    expect(east.filter((r) => r.day === d0)).toEqual([
      { day: d0, reason: "checkin", positive: 15, negative: 0 },
    ]);
    expect(
      east.filter((r) => r.day === d0 + 1).map((r) => [r.reason, r.positive, r.negative]),
    ).toEqual([
      ["feed", 0, 10],
      ["talked", 3, 0],
    ]);
  });

  it("adds what a person spent across whoever they absorbed, by their first account", async () => {
    const { economy, person, store } = await rig();
    const id = person(discord("1"), "Alice");
    const absorbed = person(discord("1b"), "Alice two");
    const bob = person(discord("2"), "Bob");
    await economy.ledger.post(coin(id, -30, "feed", null, 1_000));
    await economy.ledger.post(coin(absorbed, -20, "letter", null, 2_000));
    await economy.ledger.post(coin(bob, -10, "feed", null, 3_000));
    store.persons.merge(id, absorbed);
    expect(await economy.ledger.spent("p", ["feed", "letter"], at(0), 10)).toEqual([
      { person: id, account: discord("1"), spent: 50 },
      { person: bob, account: discord("2"), spent: 10 },
    ]);
  });
});

describe("the wallets", () => {
  it("keep the frame chosen last and who left the board, for the person as a whole", async () => {
    const { economy, person, store } = await rig();
    const ledger = economy.ledger;
    const id = person(discord("1"));
    const absorbed = person(discord("1b"));
    const other = person(discord("2"));

    expect(await ledger.selectedFrame("p", id)).toBeNull();
    await ledger.selectFrame("p", id, "sakura", at(1_000));
    await ledger.selectFrame("p", absorbed, "gold", at(2_000));
    store.persons.merge(id, absorbed);
    // The latest choice of anyone in the wallet.
    expect(await ledger.selectedFrame("p", id)).toBe("gold");
    await ledger.selectFrame("p", id, null, at(3_000));
    expect(await ledger.selectedFrame("p", id)).toBeNull();
    await ledger.selectFrame("p", id, "sakura", at(4_000));

    // The board is on unless they left; leaving keeps the frame.
    expect(await ledger.onBoard("p", id)).toBe(true);
    expect(await ledger.offBoard("p", 10)).toEqual([]);
    await ledger.setOnBoard("p", id, false);
    expect(await ledger.onBoard("p", id)).toBe(false);
    expect(await ledger.onBoard("p", absorbed)).toBe(false);
    expect(await ledger.onBoard("p", other)).toBe(true);
    expect(await ledger.offBoard("p", 10)).toEqual([id]);
    expect(await ledger.selectedFrame("p", id)).toBe("sakura");
    await ledger.setOnBoard("p", id, true);
    expect(await ledger.onBoard("p", id)).toBe(true);
    expect(await ledger.offBoard("p", 10)).toEqual([]);
    await expect(ledger.selectFrame("p", "nobody", "gold", at(5_000))).rejects.toThrow(StoreError);
  });
});

describe("the deals", () => {
  it("are kept per account, statuses move once and only from where they were", async () => {
    const { economy, person } = await rig();
    const deals = economy.deals;
    const mine = discord("1");
    const linked = discord("1b");
    const other = discord("2");
    for (const a of [mine, linked, other]) person(a);
    const wallet = [mine, linked];
    const deal = (account: AccountRef, ms: number, task: string): Deal => ({
      id: newId(),
      account,
      item: "rice",
      count: 2,
      value: 20,
      task,
      prepaid: false,
      escrow: null,
      status: "open",
      created_at: at(ms),
      done_at: null,
      due_at: null,
      closed_at: null,
    });
    const first = deal(mine, 1_000, "meow");
    const second = deal(linked, 2_000, "sing");
    const third = deal(other, 3_000, "dance");
    for (const d of [first, second, third]) await deals.create(d);
    expect(await deals.get(first.id)).toEqual(first);
    expect(await deals.get(newId())).toBeNull();

    // Every account of the person; newest first.
    const ours = await deals.forAccounts("p", wallet, { limit: 10 });
    expect(ours.map((d) => d.task)).toEqual(["sing", "meow"]);
    expect(await deals.forAccounts("p", wallet, { limit: 1 })).toHaveLength(1);
    expect(await deals.forAccounts("p", wallet, { since: at(1_500), limit: 9 })).toEqual([second]);
    expect(await deals.forAccounts("p", [], { limit: 9 })).toEqual([]);
    expect(await deals.forAccounts("p", wallet, { statuses: [], limit: 9 })).toEqual([]);
    expect(await deals.forAccounts("p", [discord("never")], { limit: 9 })).toEqual([]);
    // One database is one character: another profile sees the same deals.
    expect(await deals.forAccounts("other", wallet, { limit: 9 })).toHaveLength(2);

    // A status moves once, from where it was, with the times it sets.
    const done = { status: "owed" as const, done_at: at(5_000), due_at: at(9_000) };
    expect(await deals.transition(first.id, ["open"], done)).toBe(true);
    expect(await deals.transition(first.id, ["open"], done)).toBe(false);
    expect(await deals.transition(first.id, [], done)).toBe(false);
    expect(await deals.transition(newId(), ["open"], done)).toBe(false);
    expect(await deals.get(first.id)).toMatchObject({
      status: "owed",
      done_at: at(5_000),
      due_at: at(9_000),
      closed_at: null,
    });
    // Fields left out stay, `null` clears.
    expect(
      await deals.transition(first.id, ["owed"], {
        status: "broken",
        closed_at: at(9_500),
        due_at: null,
      }),
    ).toBe(true);
    expect(await deals.get(first.id)).toMatchObject({
      status: "broken",
      done_at: at(5_000),
      due_at: null,
      closed_at: at(9_500),
    });

    const open = await deals.byStatus("p", ["open", "owed"], { limit: 10 });
    expect(open.map((d) => d.task)).toEqual(["sing", "dance"]);
    expect(await deals.byStatus("p", ["broken"], { limit: 10 })).toHaveLength(1);
    expect(await deals.byStatus("p", [], { limit: 10 })).toEqual([]);
    expect(await deals.byStatus("p", ["open"], { since: at(2_500), limit: 10 })).toEqual([third]);
    const broken = await deals.forAccounts("p", wallet, { statuses: ["broken"], limit: 10 });
    expect(broken.map((d) => d.id)).toEqual([first.id]);

    // A prepaid deal keeps its escrow row; an account she never saw is made on first use.
    const paid = { ...deal(discord("new"), 4_000, "escrowed"), prepaid: true, escrow: newId() };
    await deals.create(paid);
    expect(await deals.get(paid.id)).toMatchObject({ prepaid: true, escrow: paid.escrow });
  });
});

describe("as data", () => {
  it("are counted, exported and wiped with the relationships, and go with their person", async () => {
    const { economy, person, store } = await rig();
    const id = person(discord("1"));
    await economy.ledger.post(coin(id, 10, "checkin", null, 1_000));
    await economy.ledger.post(coin(PURSE, 3, "her_share", null, 1_000));
    await economy.ledger.setOnBoard("p", id, false);
    await economy.deals.create({
      id: newId(),
      account: discord("1"),
      item: "rice",
      count: 1,
      value: 10,
      task: "t",
      prepaid: false,
      escrow: null,
      status: "open",
      created_at: at(1_000),
      done_at: null,
      due_at: null,
      closed_at: null,
    });
    const parts = async () =>
      (await store.profileData.inventory("p")).categories
        .find((c) => c.id === "relationships")
        ?.parts.filter((p) => ["coin_ledger", "coin_wallets", "deals"].includes(p.id))
        .map((p) => [p.id, p.count]);
    expect(await parts()).toEqual([
      ["coin_ledger", 2],
      ["coin_wallets", 1],
      ["deals", 1],
    ]);
    const backup = await store.profileData.export("p", ["relationships"]);
    expect(backup.parts.coin_ledger?.map((r) => [r.person_id, r.delta])).toEqual([
      [id, 10],
      [PURSE, 3],
    ]);
    expect(await store.profileData.wipe("p", ["relationships"])).toMatchObject({
      coin_ledger: 2,
      coin_wallets: 1,
      deals: 1,
    });
    expect(await parts()).toEqual([
      ["coin_ledger", 0],
      ["coin_wallets", 0],
      ["deals", 0],
    ]);
    // People go after what names them.
    expect(resolveCategories(["people"])).toContain("relationships");
  });
});
