import { customEvent, type Envelope, type Event, serviceKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  EventBus,
  exemptFromBusCheck,
  ServiceRegistry,
  ServiceUnavailableError,
  TopicFilter,
} from "../src/index.js";

// These tests publish made-up topics.
exemptFromBusCheck(["custom.a", "custom.b", "x.1", "x.2", "y.1", "t"]);

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
    const sub = bus.subscribe(new TopicFilter(["custom.b"]));
    for (const topic of ["custom.a", "custom.b"]) bus.publish("test", customEvent(topic, null));
    const env = await sub.recv();
    expect(env?.event).toEqual(customEvent("custom.b", null));
  });

  it("delivers in order to every subscriber, also to a waiting one", async () => {
    const bus = new EventBus();
    const a = bus.subscribe("*");
    const b = bus.subscribe(["x.*"]);
    const waiting = b.recv();
    bus.publish("m", customEvent("x.1", 1));
    bus.publish("m", customEvent("y.1", 2), { correlation: "01JC0000000000000000000000" });
    bus.publish("m", customEvent("x.2", 3));
    expect((await waiting)?.event.data).toMatchObject({ topic: "x.1" });
    expect((await b.recv())?.event.data).toMatchObject({ topic: "x.2" });
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await a.recv())?.correlation);
    expect(seen).toEqual([null, "01JC0000000000000000000000", null]);
  });

  it("drops the oldest events of a lagging subscriber", async () => {
    const bus = new EventBus({ capacity: 2 });
    const sub = bus.subscribe("*");
    for (const n of [1, 2, 3]) bus.publish("m", customEvent("t", n));
    const first = await sub.recv();
    expect(first?.event).toEqual(customEvent("t", 2));
  });

  it("closing ends iteration; an aborted signal closes the subscription", async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const sub = bus.subscribe("*", { signal: controller.signal });
    const seen: unknown[] = [];
    const loop = (async () => {
      for await (const env of sub) seen.push(env.event.data);
    })();
    bus.publish("m", customEvent("t", 1));
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
