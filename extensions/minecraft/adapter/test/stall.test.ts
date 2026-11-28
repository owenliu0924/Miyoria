// Design doc P1: the progress watchdog, dead-end memory and what she does when idle.

import type { TaskEvent, TaskSpec } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MinecraftAdapter } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { CELL, DeadEnds, STEER_BLOCKS, TTL_MS } from "../src/deadends.js";
import { FEW_LOGS, chooseIdle } from "../src/idle.js";
import { StallWatch } from "../src/stall.js";
import type { Snapshot } from "../src/summary.js";
import { FakeMod, SNAPSHOT, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let bridge: BridgeClient | undefined;

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  await mod?.stop();
  mod = undefined;
});

const at = (x: number, z: number, extra: Partial<Snapshot> = {}): Snapshot => ({
  block_position: { x, y: 64, z },
  inventory: { dirt: 1 },
  ...extra,
});

describe("StallWatch", () => {
  it("is stuck after its window without moving or gaining anything", () => {
    const w = new StallWatch(10_000, 0);
    expect(w.look(at(0, 0), 1_000)).toBe(false);
    expect(w.look(at(1, 0), 9_000)).toBe(false); // one block is shuffling, not moving
    expect(w.look(at(1, 0), 10_000)).toBe(true);
    expect(w.idleSecs(10_000)).toBe(10);
  });

  it("moving, a changed inventory, a workbench job, a reflex or a reported step count as progress", () => {
    const w = new StallWatch(10_000, 0);
    w.look(at(0, 0), 0);
    expect(w.look(at(3, 0), 8_000)).toBe(false);
    expect(w.look(at(3, 0), 17_000)).toBe(false);
    expect(w.lastProgress).toBe("移動了");
    expect(w.look(at(3, 0, { inventory: { dirt: 2 } }), 17_500)).toBe(false);
    expect(w.look(at(3, 0, { inventory: { dirt: 2 } }), 27_000)).toBe(false);
    expect(w.lastProgress).toBe("背包有變化");
    expect(w.look(at(3, 0, { inventory: { dirt: 2 }, crafting: { kind: "smelt", item: "raw_iron" } }), 30_000)).toBe(false);
    expect(w.look(at(3, 0, { inventory: { dirt: 2 }, reflex: { active: "fight" } }), 39_000)).toBe(false);
    w.bump(48_000);
    expect(w.look(at(3, 0, { inventory: { dirt: 2 } }), 57_000)).toBe(false);
    expect(w.look(at(3, 0, { inventory: { dirt: 2 } }), 58_000)).toBe(true);
  });

  it("a quiet wait (a furnace burning) is not a stall", () => {
    const w = new StallWatch(10_000, 0);
    w.look(at(0, 0), 0);
    w.quiet(30_000);
    expect(w.look(at(0, 0), 25_000)).toBe(false);
    expect(w.look(at(0, 0), 39_000)).toBe(false);
    expect(w.look(at(0, 0), 40_000)).toBe(true);
  });

  it("no snapshot (disconnected, a menu) changes nothing", () => {
    const w = new StallWatch(10_000, 0);
    w.look(at(0, 0), 0);
    expect(w.look(null, 5_000)).toBe(false);
    expect(w.look(at(5, 0), 6_000)).toBe(false);
  });
});

