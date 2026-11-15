import { customEvent, type Envelope, type Event, Events, is, serviceKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  EventBus,
  exemptFromBusCheck,
  ServiceRegistry,
  ServiceUnavailableError,
  TopicFilter,
} from "../src/index.js";

// These tests publish made-up topics.
exemptFromBusCheck(["ext.custom.a", "ext.custom.b", "ext.x.1", "ext.x.2", "ext.y.1", "ext.t"]);

// A made-up topic is published under the extension namespace (`ext.**`).
const ext = (type: string) => ({ type });

describe("TopicFilter", () => {
  it("topic_filter", () => {
    const f = new TopicFilter(["platform.*", "agent.decision"]);
    expect(f.matches("platform.message.created")).toBe(true);
    expect(f.matches("agent.decision")).toBe(true);
    expect(f.matches("platformx.y")).toBe(false);
    expect(f.matches("platform")).toBe(false);
    expect(f.matches("agent.turn.started")).toBe(false);
    expect(TopicFilter.all().matches("anything")).toBe(true);
    expect(TopicFilter.from("voice.*").matches("voice.joined")).toBe(true);
  });
});

describe("EventBus", () => {
  it("subscription_filters", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(new TopicFilter(["ext.custom.b"]));
    for (const topic of ["ext.custom.a", "ext.custom.b"]) {
      bus.publish("test", Events.ExtensionEvent, null, ext(topic));
    }
    const env = await sub.recv();
    expect(env).toMatchObject({ type: "ext.custom.b", data: null });
  });

  it("delivers in order to every subscriber, also to a waiting one", async () => {
    const bus = new EventBus();
    const a = bus.subscribe("*");
    const b = bus.subscribe(["ext.x.*"]);
    const waiting = b.recv();
    bus.publish("m", Events.ExtensionEvent, 1, ext("ext.x.1"));
    bus.publish("m", Events.ExtensionEvent, 2, {
      type: "ext.y.1",
      turn: "01JC0000000000000000000000",
    });
    bus.publish("m", Events.ExtensionEvent, 3, ext("ext.x.2"));
    expect((await waiting)?.type).toBe("ext.x.1");
    expect((await b.recv())?.type).toBe("ext.x.2");
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await a.recv())?.turn);
    expect(seen).toEqual([null, "01JC0000000000000000000000", null]);
  });

  it("drops the oldest events of a lagging subscriber", async () => {
    const bus = new EventBus({ capacity: 2 });
    const sub = bus.subscribe("*");
    for (const n of [1, 2, 3]) bus.publish("m", Events.ExtensionEvent, n, ext("ext.t"));
    const first = await sub.recv();
    expect(first).toMatchObject({ type: "ext.t", data: 2 });
  });

  it("closing ends iteration; an aborted signal closes the subscription", async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const sub = bus.subscribe("*", { signal: controller.signal });
    const seen: unknown[] = [];
    const loop = (async () => {
      for await (const env of sub) seen.push(env.data);
    })();
    bus.publish("m", Events.ExtensionEvent, 1, ext("ext.t"));
    await Promise.resolve();
    controller.abort();
    await loop;
    expect(seen).toHaveLength(1);
    expect(await sub.recv()).toBeNull();
    expect(bus.subscriberCount).toBe(0);

    const late = bus.subscribe("*", { signal: controller.signal });
    expect(late.closed).toBe(true);
  });
});

