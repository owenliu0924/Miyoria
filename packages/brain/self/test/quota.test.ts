// Each person's AI quota: what is charged to whom, the hour and the day, the one fixed line someone
// at a limit is told, and what a restart keeps. Fake clock throughout.

import { currentLlmTag } from "@miyoria/llm/llm";
import type { Logger } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  QUOTA_DAY_LINE,
  QUOTA_HOUR_LINE,
  quotaLine,
} from "../../agent/src/index.js";
import { PROFILES } from "../src/profiles.js";
import {
  capMinutes,
  chargeOf,
  type Payer,
  PersonQuota,
  QUOTA_DEFAULTS,
  type QuotaBook,
  type QuotaRules,
  utcQuotaDay,
} from "../src/quota.js";
import type { Wake } from "../src/types.js";
import { addressed, calls, fakeTool, rig, SESSION, say, T0 } from "./harness.js";

const MIN = 60_000;
const OWEN: Payer = { person: "p-owen" };
const RULES: QuotaRules = { usdPerHour: 1, usdPerDay: 3, unpricedUsdPerMtok: 1 };

/** A book in memory, as the store's table keeps it. */
class MemoryBook implements QuotaBook {
  readonly rows = new Map<string, number>();
  add(person: string, minute: number, day: string, micros: number): void {
    for (const key of [`${person}|m|${minute}`, `${person}|d|${day}`]) {
      this.rows.set(key, (this.rows.get(key) ?? 0) + micros);
    }
  }
  load(person: string, sinceMinute: number, day: string) {
    const minutes: [number, number][] = [];
    let total = 0;
    for (const [key, micros] of this.rows) {
      const [who, slot, k] = key.split("|") as [string, string, string];
      if (who !== person) continue;
      if (slot === "d" && k === day) total = micros;
      if (slot === "m" && Number(k) >= sinceMinute) minutes.push([Number(k), micros]);
    }
    return { minutes, day: total };
  }
  dayTotals(day: string) {
    return [...this.rows]
      .filter(([key]) => key.endsWith(`|d|${day}`))
      .map(([key, micros]) => ({ person: key.split("|")[0] as string, micros }));
  }
  prune(beforeMinute: number, keepDays: readonly string[]): void {
    for (const key of [...this.rows.keys()]) {
      const [, slot, k] = key.split("|") as [string, string, string];
      if (slot === "m" && Number(k) < beforeMinute) this.rows.delete(key);
      if (slot === "d" && !keepDays.includes(k)) this.rows.delete(key);
    }
  }
}

function recordingLog(): { log: Logger; warns: [Record<string, unknown>, string | undefined][] } {
  const warns: [Record<string, unknown>, string | undefined][] = [];
  const noop = () => undefined;
  const log: Logger = {
    fatal: noop,
    error: noop,
    warn: ((fields: object | string, message?: string) => {
      if (typeof fields === "object") warns.push([fields as Record<string, unknown>, message]);
    }) as Logger["warn"],
    info: noop,
    debug: noop,
    trace: noop,
    child: () => log,
  };
  return { log, warns };
}

