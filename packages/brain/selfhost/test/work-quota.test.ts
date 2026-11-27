// Each person's sandbox CPU seconds: the same machinery as the AI quota in a second instance,
// kept in the same table under `~cpu:` so the two never meet.

import { SqliteStore, StoreKey } from "@miyoria/store";
import { Principals } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../agent/src/index.js";
import { PersonQuota } from "../../self/src/index.js";
import { quotaTables, WORK_KEY_PREFIX } from "../src/quota-store.js";
import { hostWorkQuota } from "../src/work-quota.js";
import { account, channel } from "./harness.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.UTC(2026, 10, 23, 4);
const AMY = account("amy");
const BEA = account("bea");
const OWN = account("own");
const C1 = channel("c1");

let stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
});

async function open() {
  const store = await SqliteStore.open(":memory:", { plugins: [quotaTables] });
  stores.push(store);
  return store;
}

function agentOf(
  store: SqliteStore | null,
  quota: Partial<{ person_cpu_seconds_per_hour: number; person_cpu_seconds_per_day: number }> = {},
) {
  const config = {
    quota: { person_cpu_seconds_per_hour: 100, person_cpu_seconds_per_day: 250, ...quota },
  };
  const authorizer = {
    allows: (a: { id: string }) => a.id === "own",
    isOwner: (a: { id: string }) => a.id === "own",
  };
  const agent = {
    config,
    log: { warn: () => undefined },
    attitude: (a: { id: string }) => (a.id === "amy" ? { person: "p-amy" } : null),
    ctx: { services: { get: (key: unknown) => (key === StoreKey ? store : authorizer) } },
  };
  return { agent: agent as unknown as Agent, config };
}

describe("the work quota", () => {
  it("counts CPU seconds in a rolling hour and in her day, and a restart keeps them", async () => {
    const store = await open();
    const { agent } = agentOf(store);
    const q = hostWorkQuota(agent, null);
    const payer = { person: "p-amy" };
    q.charge(payer, T - 90 * MINUTE, 40);
    q.charge(payer, T - 30 * MINUTE, 25.5);
    expect(q.used("p-amy", T)).toEqual({ hour: 25.5, day: 65.5 });
    expect(q.used("p-bea", T)).toEqual({ hour: 0, day: 0 });
    // A new quota over the same table (a restart) reads the same numbers.
    const again = hostWorkQuota(agent, null);
    expect(again.used("p-amy", T)).toEqual({ hour: 25.5, day: 65.5 });
    // Her day is over: the day starts again, the hour is long gone.
    expect(again.used("p-amy", T + 24 * HOUR)).toEqual({ hour: 0, day: 0 });
  });

  it("stops at the hourly limit, says so once, and is under it again when the hour moves on", async () => {
    const { agent } = agentOf(await open());
    const q = hostWorkQuota(agent, null);
    const payer = { person: "p-amy" };
    q.charge(payer, T, 60);
    expect(q.capped(payer, T + MINUTE)).toBeNull();
    q.charge(payer, T + 10 * MINUTE, 40);
    const cap = q.capped(payer, T + 11 * MINUTE);
    expect(cap).toMatchObject({ which: "hour", limit: 100, first: true });
    expect(cap?.used.hour).toBeCloseTo(100, 6);
    // When the first minute's 60 seconds leave the hour, 40 are left: under.
    expect(cap?.until).toBe(Math.floor(T / MINUTE) * MINUTE + HOUR);
    expect(q.claimNotice("p-amy")).toBe(true);
    expect(q.claimNotice("p-amy")).toBe(false);
    expect(q.capped(payer, T + 12 * MINUTE)).toMatchObject({ first: false });
    // Someone else is not held.
    expect(q.capped({ person: "p-bea" }, T + 12 * MINUTE)).toBeNull();
    expect(q.capped(payer, T + HOUR + MINUTE)).toBeNull();
  });

  it("stops at the daily limit with the day's own time, before the hour's", async () => {
    const { agent } = agentOf(await open());
    const q = hostWorkQuota(agent, null);
    const payer = { person: "p-amy" };
    for (let i = 0; i < 3; i++) q.charge(payer, T + i * 2 * HOUR, 90);
    const now = T + 6 * HOUR;
    const cap = q.capped(payer, now);
    expect(cap).toMatchObject({ which: "day", limit: 250 });
    expect(cap?.until).toBe(Date.UTC(2026, 10, 24));
  });

  it("counts the owner but never caps them, and nobody's own work is charged to anyone", async () => {
    const store = await open();
    const { agent } = agentOf(store);
    const q = hostWorkQuota(agent, null);
    const owner = q.payerOf(Principals.user(OWN, C1));
    expect(owner).toEqual({ person: "test:own", exempt: true });
    q.charge(owner, T, 100_000);
    expect(q.capped(owner, T)).toBeNull();
    expect(q.used("test:own", T).hour).toBe(100_000);
    // Her own call, with nobody behind it, has no payer, and charging none records nothing.
    const hers = q.payerOf(Principals.self(C1));
    expect(hers).toBeNull();
    q.charge(hers, T, 50);
    expect(q.capped(hers, T)).toBeNull();
    expect(
      store
        .plugin(quotaTables)
        .all()
        .every((r) => r.person === "~cpu:test:own"),
    ).toBe(true);
  });

  it("charges a person she knows by their id and anyone else by their account", async () => {
    const { agent } = agentOf(await open());
    const q = hostWorkQuota(agent, null);
    expect(q.payerOf(Principals.user(AMY, C1))).toEqual({ person: "p-amy" });
    expect(q.payerOf(Principals.user(BEA, C1))).toEqual({ person: "test:bea" });
    // Whoever suggested a thing she did herself pays for it, as with the AI quota.
    expect(q.payerOf(Principals.self(C1, AMY))).toEqual({ person: "p-amy" });
  });

  it("reads the limits from the config each time; 0 is no limit", async () => {
    const { agent, config } = agentOf(await open());
    const q = hostWorkQuota(agent, null);
    expect(q.rules()).toEqual({ cpuSecondsPerHour: 100, cpuSecondsPerDay: 250 });
    const payer = { person: "p-amy" };
    q.charge(payer, T, 1000);
    expect(q.capped(payer, T)).not.toBeNull();
    config.quota.person_cpu_seconds_per_hour = 0;
    config.quota.person_cpu_seconds_per_day = 0;
    expect(q.rules()).toEqual({ cpuSecondsPerHour: 0, cpuSecondsPerDay: 0 });
    expect(q.capped(payer, T)).toBeNull();
  });

  it("works without a store, in memory", () => {
    const { agent } = agentOf(null);
    const q = hostWorkQuota(agent, null);
    q.charge({ person: "p-amy" }, T, 12);
    expect(q.used("p-amy", T)).toEqual({ hour: 12, day: 12 });
  });

  it("has defaults high enough to be left alone: two CPUs for an hour, eight CPU hours a day", async () => {
    const { QuotaConfigSchema } = await import("../../agent/src/config.js");
    expect(QuotaConfigSchema.parse({})).toMatchObject({
      person_cpu_seconds_per_hour: 7200,
      person_cpu_seconds_per_day: 28_800,
    });
  });
});

