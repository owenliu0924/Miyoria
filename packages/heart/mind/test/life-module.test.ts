// The mind module runs her own life (v4 §8): the life log follows the bus, `remind_me` is a tool
// whose timers reach the main line as proposals, her Plan sees where her wants lead and cannot
// start a game past its share of her day.

import { ActuatorRegistryKey, defineCapability } from "@miyoria/gate/actions";
import {
  type EventPayload,
  Events,
  type JsonValue,
  LifeLogKey,
  Principals,
  ReminderDeskKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callKind, ScriptedProvider, texts } from "./fakes.js";
import { rig, salient, stopRigs, TEXT, wait } from "./helpers.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z"); // 20:00 at UTC+8
const MIN = 60_000;
const HOUR = 60 * MIN;

/** An `activity.changed` event with the whole snapshot, as the manager publishes it. */
function activityChanged(activity: JsonValue): EventPayload<typeof Events.ActivityChanged> {
  return {
    version: 1,
    at: toTimestamp(Date.now()),
    presence: { type: "none" },
    broadcast: { type: "off" },
    activity,
    override: null,
    scene: null,
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

function fake(name: string) {
  return defineCapability({
    name,
    summary: `fake ${name}`,
    risk: "low",
    args: z.looseObject({}),
    permission: null,
    async execute() {
      return "ok";
    },
  });
}

describe("her own life in the mind module", () => {
  it("provides the life log and her timers, and registers remind_me", async () => {
    const r = await rig(new ScriptedProvider(() => "{}"));
    expect(r.sup.services.get(LifeLogKey)?.summary()).toBeNull();
    expect(r.sup.services.get(ReminderDeskKey)?.list()).toEqual([]);
    expect(r.registry.get("self.remind")?.tool?.name).toBe("remind_me");
  });

  it("logs her own search", async () => {
    const r = await rig(new ScriptedProvider(() => "{}"));
    r.publish(Events.GateDecision, {
      id: "d1",
      at: toTimestamp(Date.now()),
      capability: "web.search",
      risk: "low",
      principal: JSON.parse(JSON.stringify(Principals.self(TEXT))) as never,
      args: { query: "鯨魚的歌" },
      why: null,
      turn: null,
      allowed: true,
      stage: "review",
      reason: "",
      reviewer: null,
    });
    await wait(10);
    expect(r.sup.services.require(LifeLogKey).summary()).toBe(
      "今天到 20:00 你做過的事:\n- 逛網路:查了「鯨魚的歌」",
    );
  });

  it("Plan sees where wanting something new leads, and a game past its share starts nothing", async () => {
    const plan = JSON.stringify({
      thought: "再玩一下好了。",
      impulses: [
        { kind: "act", capability: "game.start", args: { game: "minecraft" }, why: "想玩" },
      ],
    });
    const provider = new ScriptedProvider((req) => (callKind(req) === "plan" ? plan : "{}"));
    const r = await rig(provider, {
      extra: (sup) => {
        const registry = sup.services.require(ActuatorRegistryKey);
        registry.register(fake("game.start"));
        registry.register(fake("web.search"));
      },
    });
    // She played for nine hours today.
    const since = toTimestamp(Date.now() - 9 * HOUR);
    r.publish(
      Events.ActivityChanged,
      activityChanged({
        type: "game",
        target: "minecraft",
        phase: "running",
        task: null,
        failure: null,
        since,
      }),
    );
    await wait(10);
    r.publish(
      Events.ActivityChanged,
      activityChanged({ type: "idle", since: toTimestamp(Date.now()) }),
    );
    await wait(10);
    expect(r.sup.services.require(LifeLogKey).today()).toMatchObject([
      { activity: "game", minutes: 540 },
    ]);
    r.publish(Events.WorldSalient, salient("Owen 進了語音頻道"));
    await wait(60_000);
    const request = provider.requests("plan")[0];
    expect(request).toBeDefined();
    const [thought] = r.mind().thoughts();
    expect(thought?.intents).toEqual([]);
    expect(texts(request).data).not.toContain("找點新鮮事");
  });
});