describe("the quota", () => {
  it("[modules.agent.quota] defaults: 3 USD an hour, 10 a day, 1 USD a million unpriced tokens", () => {
    const config = AgentConfigSchema.parse({});
    expect(config.quota).toEqual({
      person_usd_per_hour: 3,
      person_usd_per_day: 10,
      unpriced_usd_per_mtok: 1,
      // The sandbox's CPU seconds sit in the same table (docs/design/v6-sandbox.md §8).
      person_cpu_seconds_per_hour: 7200,
      person_cpu_seconds_per_day: 28800,
    });
    expect(QUOTA_DEFAULTS).toEqual({ usdPerHour: 3, usdPerDay: 10, unpricedUsdPerMtok: 1 });
    expect(() => AgentConfigSchema.parse({ quota: { person_usd_per_hour: -1 } })).toThrow();
  });

  it("charges a model without a price at the fallback rate", () => {
    expect(chargeOf(0.25, { prompt_tokens: 10, completion_tokens: 1 }, 1)).toBe(0.25);
    expect(chargeOf(null, { prompt_tokens: 900_000, completion_tokens: 100_000 }, 1.5)).toBe(1.5);
    expect(chargeOf(null, { prompt_tokens: 1000, completion_tokens: 0 }, 0)).toBe(0);
  });

  it("counts the rolling hour, and the minutes until enough has aged out", () => {
    const q = new PersonQuota({ rules: () => RULES });
    q.add(OWEN.person, T0 - 50 * MIN, 0.5);
    q.add(OWEN.person, T0 - 40 * MIN, 0.5);
    q.add(OWEN.person, T0 - 10 * MIN, 0.5);
    const capped = q.capped(OWEN, T0);
    // At +10 min 1.0 is left (still the limit); at +20 min 0.5.
    expect(capped).toMatchObject({ which: "hour", limit: 1, first: true, until: T0 + 20 * MIN });
    expect(capped?.used.hour).toBeCloseTo(1.5);
    expect(capMinutes(capped ?? { until: 0 }, T0)).toBe(20);
    // A read does not start a stretch.
    const fresh = new PersonQuota({ rules: () => RULES });
    fresh.add(OWEN.person, T0 - 10 * MIN, 1.5);
    expect(fresh.limitAt(OWEN.person, T0)).toEqual({ which: "hour", until: T0 + 50 * MIN });
    expect(fresh.capped(OWEN, T0)?.first).toBe(true);
    expect(q.capped(OWEN, T0 + 20 * MIN)).toBeNull();
    expect(q.used(OWEN.person, T0 + 20 * MIN).hour).toBeCloseTo(0.5);
  });

  it("counts her day, until the next one starts", () => {
    const q = new PersonQuota({ rules: () => ({ ...RULES, usdPerHour: 0 }) });
    for (let i = 0; i < 4; i++) q.add(OWEN.person, T0 + i * 70 * MIN, 0.9);
    const now = T0 + 4 * 70 * MIN;
    const capped = q.capped(OWEN, now);
    expect(capped).toMatchObject({ which: "day", limit: 3, until: utcQuotaDay(now).endsAt });
    expect(capped?.used.day).toBeCloseTo(3.6);
    expect(q.capped(OWEN, utcQuotaDay(now).endsAt)).toBeNull();
  });

  it("0 is no limit; the owner is charged and never capped", () => {
    const off = new PersonQuota({ rules: () => ({ ...RULES, usdPerHour: 0, usdPerDay: 0 }) });
    off.add(OWEN.person, T0, 50);
    expect(off.capped(OWEN, T0)).toBeNull();
    const q = new PersonQuota({ rules: () => RULES });
    q.add("p-owner", T0, 50);
    expect(q.capped({ person: "p-owner", exempt: true }, T0)).toBeNull();
    expect(q.used("p-owner", T0)).toEqual({ hour: 50, day: 50 });
    expect(q.capped({ person: "p-owner" }, T0)).not.toBeNull();
  });

  it("marks a stretch once; under it and over again is a new one", () => {
    const q = new PersonQuota({ rules: () => RULES });
    q.add(OWEN.person, T0 - 30 * MIN, 1.5);
    expect(q.capped(OWEN, T0)?.first).toBe(true);
    expect(q.capped(OWEN, T0 + MIN)?.first).toBe(false);
    expect(q.claimNotice(OWEN.person)).toBe(true);
    expect(q.claimNotice(OWEN.person)).toBe(false);
    q.add(OWEN.person, T0 + 31 * MIN, 1.5);
    expect(q.capped(OWEN, T0 + 32 * MIN)?.first).toBe(true);
    expect(q.claimNotice(OWEN.person)).toBe(true);
    q.releaseNotice(OWEN.person);
    expect(q.claimNotice(OWEN.person)).toBe(true);
  });

  it("a restart keeps what was spent: a new quota over the same book reads it", () => {
    const book = new MemoryBook();
    const before = new PersonQuota({ rules: () => RULES, book });
    before.add(OWEN.person, T0 - 20 * MIN, 0.7);
    before.add(OWEN.person, T0 - 5 * MIN, 0.6);
    const after = new PersonQuota({ rules: () => RULES, book });
    expect(after.used(OWEN.person, T0).hour).toBeCloseTo(1.3);
    expect(after.used(OWEN.person, T0).day).toBeCloseTo(1.3);
    expect(after.capped(OWEN, T0)).toMatchObject({ which: "hour", until: T0 + 40 * MIN });
    expect(after.today(T0)).toEqual([
      { person: OWEN.person, used: { hour: expect.closeTo(1.3), day: expect.closeTo(1.3) } },
    ]);
  });
});