describe("the work quota's rows in the shared table", () => {
  it("are under `~cpu:` and do not show on the AI quota's page or in its numbers", async () => {
    const store = await open();
    const book = store.plugin(quotaTables);
    const { agent } = agentOf(store);
    const work = hostWorkQuota(agent, null);
    const ai = new PersonQuota({
      rules: () => ({ usdPerHour: 3, usdPerDay: 10, unpricedUsdPerMtok: 1 }),
      book,
    });
    ai.add("p-amy", T, 0.5);
    work.charge({ person: "p-amy" }, T, 30);
    const day = new Date(T).toISOString().slice(0, 10);
    expect(
      book
        .all()
        .map((r) => r.person)
        .sort(),
    ).toEqual(["p-amy", "p-amy", `${WORK_KEY_PREFIX}p-amy`, `${WORK_KEY_PREFIX}p-amy`]);
    // The AI quota's list of people has nobody but the dollars' ones, and its numbers are its own.
    expect(book.dayTotals(day)).toEqual([{ person: "p-amy", micros: 500_000 }]);
    expect(ai.today(T)).toEqual([{ person: "p-amy", used: { hour: 0.5, day: 0.5 } }]);
    expect(work.used("p-amy", T)).toEqual({ hour: 30, day: 30 });
    expect(ai.used("p-amy", T)).toEqual({ hour: 0.5, day: 0.5 });
    // And the rows under the prefix are listed on their own, the prefix off.
    expect(book.dayTotalsUnder(day, WORK_KEY_PREFIX)).toEqual([
      { person: "p-amy", micros: 30_000_000 },
    ]);
  });

  it("go when the person asks to be forgotten, with the rest of their quota", async () => {
    const store = await open();
    const book = store.plugin(quotaTables);
    const { agent } = agentOf(store);
    const work = hostWorkQuota(agent, null);
    work.charge({ person: "p1" }, T, 5);
    work.charge({ person: "test:bea" }, T, 7);
    work.charge({ person: "keep" }, T, 9);
    const out = book.forgetPerson({
      person: "p1" as never,
      ids: ["p1" as never],
      accounts: [BEA],
      reason: "forget me",
      source: "test",
    });
    expect(out.spend).toBe(4);
    expect(book.all().map((r) => r.person)).toEqual([
      `${WORK_KEY_PREFIX}keep`,
      `${WORK_KEY_PREFIX}keep`,
    ]);
  });

  it("are pruned with the others, by slot and key", async () => {
    const store = await open();
    const book = store.plugin(quotaTables);
    const { agent } = agentOf(store);
    const work = hostWorkQuota(agent, null);
    work.charge({ person: "p1" }, T - 3 * HOUR, 5);
    // A charge an hour on, with the prune interval passed, drops the minutes that fell out.
    work.charge({ person: "p1" }, T + HOUR, 5);
    expect(book.all().filter((r) => r.slot === "minute")).toHaveLength(1);
  });
});
