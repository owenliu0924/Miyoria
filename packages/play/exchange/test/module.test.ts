// Module `exchange` and the local stocks' signals: the module builds the book from the sources it
// is given, reads yesterday's count, puts the plain line on the local stock's
// line, and tells her the facts as escaped data in her own bucket, with no names in it.

import { heartTables } from "@miyoria/heart/person";
import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { type EventLog, EventLogKey, type Observation, type ObserveOptions } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ExchangeKey, ExchangeModule } from "../src/module.js";
import { taipeiDay } from "../src/real/local.js";
import type { CountSource } from "../src/real/signals.js";
import { exchangeTables } from "../src/store.js";

/** Monday 2026-11-23 12:30 Taipei. */
const NOW = Date.UTC(2026, 10, 23, 4, 30);
const Y = taipeiDay(NOW) - 1;
const clock = { now: () => NOW };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const feeds: CountSource = {
  label: "test",
  missing: () => null,
  count: async (day) => {
    if (day > Y || day < Y - 14) return null;
    const v = day === Y ? 16 : 10;
    return { value: v, parts: { feeds: v } };
  },
};

describe("module exchange, the local stocks' signals", () => {
  it("moves today's open by yesterday's feedings, shows the line and tells her the facts", async () => {
    const store = await SqliteStore.open(":memory:", {
      plugins: [heartTables, exchangeTables],
      clock,
    });
    cleanup.push(() => store.close());
    const notes: { o: Observation; options: ObserveOptions | undefined }[] = [];
    const log = {
      observe: (o: Observation, options?: ObserveOptions) => {
        notes.push({ o, options });
        return {} as never;
      },
    } as unknown as EventLog;
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", StoreKey, store);
    sup.services.provide("app", EventLogKey, log);
    // Only RICE has a source: the other four are missing and stay neutral.
    await sup.register(
      new ExchangeModule({ clock, tickMs: 3_600_000, seed: "m", sources: { RICE: feeds } }),
      null,
      true,
    );
    await sup.startAll();
    const service = sup.services.require(ExchangeKey);
    // Her note: her own bucket, escaped as data, numbers only.
    const deadline = Date.now() + 2000;
    while (!notes.some((n) => n.o.attention_key === "exchange:local") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    const note = notes.find((n) => n.o.attention_key === "exchange:local");
    expect(note?.o.summary).toContain(
      "白飯食品(RICE):昨天你被餵了 16 次,比平常多 → 今天開盤 +1.8%",
    );
    expect(note?.options?.buckets?.[0]).toMatchObject({
      writer: "exchange.local",
      untrusted: true,
    });
    expect(note?.o.from).toBeNull();
    await service.tick();
    const view = service.real.view();
    const rice = view.instruments.find((i) => i.code === "RICE");
    expect(rice?.local?.today).toBe("昨天她被餵了 16 次,比平常多 → 今天開盤 +1.8%");
    expect(view.instruments.find((i) => i.code === "DPSK")?.local?.today).toBe(
      "昨天沒有她的紀錄 → 今天開盤 +0.0%",
    );
  });
});