describe("DeadEnds", () => {
  it("says nothing until exploring found nothing nearby", () => {
    const d = new DeadEnds();
    expect(d.steer("overworld", { x: 0, z: 0 }, [], 0)).toBeNull();
  });

  it("sends the next explore away from where the last one found nothing", () => {
    const d = new DeadEnds();
    // Explored eastwards over open sea, saw nothing new.
    d.mark("overworld", { x: 0, z: 0 }, { x: 3 * CELL, z: 0 }, [], 0);
    expect(d.size).toBe(4);
    const s = d.steer("overworld", { x: 3 * CELL, z: 0 }, [], 1_000);
    expect(s).not.toBeNull();
    // Away from the dull strip: the west is where it came from, so north, south or east.
    expect(s?.x).toBeGreaterThanOrEqual(3 * CELL);
    expect(Math.hypot((s?.x ?? 0) - 3 * CELL, s?.z ?? 0)).toBeCloseTo(STEER_BLOCKS, -1);
    expect(s?.direction).toMatch(/^往/);
    // Another dimension is another map.
    expect(d.steer("the_nether", { x: 3 * CELL, z: 0 }, [], 1_000)).toBeNull();
  });

  it("a search that found nothing is dull only for what it looked for", () => {
    const d = new DeadEnds();
    d.mark("overworld", { x: 0, z: 0 }, { x: 0, z: 0 }, ["cow"], 0);
    expect(d.steer("overworld", { x: 0, z: 0 }, ["cow"], 1)).not.toBeNull();
    expect(d.steer("overworld", { x: 0, z: 0 }, ["oak_log"], 1)).toBeNull();
    expect(d.steer("overworld", { x: 0, z: 0 }, [], 1)).toBeNull();
  });

  it("forgets after a while", () => {
    const d = new DeadEnds();
    d.mark("overworld", { x: 0, z: 0 }, { x: 0, z: 0 }, [], 0);
    expect(d.steer("overworld", { x: 0, z: 0 }, [], TTL_MS + 1)).toBeNull();
  });
});

describe("chooseIdle", () => {
  const base: Snapshot = { food: 20, inventory: { stone_pickaxe: 1, oak_log: 20 }, nearby_blocks: [] };

  it("food first when hungry with nothing to eat", () => {
    expect(chooseIdle({ ...base, food: 8 }).args).toEqual({ item: "food" });
    // Something to eat already: not the first thing.
    expect(chooseIdle({ ...base, food: 8, inventory: { ...base.inventory, bread: 2 } }).goal).toBe("explore");
  });

  it("the next pickaxe, wood in sight, else exploring", () => {
    expect(chooseIdle({ ...base, inventory: {} }).args).toEqual({ item: "wooden_pickaxe" });
    expect(chooseIdle({ ...base, inventory: { wooden_pickaxe: 1, cobblestone: 5 } }).args).toEqual({ item: "stone_pickaxe" });
    const trees: Snapshot = { ...base, inventory: { stone_pickaxe: 1 }, nearby_blocks: [{ block: "birch_log", count: 4 }] };
    expect(chooseIdle(trees)).toMatchObject({ goal: "obtain", args: { item: "birch_log", count: FEW_LOGS } });
    expect(chooseIdle(base)).toMatchObject({ goal: "explore", key: "explore" });
  });

  it("skips what just went nowhere", () => {
    const s: Snapshot = { ...base, inventory: {} };
    expect(chooseIdle(s, new Set(["wooden_pickaxe"])).goal).toBe("explore");
  });
});

// ---- through the executor ----------------------------------------------------------------------

async function setup(opts: ConstructorParameters<typeof MinecraftAdapter>[1], snapshot: () => Snapshot) {
  mod = await FakeMod.start();
  mod.respond = (req) => (req.type === "observe" ? { ok: true, data: snapshot() } : { ok: true, data: {} });
  const m = mod;
  bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }), reconnectMinMs: 20, requestTimeoutMs: 500 });
  const adapter = new MinecraftAdapter(bridge, opts);
  bridge.start();
  const b = bridge;
  await waitFor(() => b.ready);
  return { mod: m, adapter };
}

function taskEvents(adapter: MinecraftAdapter): TaskEvent[] {
  const out: TaskEvent[] = [];
  void (async () => {
    for await (const e of adapter.tasks.events()) out.push(e);
  })();
  return out;
}

const ends = (events: TaskEvent[]) =>
  events.filter((e) => e.type === "done" || e.type === "failed").map((e) => [e.task, e.type === "failed" ? e.code : "done"]);

const spec = (id: string, goal: string, args: Record<string, unknown> = {}, budget_s = 30): TaskSpec => ({ id, goal, args, budget_s });

