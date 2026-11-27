// Extension schedules on a fake clock: her local time, once vs daily, restarts.

import type { ExtScheduleFireParams } from "@miyoria/contracts/ext";
import { MemorySettingsStore } from "@miyoria/store";
import { describe, expect, it } from "vitest";
import { ExtensionSchedules, nextDaily } from "../src/index.js";

const HOUR = 3_600_000;
// 2026-01-01T00:00:00Z.
const T0 = Date.UTC(2026, 0, 1);

function book(store = new MemorySettingsStore(), now = { t: T0 }) {
  const fired: ExtScheduleFireParams[] = [];
  const schedules = new ExtensionSchedules({
    extension: "made.up",
    store,
    profile: "p",
    clock: { now: () => now.t } as never,
    offsetMinutes: 480,
    fire: (p) => {
      fired.push(p);
      return true;
    },
    warn: () => undefined,
  });
  return { schedules, fired, store, now };
}

describe("extension schedules", () => {
  it("daily is HH:MM on her clock", () => {
    // 08:00 at UTC+8 is 00:00 UTC: at T0 exactly it is the next day's.
    expect(nextDaily("08:00", T0, 480)).toBe(T0 + 24 * HOUR);
    expect(nextDaily("09:30", T0, 480)).toBe(T0 + 1.5 * HOUR);
    expect(nextDaily("07:00", T0, 480)).toBe(T0 + 23 * HOUR);
    expect(nextDaily("00:00", T0, 0)).toBe(T0 + 24 * HOUR);
    expect(nextDaily("23:00", T0, -300)).toBe(T0 + 4 * HOUR);
  });

  it("a one-off fires once and is forgotten; a daily one moves to the next day", async () => {
    const { schedules, fired, store, now } = book();
    await schedules.set({ id: "once", at: T0 + HOUR, payload: { a: 1 } });
    await schedules.set({ id: "day", daily: "09:30" });
    expect(await schedules.tick(T0)).toBe(T0 + HOUR);
    expect(fired).toEqual([]);
    now.t = T0 + 2 * HOUR;
    expect(await schedules.tick(now.t)).toBe(T0 + 24 * HOUR + 1.5 * HOUR);
    expect(fired).toEqual([
      { id: "once", payload: { a: 1 }, due: T0 + HOUR },
      { id: "day", payload: null, due: T0 + 1.5 * HOUR },
    ]);
    expect(await store.get("p", "ext:made.up:schedule:once")).toBeNull();
    expect((await schedules.list()).schedules.map((s) => s.id)).toEqual(["day"]);
  });

  it("after a restart a missed one-off fires once, a daily one skips the missed day", async () => {
    const first = book();
    await first.schedules.set({ id: "once", at: T0 + HOUR });
    await first.schedules.set({ id: "day", daily: "09:30" });
    // Core was down for two days.
    const later = { t: T0 + 48 * HOUR };
    const second = book(first.store, later);
    await second.schedules.tick(later.t);
    expect(second.fired).toEqual([{ id: "once", payload: null, due: T0 + HOUR }]);
    const day = (await second.schedules.list()).schedules.find((s) => s.id === "day");
    expect(day?.next).toBe(T0 + 48 * HOUR + 1.5 * HOUR);
  });

  it("drops what it cannot read and tries a fire again when the extension cannot take it", async () => {
    const store = new MemorySettingsStore();
    await store.set("p", "ext:made.up:schedule:bad", { id: "bad" });
    await store.set("p", "ext:made.up:schedule:wrong", { id: "other", at: T0 });
    let busy = true;
    const fired: string[] = [];
    const schedules = new ExtensionSchedules({
      extension: "made.up",
      store,
      profile: "p",
      clock: { now: () => T0 } as never,
      offsetMinutes: 0,
      fire: (p) => {
        if (busy) return false;
        fired.push(p.id);
        return true;
      },
      warn: () => undefined,
    });
    expect((await schedules.list()).schedules).toEqual([]);
    expect(await store.list("p", "ext:made.up:schedule:")).toEqual(new Map());
    await schedules.set({ id: "x", at: T0 });
    await schedules.tick(T0);
    expect(fired).toEqual([]);
    busy = false;
    await schedules.tick(T0);
    expect(fired).toEqual(["x"]);
  });
});