describe("the fixed lines", () => {
  it("name about how long until it frees up", () => {
    expect(QUOTA_HOUR_LINE(25)).toBe("你這個小時找我做的事有點多,大概 25 分鐘後再來。");
    expect(QUOTA_DAY_LINE(60)).toBe("你今天找我做的事有點多了,大概 60 分鐘後再來。");
    expect(QUOTA_DAY_LINE(61)).toBe("你今天找我做的事有點多了,大概 2 個小時後再來。");
    expect(quotaLine("day", 300)).toBe(QUOTA_DAY_LINE(300));
    expect(quotaLine("hour", 0.2)).toBe(QUOTA_HOUR_LINE(1));
  });
});

describe("runs and the quota", () => {
  async function setup(rules: QuotaRules = RULES) {
    const quota = new PersonQuota({ rules: () => rules });
    const { log, warns } = recordingLog();
    const r = await rig([say("嗨")], { runner: { compaction: null, quota }, log });
    return { r, quota, warns };
  }

  it("a chat run is charged to the person it answers", async () => {
    const { r, quota } = await setup();
    r.line("Owen", "@她 在嗎");
    const result = await r.run(addressed(), { payer: OWEN });
    expect(result.outcome).toBe("said");
    // 1,000 prompt tokens (800 cached) and 100 out at the scripted price.
    expect(quota.used(OWEN.person, r.clock.now()).hour).toBeCloseTo(result.cost_usd, 9);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it("a voice run is charged the same way", async () => {
    const { r, quota } = await setup();
    r.line("Owen", "在嗎", { spoken: true });
    const result = await r.run(addressed(), { profile: PROFILES.voice, payer: OWEN });
    expect(quota.used(OWEN.person, r.clock.now()).hour).toBeCloseTo(result.cost_usd, 9);
  });

  it("a model call a tool makes for the person (a look at a stream) is charged to them", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    const r = await rig([calls([{ name: "look" }]), say("看到了")], {
      runner: { compaction: null, quota },
    });
    // What the router does for a call made inside the tool: it tells the call's tag.
    r.tools.register(
      fakeTool("look", "畫面上有一隻貓", {
        call: () => {
          const tag = currentLlmTag();
          tag?.onCall?.({ id: "v1", cost_usd: null, status: "streaming" });
          tag?.onCall?.({ id: "v1", cost_usd: 0.2, status: "ok" });
          tag?.onCall?.({
            id: "v2",
            cost_usd: null,
            status: "ok",
            usage: { prompt_tokens: 90_000, completion_tokens: 10_000 },
          });
          return "畫面上有一隻貓";
        },
      }),
    );
    r.line("Owen", "@她 直播在幹嘛");
    const result = await r.run(addressed(), { payer: OWEN });
    // Her two steps, the priced look, and the unpriced one at 1 USD a million tokens.
    expect(quota.used(OWEN.person, r.clock.now()).hour).toBeCloseTo(result.cost_usd + 0.3, 9);
  });

  it("her own initiative is charged to nobody", async () => {
    const { r, quota } = await setup();
    r.line("Owen", "今天好熱");
    const result = await r.run({ kind: "glance", lines: 1 }, { payer: null });
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(quota.today(r.clock.now())).toEqual([]);
  });

  it("at the limit: one fixed line, once per stretch, and no model call", async () => {
    const { r, quota, warns } = await setup();
    quota.add(OWEN.person, T0 - 30 * MIN, 1.5);
    r.line("Owen", "@她 在嗎");
    const result = await r.run(addressed(), { payer: OWEN });
    expect(result.outcome).toBe("over_budget");
    expect(result.limits).toEqual(["spend"]);
    expect(r.model.requests).toEqual([]);
    expect(r.outlet.texts()).toEqual([QUOTA_HOUR_LINE(30)]);
    expect(r.outlet.texts()[0]).toBe("你這個小時找我做的事有點多,大概 30 分鐘後再來。");
    expect(r.outlet.lines[0]).toMatchObject({ focus: true, replyTo: { id: "m1" } });
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "line", via: "fixed", text: QUOTA_HOUR_LINE(30) }),
    );
    expect(r.transcript.tail(SESSION.id).entries.at(-1)).toMatchObject({
      kind: "self",
      content: QUOTA_HOUR_LINE(30),
    });
    expect(warns).toEqual([
      [
        expect.objectContaining({ person: OWEN.person, which: "hour", cap: 1, minutes: 30 }),
        expect.stringContaining("AI quota"),
      ],
    ]);
    // The next message of the stretch: nothing at all.
    r.clock.tick(5 * MIN);
    r.line("Owen", "@她 還在嗎");
    expect((await r.run(addressed("m2"), { payer: OWEN })).outcome).toBe("over_budget");
    expect(r.outlet.texts()).toHaveLength(1);
    expect(r.model.requests).toEqual([]);
    expect(warns).toHaveLength(1);
    // Someone else in the same place is answered.
    r.line("Amy", "@她 嗨");
    expect((await r.run(addressed("m3"), { payer: { person: "p-amy" } })).outcome).toBe("said");
    // Once it frees up, Owen is answered again.
    r.clock.tick(25 * MIN);
    r.line("Owen", "@她 回來了嗎");
    expect((await r.run(addressed("m4"), { payer: OWEN })).outcome).toBe("said");
  });

  it("the day's limit has its own line", async () => {
    const { r, quota } = await setup({ ...RULES, usdPerHour: 0 });
    quota.add(OWEN.person, T0 - 3 * 60 * MIN, 3.2);
    r.line("Owen", "@她 在嗎");
    expect((await r.run(addressed(), { payer: OWEN })).outcome).toBe("over_budget");
    // T0 is 04:00 UTC: the day ends in 20 hours.
    expect(r.outlet.texts()).toEqual([QUOTA_DAY_LINE(20 * 60)]);
    expect(r.outlet.texts()[0]).toBe("你今天找我做的事有點多了,大概 20 個小時後再來。");
  });

  it("the owner is never refused", async () => {
    const { r, quota } = await setup();
    quota.add("p-owner", T0 - 30 * MIN, 9);
    r.line("Owen", "@她 在嗎");
    const result = await r.run(addressed(), { payer: { person: "p-owner", exempt: true } });
    expect(result.outcome).toBe("said");
    expect(r.model.requests).toHaveLength(1);
  });

  it("a voice run at the limit says the line too", async () => {
    const { r, quota } = await setup();
    quota.add(OWEN.person, T0 - 30 * MIN, 1.5);
    r.line("Owen", "在嗎", { spoken: true });
    const result = await r.run(addressed(), { profile: PROFILES.voice, payer: OWEN });
    expect(result.outcome).toBe("over_budget");
    expect(r.outlet.texts()).toEqual([QUOTA_HOUR_LINE(30)]);
    expect(r.transcript.tail(SESSION.id).entries.at(-1)).toMatchObject({ spoken: true });
  });

  it("a glance in a place with someone at the limit is not refused for them", async () => {
    const { r, quota } = await setup();
    quota.add(OWEN.person, T0 - 30 * MIN, 1.5);
    r.line("Owen", "今天好熱");
    expect((await r.run({ kind: "glance", lines: 1 }, { payer: null })).outcome).toBe("said");
    expect(r.model.requests).toHaveLength(1);
  });
});

