// Each person's AI quota in the text host: `[modules.agent.quota]` is what a person is held to,
// the scripted model has no price (its tokens count at `unpriced_usd_per_mtok`), the store's
// `quota` table keeps it across a restart, and who is charged follows who the run is for.

import { SqliteStore } from "@miyoria/store";
import { Events, type TurnOutcomeRecord } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../agent/src/index.js";
import { PersonQuota } from "../../self/src/index.js";
import { payerOf, payerOfAuthor, personKey } from "../src/quota.js";
import { quotaTables } from "../src/quota-store.js";
import { account, channel, mention, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const MINUTE = 60_000;
/** One answer of the scripted model: 110 tokens at 1 USD a million. */
const ANSWER_USD = 110 / 1_000_000;
const HOUR_LINE = /^你這個小時找我做的事有點多,大概 \d+ 分鐘後再來。$/;

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
const TIGHT = { quota: { person_usd_per_hour: ANSWER_USD / 2, person_usd_per_day: 10 } };

describe("the AI quota in the text host", () => {
  it("charges the person who called her; at the limit one line, once, and no model call", async () => {
    const rig = await Rig.create({ config: TIGHT });
    rig.model.push(says("嗨"), says("嗨嗨"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => outcomes(rig).length === 1, 3_000, "the first answer");
    const quota = rig.host?.quota as PersonQuota;
    const now = Date.now() + rig.shift;
    expect(quota.used("test:amy", now).hour).toBeCloseTo(ANSWER_USD, 9);
    expect(quota.used("test:bea", now).hour).toBe(0);

    rig.say(mention(C1, "amy", "@她 還在嗎"));
    await until(() => outcomes(rig).length === 2, 3_000, "the second outcome");
    await until(() => rig.sink.texts().length === 2, 3_000, "the line");
    expect(rig.model.requests).toHaveLength(1);
    expect(rig.sink.texts()[0]).toBe("嗨");
    expect(rig.sink.texts()[1]).toMatch(HOUR_LINE);
    expect(outcomes(rig)[1]?.outcome).toEqual({ type: "error", error: "over_budget" });

    // Asked again in the same stretch: nothing is said, still no model call.
    rig.say(mention(C1, "amy", "@她 ?"));
    await until(() => outcomes(rig).length === 3, 3_000, "the third outcome");
    expect(rig.sink.texts()).toHaveLength(2);
    expect(rig.model.requests).toHaveLength(1);

    // Someone else is answered.
    rig.say(mention(C1, "bea", "@她 午安"));
    await until(() => rig.sink.texts().length === 3, 3_000, "bea's answer");
    expect(rig.sink.texts()[2]).toBe("嗨嗨");
  });

  it("the default limits let the same hour through", async () => {
    const rig = await Rig.create();
    rig.model.push(says("嗨"), says("又是我"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => outcomes(rig).length === 1, 3_000, "the first answer");
    rig.say(mention(C1, "amy", "@她 還在嗎"));
    await until(() => outcomes(rig).length === 2, 3_000, "the second outcome");
    expect(rig.model.requests).toHaveLength(2);
    expect(outcomes(rig)[1]?.outcome).toEqual({ type: "sent", parts: 1 });
  });

  it("is kept across a restart", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [] });
    const first = await Rig.create({ store, config: TIGHT });
    first.model.push(says("嗨"));
    first.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => outcomes(first).length === 1, 3_000, "the first answer");
    await first.stop();
    expect(store.plugin(quotaTables).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ person: "test:amy", slot: "minute", micros: 110 }),
        expect.objectContaining({ person: "test:amy", slot: "day", micros: 110 }),
      ]),
    );

    const second = await Rig.create({ store, config: TIGHT });
    second.model.push(says("不該說"));
    second.say(mention(C1, "amy", "@她 我回來了"));
    await until(() => second.sink.texts().length === 1, 3_000, "the line");
    expect(second.sink.texts()[0]).toMatch(HOUR_LINE);
    expect(second.model.requests).toHaveLength(0);
  });
});

describe("the quota's table", () => {
  it("keeps minutes and days, prunes the old ones, and forgets a person", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [quotaTables] });
    const book = store.plugin(quotaTables);
    const T = Date.UTC(2026, 10, 23, 4);
    const day = new Date(T).toISOString().slice(0, 10);
    const a = new PersonQuota({
      rules: () => ({ usdPerHour: 1, usdPerDay: 2, unpricedUsdPerMtok: 1 }),
      book,
    });
    a.add("p1", T - 90 * MINUTE, 0.5);
    a.add("p1", T - 30 * MINUTE, 0.25);
    a.add("discord:9", T, 0.125);
    // A new quota over the same table: the hour is the last 60 minutes, the day all of it.
    const b = new PersonQuota({
      rules: () => ({ usdPerHour: 1, usdPerDay: 2, unpricedUsdPerMtok: 1 }),
      book,
    });
    expect(b.used("p1", T)).toEqual({ hour: 0.25, day: 0.75 });
    expect(book.dayTotals(day)).toEqual([
      { person: "p1", micros: 750_000 },
      { person: "discord:9", micros: 125_000 },
    ]);
    book.prune(Math.floor(T / MINUTE) - 59, [day]);
    expect(book.all().filter((r) => r.slot === "minute")).toHaveLength(2);
    book.prune(Math.floor(T / MINUTE) - 59, ["2026-11-24"]);
    expect(book.all().filter((r) => r.slot === "day")).toEqual([]);
    expect(
      book.forgetPerson({
        person: "p1" as never,
        ids: ["p1" as never],
        accounts: [{ platform: "discord", id: "9" }],
        reason: "forget me",
        source: "test",
      }),
    ).toEqual({ spend: 2 });
    expect(book.all()).toEqual([]);
  });
});

describe("who a run is charged to", () => {
  const owner = account("own");
  const agent = {
    attitude: (a: { id: string }) => (a.id === "amy" ? { person: "p-amy" } : null),
    ctx: {
      services: {
        get: () => ({
          allows: (a: { id: string }) => a.id === "own",
          isOwner: (a: { id: string }) => a.id === "own",
        }),
      },
    },
  } as unknown as Agent;
  const amy = { account: account("amy"), name: "Amy" };

  it("the person she knows by their id, anyone else by their account", () => {
    expect(personKey(agent, account("amy"))).toBe("p-amy");
    expect(personKey(agent, account("bea"))).toBe("test:bea");
  });

  it("the one who called her, or who asked for what came back; her own starts nobody", () => {
    expect(
      payerOf(agent, {
        kind: "addressed",
        reason: "mention",
        from: amy,
        message: { context: C1, id: "m" },
      }),
    ).toEqual({ person: "p-amy" });
    expect(
      payerOf(agent, { kind: "result", tool: "delegate", job: "j", ok: true, text: "", from: amy }),
    ).toEqual({ person: "p-amy" });
    expect(
      payerOf(agent, { kind: "result", tool: "delegate", job: "j", ok: true, text: "" }),
    ).toBeNull();
    expect(payerOf(agent, { kind: "glance", lines: 2 })).toBeNull();
    expect(payerOf(agent, { kind: "timer", note: "起床" })).toBeNull();
    expect(payerOf(agent, { kind: "self", note: null })).toBeNull();
  });

  it("the owner is charged and exempt", () => {
    expect(payerOfAuthor(agent, { account: owner, name: "主人" })).toEqual({
      person: "test:own",
      exempt: true,
    });
  });
});
