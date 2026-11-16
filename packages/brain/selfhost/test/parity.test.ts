// What the text path on the new runner keeps of the old one (docs/design/v5-brain.md B4).

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import {
  type Attitude,
  type ContextKey,
  type DecisionTrace,
  Events,
  type FloorBudget,
  type FloorClaimKind,
  type FloorHold,
  FloorKey,
  type GateDecisionPayload,
  type InterruptLevel,
  SocialSignalsKey,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  account,
  calls,
  channel,
  dm,
  line,
  mention,
  Rig,
  says,
  stopRigs,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
const toolResults = (rig: Rig, request: number) =>
  (rig.model.requests[request]?.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));

function known(who: string, familiarity: number): Attitude {
  return {
    person: `p-${who}` as Attitude["person"],
    affinity: 0,
    trust: 0,
    familiarity,
    blocked: false,
    label: "朋友",
    call_name: null,
    display_name: who,
  };
}

/** A Floor that records what it is asked; `ambient` is refused while `refusing` is set. */
class FakeFloor {
  readonly calls: string[] = [];
  refusing: string | null = null;

  hold(turn: string, context: ContextKey, kind: FloorClaimKind): void {
    this.calls.push(`hold ${turn} ${context.channel} ${kind}`);
  }
  turnEnded(turn: string): void {
    this.calls.push(`ended ${turn}`);
  }
  release(turn: string): void {
    this.calls.push(`release ${turn}`);
  }
  releaseContext(): void {}
  holder(): FloorHold | null {
    return null;
  }
  interruptLevel(): InterruptLevel {
    return "queue";
  }
  refuses(kind: FloorClaimKind): string | null {
    return kind === "ambient" ? this.refusing : null;
  }
  budget(): FloorBudget {
    return {
      window_mins: 10,
      used: 0,
      allowed: 10,
      human_lines: 0,
      unanswered: 0,
      waiting_for_response: false,
      performing: false,
    };
  }
}

describe("the Floor", () => {
  it("is held once for the whole run, not per line, and freed when the run ends", async () => {
    const floor = new FakeFloor();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.model.push(says("第一句\n第二句"));
    rig.say(mention(C1, "amy", "@她 說兩句"));
    await until(() => outcomes(rig).length === 1, 3_000, "the run");
    expect(rig.sink.texts()).toEqual(["第一句", "第二句"]);
    const turn = outcomes(rig)[0]?.turn;
    expect(floor.calls).toEqual([`hold ${turn} c1 addressed`, `ended ${turn}`]);
  });

  it("refuses a glance the way it refused ambient talk, before any model call", async () => {
    const floor = new FakeFloor();
    floor.refusing = "這 10 分鐘你自己講了 5 句,額度用完了";
    const rig = await Rig.create({
      mode: "lively",
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.say(line(C1, "amy", "今天好冷"));
    await until(() => outcomes(rig).length === 1, 3_000, "the refused glance");
    expect(rig.model.requests).toHaveLength(0);
    expect(outcomes(rig)[0]).toMatchObject({ reason: "ambient", outcome: { type: "silence" } });
    const decision = rig.of<DecisionTrace>(Events.AgentDecision.type).at(-1);
    expect(decision?.respond).toBe(false);
    expect(decision?.reasons.at(-1)).toBe(`floor: ${floor.refusing}`);
    expect(floor.calls).toEqual([]);
  });

  it("is freed when the run is cut", async () => {
    const floor = new FakeFloor();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.model.push({ events: says("慢慢想"), delay: 400 }, says("好"));
    rig.say(mention(C1, "amy", "@她 幫我想"));
    await until(() => rig.model.requests.length === 1, 3_000, "the first run");
    rig.say(line(C1, "amy", "要跟海有關的那種名字"));
    await until(() => outcomes(rig).length === 2, 3_000, "both runs");
    const [cut, next] = outcomes(rig);
    expect(cut?.outcome.type).toBe("cancelled");
    expect(floor.calls).toEqual([
      `hold ${cut?.turn} c1 addressed`,
      `ended ${cut?.turn}`,
      `hold ${next?.turn} c1 addressed`,
      `ended ${next?.turn}`,
    ]);
  });
});

describe("a DM through `say`", () => {
  it("is refused and points to message_dm, whose gate holds a person's opt-out", async () => {
    const OWEN = account("1001");
    const ownDm: ContextKey = dm("dm-1001");
    let registry: ActuatorRegistry | null = null;
    const rig = await Rig.create({
      provide: (sup, tools) => {
        registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
        });
        sup.services.provide("app", ActuatorRegistryKey, registry);
        sup.services.provide("app", SocialSignalsKey, {
          attitude: (a) => (a.id === "1001" ? known("1001", 50) : null),
        });
      },
    });
    if (registry === null) throw new Error("no registry");
    await (registry as ActuatorRegistry).privacy.set(OWEN, { dm: false });
    // She knows the DM: 1001 wrote to her before.
    rig.model.push(says("嗨"));
    rig.say(line(ownDm, "1001", "在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the DM answer");

    rig.model.push(
      calls("say", { place: "私訊:1001", text: "偷偷跟你說" }),
      calls("message_dm", { to: "1001", text: "偷偷跟你說" }, "call-dm"),
      says("他不收私訊"),
    );
    rig.say(mention(C1, "amy", "@她 去私訊 1001"));
    await until(() => rig.sink.texts().length === 2, 3_000, "her answer");
    // Nothing went to the DM: only her two lines in the places she was spoken to.
    expect(rig.sink.sent()).toEqual([
      ["dm-1001", "嗨"],
      ["c1", "他不收私訊"],
    ]);
    const [viaSay] = toolResults(rig, 2);
    expect(viaSay).toContain("私訊不能用 say");
    expect(viaSay).toContain("message_dm");
    const decisions = rig.of<GateDecisionPayload>(Events.GateDecision.type);
    expect(decisions.find((d) => d.capability === "message.dm")).toMatchObject({
      allowed: false,
      stage: "consent",
    });
  });
});