describe("the watchdog on a running task", () => {
  it("a goto that does not move ends with stuck, long before its budget, and stops the mod", async () => {
    const { mod: m, adapter } = await setup({ stallSecs: { goto: 0.15 }, stallPollMs: 20 }, () => ({ ...SNAPSHOT }));
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("g1", "goto", { x: 500, z: 500 }));
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["g1", "stuck"]]);
    expect(tasks.find((e) => e.type === "failed")).toMatchObject({ detail: expect.stringContaining("卡住了") });
    await waitFor(() => m.requests.some((r) => r.type === "stop"));
    adapter.close();
  });

  it("a goto that keeps moving is left alone", async () => {
    let x = 0;
    const { mod: m, adapter } = await setup({ stallSecs: { goto: 0.15 }, stallPollMs: 20 }, () => {
      x += 3;
      return { ...SNAPSHOT, block_position: { x, y: 64, z: 0 } };
    });
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("g1", "goto", { x: 500, z: 500 }));
    await new Promise((r) => setTimeout(r, 400));
    expect(ends(tasks)).toEqual([]);
    m.emit("goal_reached", { goal: "GoalXZ" });
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["g1", "done"]]);
    adapter.close();
  });

  it("goals that may stand still on purpose are not watched", async () => {
    const { adapter } = await setup({ stallSecs: { goto: 0.1 }, stallPollMs: 20 }, () => ({ ...SNAPSHOT }));
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("f1", "follow", { player: "Owen" }, 0.6));
    await waitFor(() => ends(tasks).length === 1, 2_000);
    expect(ends(tasks)).toEqual([["f1", "done"]]);
    adapter.close();
  });
});

describe("exploring remembers where there was nothing", () => {
  it("the next explore is centered away from a dull one", async () => {
    let x = 0;
    const { mod: m, adapter } = await setup({ explorePollMs: 20, stallSecs: false }, () => {
      // She moves east, and sees the same plains all the way.
      x += 20;
      return { ...SNAPSHOT, block_position: { x, y: 64, z: 0 } };
    });
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("e1", "explore", {}, 0.6));
    await waitFor(() => ends(tasks).length === 1, 2_000);
    const first = m.requests.filter((r) => r.type === "baritone" && r.command === "explore");
    expect(first).toHaveLength(1);
    expect(first[0]).not.toHaveProperty("x");
    expect(tasks.find((e) => e.type === "done")).toMatchObject({ detail: expect.stringContaining("沒看到新的東西") });

    await adapter.tasks.start(spec("e2", "explore", {}, 0.6));
    await waitFor(() => ends(tasks).length === 2, 2_000);
    const second = m.requests.filter((r) => r.type === "baritone" && r.command === "explore");
    expect(second).toHaveLength(2);
    expect(second[1]).toHaveProperty("x");
    expect(second[1]).toHaveProperty("z");
    expect(tasks.some((e) => e.type === "progress" && e.detail.includes("這附近探索過了"))).toBe(true);
    adapter.close();
  });
});

describe("idle", () => {
  it("runs the chosen goal as its own task and says why", async () => {
    const { mod: m, adapter } = await setup({ explorePollMs: 20, stallSecs: false }, () => ({
      ...SNAPSHOT,
      inventory: { stone_pickaxe: 1, bread: 3 },
      nearby_blocks: [],
    }));
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("i1", "idle", {}, 0.6));
    await waitFor(() => ends(tasks).length === 1, 2_000);
    expect(m.requests.some((r) => r.type === "baritone" && r.command === "explore")).toBe(true);
    expect(tasks.some((e) => e.type === "progress" && e.detail === "沒什麼急事,到處看看")).toBe(true);
    expect(tasks.find((e) => e.task === "i1" && (e.type === "done" || e.type === "failed"))).toMatchObject({
      detail: expect.stringMatching(/^沒什麼急事,到處看看:探索了/),
    });
    adapter.close();
  });
});