describe("a run that works for several people", () => {
  const AMY = { account: { platform: "discord", id: "amy" }, name: "Amy" };
  const BOB = { account: { platform: "discord", id: "bob" }, name: "Bob" };
  const BOSS = { account: { platform: "discord", id: "boss" }, name: "主人" };
  const payerOf = (from: { account: { id: string } }): Payer =>
    from.account.id === "boss"
      ? { person: "p-boss", exempt: true }
      : { person: `p-${from.account.id}` };
  /** Amy's line, then the other's, answered in one run. */
  const both = (other = BOB): Wake => ({
    kind: "addressed",
    reason: "mention",
    from: AMY,
    message: { context: SESSION.context, id: "m1" },
    callers: [
      { from: AMY, message: { context: SESSION.context, id: "m1" } },
      { from: other, message: { context: SESSION.context, id: "m2" } },
    ],
  });

  it("shares each step among them: the first caller does not pay for the second", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    const r = await rig([say("嗨嗨")], { runner: { compaction: null, quota } });
    const result = await r.run(both(), { payerOf });
    const now = r.clock.now();
    expect(quota.used("p-amy", now).hour).toBeCloseTo(result.cost_usd / 2, 9);
    expect(quota.used("p-bob", now).hour).toBeCloseTo(result.cost_usd / 2, 9);
  });

  it("someone beside the owner still pays their share", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    const r = await rig([say("嗨嗨")], { runner: { compaction: null, quota } });
    const result = await r.run(both(BOSS), { payerOf });
    expect(quota.used("p-amy", r.clock.now()).hour).toBeCloseTo(result.cost_usd / 2, 9);
  });

  it("a tool's own model calls go to the one it is for", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    const r = await rig([calls([{ name: "look", args: { for_whom: "2" } }]), say("看到了")], {
      runner: { compaction: null, quota },
    });
    r.tools.register(
      fakeTool("look", "貓", {
        actsFor: true,
        call: () => {
          currentLlmTag()?.onCall?.({ id: "v1", cost_usd: 0.2, status: "ok" });
          return "貓";
        },
      }),
    );
    const result = await r.run(both(), { payerOf });
    const now = r.clock.now();
    expect(quota.used("p-bob", now).hour).toBeCloseTo(result.cost_usd / 2 + 0.2, 9);
    expect(quota.used("p-amy", now).hour).toBeCloseTo(result.cost_usd / 2, 9);
  });

  it("a call for someone at their quota is refused while the run goes on for the other", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    quota.add("p-amy", T0 - 10 * MIN, 1.5);
    const seen: string[] = [];
    const r = await rig(
      [
        calls([
          { name: "write", args: { for_whom: "1" }, id: "c1" },
          { name: "write", args: { for_whom: "2" }, id: "c2" },
        ]),
        say("Bob 的好了,Amy 的晚點"),
      ],
      { runner: { compaction: null, quota } },
    );
    r.tools.register(
      fakeTool("write", "寫好了", {
        effect: "act",
        actsFor: true,
        call: (_args, ctx) => {
          seen.push(ctx.account.id);
          return "寫好了";
        },
      }),
    );
    const result = await r.run(both(), { payerOf });
    expect(result.outcome).toBe("said");
    expect(seen).toEqual(["bob"]);
    const refused = result.calls.find((c) => c.id === "c1");
    expect(refused).toMatchObject({ ok: false, code: "refused" });
    expect(refused?.text).toContain("到額度了");
  });

  it("everyone at their quota: the fixed line and no model call", async () => {
    const quota = new PersonQuota({ rules: () => RULES });
    quota.add("p-amy", T0 - 10 * MIN, 1.5);
    quota.add("p-bob", T0 - 10 * MIN, 1.5);
    const r = await rig([say("嗨嗨")], { runner: { compaction: null, quota } });
    const result = await r.run(both(), { payerOf });
    expect(result.outcome).toBe("over_budget");
    expect(r.model.requests).toHaveLength(0);
  });
});