describe("publishing by definition", () => {
  const context = { platform: "discord", scope: "g", channel: "c", kind: "channel" } as const;
  it("stamps the source, the turn and the parent, and hands the payload over as it is", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(["stage.error", "worklane.task.*"]);
    const data = { message: "x" };
    const published = bus.publish("stage", Events.StageError, data, { turn: "t1", parent: "p1" });
    const viaPublisher = bus.publisher("worklane");
    const failed = {
      type: "failed" as const,
      task: "k1",
      code: "internal" as const,
      detail: "d",
      at: "2026-11-15T00:00:00.000Z",
    };
    viaPublisher(Events.TaskFailed, failed, { type: "worklane.task.failed" });
    const a = await sub.recv();
    const b = await sub.recv();
    expect(a).toBe(published);
    expect(a?.data).toBe(data);
    expect(a).toMatchObject({ type: "stage.error", source: "stage", turn: "t1", parent: "p1" });
    expect(b).toMatchObject({ type: "worklane.task.failed", source: "worklane", data: failed });
    expect(is(Events.TaskFailed, b as Envelope)).toBe(true);
    expect(is(Events.PlatformTyping, a as Envelope)).toBe(false);
  });

  it("delivers an old-form envelope as the bus envelope it stands for", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe("platform.typing");
    const event: Event = {
      type: "platform_typing",
      data: { context, account: { platform: "discord", id: "1" } },
    };
    const delivered = bus.publishEnvelope({
      id: "01JC0000000000000000000009",
      ts: "2026-11-15T00:00:00.000Z",
      source: "test",
      causation: null,
      correlation: "t",
      event,
    });
    expect(await sub.recv()).toBe(delivered);
    expect(delivered).toMatchObject({
      type: "platform.typing",
      turn: "t",
      data: event.data,
      event,
    });
  });
});

// What a reader of the old envelope form sees of an envelope it receives: the facts writer keeps
// `event` as the origin of an observation, the CLI and the panel read the same fields off the wire.
// These fields and their JSON must not change while the bus's own envelope does.
describe("the old envelope fields a subscriber reads", () => {
  const context = { platform: "discord", scope: "g", channel: "c", kind: "channel" } as const;
  const old = (env: Envelope | null) =>
    env === null
      ? null
      : JSON.stringify({
          id: env.id,
          ts: env.ts,
          source: env.source,
          causation: env.causation,
          correlation: env.correlation,
          event: env.event,
        });

  it("are the published event and its stamps, for a typed event and a custom one", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(["platform.typing", "stage.error"]);
    const typing: Event = {
      type: "platform_typing",
      data: { context, account: { platform: "discord", id: "100" } },
    };
    const first = bus.publish("discord", typing, { now: Date.UTC(2026, 10, 15, 6, 0, 0, 7) });
    const error = customEvent("stage.error", { message: "斷線" });
    const second = bus.publish("stage", error, {
      now: Date.UTC(2026, 10, 15, 6, 0, 1),
      correlation: "01JC0000000000000000000000",
      causation: first.id,
    });
    const a = await sub.recv();
    const b = await sub.recv();
    expect(old(a)).toBe(
      `{"id":"${first.id}","ts":"2026-11-15T06:00:00.007Z","source":"discord","causation":null,"correlation":null,"event":{"type":"platform_typing","data":{"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"account":{"platform":"discord","id":"100"}}}}`,
    );
    expect(old(b)).toBe(
      `{"id":"${second.id}","ts":"2026-11-15T06:00:01.000Z","source":"stage","causation":"${first.id}","correlation":"01JC0000000000000000000000","event":{"type":"custom","data":{"topic":"stage.error","payload":{"message":"斷線"}}}}`,
    );
    // Every subscriber gets the envelope `publish` returned, carrying the published event itself.
    expect(a).toBe(first);
    expect(a?.event).toBe(typing);
    expect(b?.event).toBe(error);
  });
});

describe("ServiceRegistry", () => {
  interface Greeter {
    greet(): string;
  }
  const GreeterKey = serviceKey<Greeter>("Greeter");

  it("provide_get_remove", () => {
    const reg = new ServiceRegistry();
    expect(reg.get(GreeterKey)).toBeUndefined();
    reg.provide("m", GreeterKey, { greet: () => "hi" });
    expect(reg.require(GreeterKey).greet()).toBe("hi");
    expect(reg.ownerOf(GreeterKey)).toBe("m");
    reg.removeOwnedBy("m");
    expect(reg.get(GreeterKey)).toBeUndefined();
    expect(() => reg.require(GreeterKey)).toThrow(ServiceUnavailableError);
    expect(() => reg.require(GreeterKey)).toThrow("service `Greeter` is not available");
  });
});
