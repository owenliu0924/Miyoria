// The bus envelope (the contract's draft plus `source`) and the old forms as views of it: what
// `newEnvelope`, `eventEnvelope`, `is` and the wire adapters give, and that the `Events` namespace
// holds every registered bus topic.

import { BUS_EVENTS } from "@miyoria/contracts/events";
import { describe, expect, it } from "vitest";
import {
  type ContextKey,
  customEvent,
  EVENT_TOPICS,
  type Event,
  Events,
  eventEnvelope,
  fromLegacyEnvelope,
  is,
  isEventDefinition,
  type LegacyEnvelope,
  legacyEvent,
  newEnvelope,
  toEnvelope,
  toLegacyEnvelope,
} from "../src/index.js";

const context: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const account = { platform: "discord", id: "100" };
const T = "01JC0000000000000000000000";

describe("the Events namespace", () => {
  it("holds exactly the registered bus topics", () => {
    const here = new Set<unknown>(Object.values(Events));
    expect(here.size).toBe(BUS_EVENTS.length);
    for (const definition of BUS_EVENTS) expect(here.has(definition)).toBe(true);
  });
});

describe("eventEnvelope", () => {
  it("stamps the draft's keys, the source and the old fields as a view", () => {
    const env = eventEnvelope(
      "discord",
      Events.PlatformTyping,
      { context, account },
      {
        now: 0,
        turn: T,
      },
    );
    expect(env).toEqual({
      id: env.id,
      at: "1970-01-01T00:00:00.000Z",
      type: "platform.typing",
      v: 1,
      source: "discord",
      parent: null,
      turn: T,
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      scope: null,
      key: null,
      data: { context, account },
      ts: "1970-01-01T00:00:00.000Z",
      causation: null,
      correlation: T,
      event: { type: "platform_typing", data: { context, account } },
    });
  });

  it("takes a family member's type, and refuses one the family does not cover", () => {
    const at = "2026-11-15T00:00:00.000Z";
    const payload = {
      type: "progress" as const,
      task: "t1",
      progress: { note: "half", fraction: 0.5, at },
    } as never;
    const env = eventEnvelope("worklane", Events.TaskProgress, payload, {
      type: "worklane.task.progress",
    });
    expect(env.type).toBe("worklane.task.progress");
    expect(env.event).toEqual(customEvent("worklane.task.progress", payload));
    expect(() =>
      eventEnvelope("worklane", Events.TaskProgress, payload, { type: "worklane.task.done" }),
    ).toThrow("does not cover");
  });

  it("is a custom event in the old view for every topic without a typed variant", () => {
    const env = eventEnvelope("stage", Events.StageError, { message: "x" });
    expect(env.event).toEqual(customEvent("stage.error", { message: "x" }));
  });
});

describe("is", () => {
  it("narrows by type, family and version", () => {
    const env = newEnvelope("discord", { type: "platform_typing", data: { context, account } });
    expect(is(Events.PlatformTyping, env)).toBe(true);
    expect(is(Events.PlatformReady, env)).toBe(false);
    if (is(Events.PlatformTyping, env)) expect(env.data.account.id).toBe("100");
    const task = newEnvelope("x", customEvent("game.minecraft.task.done", {}));
    expect(is(Events.TaskDone, task)).toBe(true);
    expect(is(Events.TaskFailed, task)).toBe(false);
    expect(is(Events.PlatformTyping, { ...env, v: 2 })).toBe(false);
  });

  it("tells definitions from old-form events", () => {
    expect(isEventDefinition(Events.SingCue)).toBe(true);
    expect(isEventDefinition(customEvent("sing.cue", {}))).toBe(false);
    expect(isEventDefinition({ type: "agent_decision", data: {} })).toBe(false);
  });
});

describe("the old forms as views", () => {
  it("newEnvelope keeps the published event as the view and takes topic and payload from it", () => {
    const typed: Event = { type: "agent_turn_completed", data: { turn: T, context, text: "嗨" } };
    const a = newEnvelope("agent", typed, { now: 5, correlation: T, causation: "p" });
    expect(a.event).toBe(typed);
    expect(a).toMatchObject({
      type: "agent.turn.completed",
      data: typed.data,
      turn: T,
      parent: "p",
    });
    expect(a.data).toBe(typed.data);
    const custom = customEvent("sing.cue", { n: 1 });
    const b = newEnvelope("sing", custom);
    expect(b.event).toBe(custom);
    expect(b).toMatchObject({
      type: "sing.cue",
      data: { n: 1 },
      causation: null,
      correlation: null,
    });
  });

  it("legacyEvent gives every typed variant its own tag, and custom for the rest", () => {
    for (const [variant, topic] of Object.entries(EVENT_TOPICS)) {
      expect(legacyEvent(topic, { x: 1 })).toEqual({ type: variant, data: { x: 1 } });
    }
    expect(legacyEvent("custom", null)).toEqual(customEvent("custom", null));
  });

  it("toLegacyEnvelope writes today's keys in today's order", () => {
    const env = newEnvelope("agent", customEvent("x.y", [1]), { now: 0, correlation: T });
    expect(JSON.stringify(toLegacyEnvelope(env))).toBe(
      `{"id":"${env.id}","ts":"1970-01-01T00:00:00.000Z","source":"agent","causation":null,"correlation":"${T}","event":{"type":"custom","data":{"topic":"x.y","payload":[1]}}}`,
    );
  });

  it("an old-form envelope reads back as the same event", () => {
    const legacy: LegacyEnvelope = {
      id: "01JC0000000000000000000001",
      ts: "2026-11-14T00:00:01.123Z",
      source: "test",
      causation: null,
      correlation: T,
      event: { type: "platform_typing", data: { context, account } },
    };
    const env = fromLegacyEnvelope(legacy);
    expect(env).toMatchObject({ id: legacy.id, at: legacy.ts, type: "platform.typing", turn: T });
    expect(env.event).toBe(legacy.event);
    expect(toLegacyEnvelope(env)).toEqual(legacy);
    expect(toEnvelope(legacy)).toEqual(env);
    expect(toEnvelope(env)).toBe(env);
    const { ts: _ts, causation: _c, correlation: _r, event: _e, ...bare } = env;
    expect(toEnvelope(bare)).toEqual(env);
  });
});
