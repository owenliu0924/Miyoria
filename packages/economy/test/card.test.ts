// The economy module's card on the panel: the health table's week and today, in the economy's
// currency, and the first of her bounties to run out.

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { CARD_MAX_FACTS, Supervisor } from "@miyoria/runtime/kernel";
import { PeopleStoreKey, SqliteStore } from "@miyoria/store";
import { AuthorizerKey, type JsonObject, SocialSignalsKey, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerDayTotal } from "../src/health.js";
import { EconomyModule } from "../src/module.js";
import { type Bounty, BountyStoreKey, CoinLedgerStoreKey, LedgerStatsKey } from "../src/records.js";
import { ledgerOf } from "./ledger.js";
import { DAY, T0 } from "./rig.js";

const clock = { now: () => T0 };
/** The local day (UTC+8, the default) of `T0`. */
const TODAY = Math.floor((T0 + 8 * 3_600_000) / DAY);

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function bounty(id: string, expires: number): Bounty {
  return {
    id,
    task: "畫一張圖",
    reward: 10,
    hold: `hold-${id}`,
    status: "open",
    created_at: toTimestamp(T0 - DAY),
    expires_at: toTimestamp(expires),
    closed_at: null,
    winner: null,
  };
}

async function start(
  config: JsonObject,
  options: { totals?: LedgerDayTotal[]; bounties?: Bounty[] } = {},
) {
  const store = await SqliteStore.open(":memory:");
  cleanup.push(() => store.close());
  const sup = new Supervisor({ clock });
  cleanup.push(() => sup.stopAll());
  const s = sup.services;
  s.provide("kernel", CoinLedgerStoreKey, ledgerOf(store));
  s.provide("kernel", PeopleStoreKey, store.people);
  s.provide("kernel", SocialSignalsKey, { attitude: () => ({ blocked: false }) as never });
  s.provide("kernel", AuthorizerKey, { allows: () => true } as never);
  s.provide("app", ActuatorRegistryKey, new ActuatorRegistry({ services: s, builtins: false }));
  const { totals, bounties } = options;
  if (totals !== undefined) {
    s.provide("kernel", LedgerStatsKey, { dailyTotals: async () => totals });
  }
  if (bounties !== undefined) {
    s.provide("kernel", BountyStoreKey, { list: async () => bounties } as never);
  }
  const module = new EconomyModule("p");
  await sup.register(module, config, true);
  await sup.startAll();
  return module;
}

describe("economy card", () => {
  it("shows the week's recovery and today's coins in the economy's currency", async () => {
    const module = await start(
      { currency: "貝殼", achievement_cap: 0 },
      {
        totals: [
          { day: TODAY, reason: "checkin", positive: 100, negative: 0 },
          { day: TODAY, reason: "feed", positive: 0, negative: 40 },
          { day: TODAY - 1, reason: "play", positive: 100, negative: 0 },
          { day: TODAY - 1, reason: "shop", positive: 0, negative: 80 },
        ],
        bounties: [bounty("b2", T0 + 2 * DAY), bounty("b1", T0 + DAY)],
      },
    );
    const card = await module.card();
    expect(card.facts.length).toBeLessThanOrEqual(CARD_MAX_FACTS);
    expect(card.facts).toEqual([
      { label: "七天回收率", value: 60, unit: "%" },
      { label: "今天發出", value: 100, unit: "貝殼" },
      { label: "今天收回", value: 40, unit: "貝殼" },
    ]);
    expect(card.next).toEqual({ label: "懸賞到期", at: toTimestamp(T0 + DAY) });
  });

  it("leaves out the rate of a week that issued nothing", async () => {
    const module = await start({}, { totals: [] });
    expect((await module.card()).facts).toEqual([
      { label: "今天發出", value: 0, unit: "魚幣" },
      { label: "今天收回", value: 0, unit: "魚幣" },
    ]);
  });

  it("invents nothing without ledger totals or bounties", async () => {
    expect(await new EconomyModule("p").card()).toEqual({ facts: [] });
    const module = await start({});
    expect(await module.card()).toEqual({ facts: [] });
  });
});
