// What the text path on the new runner keeps of the old one (docs/design/v5-brain.md B4).

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import {
  type Attitude,
  type ContextKey,
  Events,
  type GateDecisionPayload,
  SocialSignalsKey,
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
