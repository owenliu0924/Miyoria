// The agent with the Arbiter as the one gate (docs/design/v2-architecture.md §3.3): her intents
// go through it, `agent.initiative` requests become impulses, the coordinator only says
// whether the place is free, and the level's gap is the Arbiter's rule.

import { ActuatorRegistry, defaultActionsConfig } from "@miyoria/gate/actions";
import { MockProvider } from "@miyoria/llm/llm";
import { ToolRegistry } from "@miyoria/llm/tools";
import { FactsModule } from "@miyoria/memory/facts";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type ArbiterDecision,
  ArbiterKey,
  type ContextKey,
  Events,
  IntentSinkKey,
  type JsonValue,
  newImpulse,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArbiterModule } from "../../arbiter/src/index.js";
import {
  channel,
  Harness,
  incoming,
  noCheck,
  type Pub,
  SlowProvider,
  stopHarnesses,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 local (UTC+8): outside quiet hours.
  vi.setSystemTime(Date.UTC(2026, 10, 3, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

async function rig(
  mode: string,
  config: JsonValue,
  chat: MockProvider | SlowProvider,
  arbiter: JsonValue = {},
) {
  const tools = new ToolRegistry();
  const registry = new ActuatorRegistry({
    services: new ServiceRegistry(),
    tools,
    builtins: false,
  });
  registry.configure(defaultActionsConfig());
  const h = await Harness.build(mode, config, chat, null, {
    appTools: tools,
    actuators: registry,
    roll: 0.5,
    before: [[new FactsModule(null, "p"), null]],
    modules: [[new ArbiterModule("p"), arbiter]],
  });
  const decisions = h.sup.bus.subscribe(Events.ArbiterDecided.type);
  return {
    h,
    intents: h.sup.services.require(IntentSinkKey),
    arbiter: h.sup.services.require(ArbiterKey),
    decisions: (): ArbiterDecision[] => {
      const out: ArbiterDecision[] = [];
      for (let env = decisions.tryRecv(); env !== null; env = decisions.tryRecv()) {
        out.push(env.data as ArbiterDecision);
      }
      return out;
    },
  };
}

const initiative = (context: ContextKey, reason: string, hint = ""): Pub => [
  Events.AgentInitiative,
  { context, reason, hint, about: [] },
];

describe("the agent with the Arbiter", () => {
  it("an announcement is not her own start: no level gap, not counted", async () => {
    const chat = new MockProvider("chat").reply("我要唱囉").reply("下一首").reply("第三首");
    const r = await rig("quiet", noCheck(), chat);
    const c = channel("c");
    for (const _ of [1, 2, 3]) {
      r.h.publish(...initiative(c, "song_start", "下一首要開始了"));
      await wait(100);
    }
    expect(r.h.sink.texts()).toEqual(["我要唱囉", "下一首", "第三首"]);
    expect(r.decisions().map((d) => [d.source, d.verdict])).toEqual([
      ["song", "accepted"],
      ["song", "accepted"],
      ["song", "accepted"],
    ]);
    expect(r.arbiter.ledger(c).limits.initiatives_today).toBe(0);
    // Her trace still says what it was.
    expect(r.h.traces().at(-1)?.reasons[0]).toBe("initiative:song_start");
  });

  it("a busy place defers an impulse until the turn in flight is done", async () => {
    const chat = new SlowProvider(2000);
    const r = await rig("always", noCheck(), chat, { retry_ms: 500 });
    const c = channel("c");
    r.h.say(incoming(c, "Owen", "在嗎"));
    await wait(1600);
    expect(chat.calls).toBe(1);
    r.h.sup.bus.publish(
      "sing",
      Events.ArbiterImpulse,
      newImpulse(
        {
          source: "song",
          context: c,
          ttlMs: 60_000,
          why: "報幕",
          hint: "要唱了",
          reason: "song_start",
        },
        Date.now(),
      ),
    );
    await wait(100);
    expect(r.decisions().map((d) => [d.verdict, d.reason])).toEqual([["deferred", "busy"]]);
    expect(chat.calls, "does not interrupt her reply").toBe(1);
    await wait(3000);
    expect(chat.calls, "starts once the context is free").toBe(2);
    expect(r.decisions().map((d) => d.verdict)).toContain("accepted");
    // No "skipped" trace for it: the Arbiter waited instead.
    expect(r.h.traces().some((t) => t.reasons.some((x) => x.startsWith("skipped")))).toBe(false);
  });
});
