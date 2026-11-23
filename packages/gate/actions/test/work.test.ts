import { WORK_BOND } from "@miyoria/commands";
import { type JsonValue, type Principal, Principals } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ActionRequest,
  type Capability,
  defineCapability,
  WORK_BELOW_BOND,
} from "../src/index.js";
import { AMY, CTX, gate, OWEN, OWNER } from "./helpers.js";

const request = (
  capability: string,
  principal: Principal,
  args: JsonValue = {},
): ActionRequest => ({ principal, capability, args, why: null, turn: null });

const user = (who = OWEN) => Principals.user(who, CTX);

/** A capability that needs a work node, like the workspace tools. */
function workCapability(name: string, node: string, work = true): Capability {
  return defineCapability({
    name,
    summary: "test work",
    risk: "medium",
    args: z.object({}),
    permission: node,
    work,
    async execute() {
      return "worked";
    },
  }) as Capability;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("work by bond", () => {
  it("a member whose bond reaches work_min_bond may ask for a work node", async () => {
    const g = await gate();
    g.registry.register(workCapability("t.write", "sandbox.workspace"));
    g.authorizer.grant(OWEN, WORK_BOND);
    g.social.set(OWEN, { affinity: 15 });
    expect((await g.registry.invoke(request("t.write", user()))).status).toBe("done");
    expect(g.registry.permit(OWEN, "sandbox.code.run")).toBe("bond");
    expect(g.registry.permit(OWEN, "work.delegate")).toBe("bond");
    expect(g.registry.permit(OWEN, "skills.use")).toBe("bond");
  });

  it("below the threshold she is told a reason she can pass on, not a bare refusal", async () => {
    const g = await gate();
    g.registry.register(workCapability("t.write", "sandbox.workspace"));
    g.authorizer.grant(OWEN, WORK_BOND);
    g.social.set(OWEN, { affinity: 14 });
    const out = await g.registry.invoke(request("t.write", user()));
    expect(out.status).toBe("denied");
    expect(out.decision).toMatchObject({ stage: "permission", reason: WORK_BELOW_BOND });
    expect(WORK_BELOW_BOND).toContain("還沒那麼熟");
    // Nobody the heart knows has no bond.
    expect(g.registry.permit(AMY, "sandbox.workspace")).toBe("no");
    g.authorizer.grant(AMY, WORK_BOND);
    expect(g.registry.permit(AMY, "sandbox.workspace")).toBe("below_bond");
  });

  it("the threshold is the setting", async () => {
    const g = await gate();
    g.registry.register(workCapability("t.write", "sandbox.workspace"));
    g.authorizer.grant(OWEN, WORK_BOND);
    g.social.set(OWEN, { affinity: 40 });
    g.registry.configure({ ...g.registry.config, work_min_bond: 45 });
    expect((await g.registry.invoke(request("t.write", user()))).decision.reason).toBe(
      WORK_BELOW_BOND,
    );
    g.registry.configure({ ...g.registry.config, work_min_bond: 40 });
    expect((await g.registry.invoke(request("t.write", user()))).status).toBe("done");
  });

  it("the bond stands for work nodes only, and only with work.bond", async () => {
    const g = await gate();
    g.social.set(OWEN, { affinity: 900 });
    g.authorizer.grant(OWEN, WORK_BOND);
    expect(g.registry.permit(OWEN, "test.low")).toBe("no");
    expect(g.registry.permit(OWEN, "sandbox.tool.propose")).toBe("no");
    expect(g.registry.permit(OWEN, "sandbox.workspace.all")).toBe("no");
    // Someone the owner took `work.bond` from (or a restricted role) gets nothing by bond.
    g.social.set(AMY, { affinity: 900 });
    expect(g.registry.permit(AMY, "sandbox.workspace")).toBe("no");
    // Blocked people get no invitation to come back either.
    g.authorizer.grant(AMY, WORK_BOND);
    g.social.set(AMY, { affinity: 900, blocked: true });
    expect(g.registry.permit(AMY, "sandbox.workspace")).toBe("no");
  });

  it("whoever holds the node needs no bond", async () => {
    const g = await gate();
    g.registry.register(workCapability("t.write", "sandbox.workspace"));
    g.authorizer.grant(OWNER, "sandbox.workspace");
    g.social.set(OWNER, { affinity: -100 });
    expect((await g.registry.invoke(request("t.write", user(OWNER)))).status).toBe("done");
    expect(g.registry.permit(OWNER, "sandbox.workspace")).toBe("node");
  });

  it("asking for work does not move the bond", async () => {
    const g = await gate();
    g.registry.register(workCapability("t.write", "sandbox.workspace"));
    g.authorizer.grant(OWEN, WORK_BOND);
    g.social.set(OWEN, { affinity: 20 });
    const before = structuredClone(g.social.attitude(OWEN));
    for (let i = 0; i < 3; i++) await g.registry.invoke(request("t.write", user()));
    expect(g.social.attitude(OWEN)).toEqual(before);
  });
});

describe("work limits", () => {
  it("work capabilities have no cooldown: five writes in a row all pass", async () => {
    vi.useFakeTimers();
    const g = await gate();
    g.registry.register(workCapability("t.write", "sandbox.workspace"));
    g.registry.register(workCapability("t.plain", "sandbox.workspace", false));
    g.authorizer.grant(OWEN, "sandbox.workspace");
    for (let i = 0; i < 5; i++) {
      expect((await g.registry.invoke(request("t.write", user()))).status, `${i}`).toBe("done");
    }
    // The same capability without the flag still has the medium tier's cooldown.
    expect((await g.registry.invoke(request("t.plain", user()))).status).toBe("done");
    expect((await g.registry.invoke(request("t.plain", user()))).decision.reason).toContain(
      "cooling down",
    );
  });

  it("the work tier is configured apart from the medium tier, with an hourly limit per person", async () => {
    vi.useFakeTimers();
    const g = await gate();
    g.registry.register(workCapability("t.write", "sandbox.workspace"));
    g.authorizer.grant(OWEN, "sandbox.workspace");
    g.authorizer.grant(AMY, "sandbox.workspace");
    const config = g.registry.config;
    expect(config.work).toMatchObject({ cooldown_ms: 0, per_person_per_hour: 300 });
    g.registry.configure({ ...config, work: { ...config.work, per_person_per_hour: 2 } });
    expect((await g.registry.invoke(request("t.write", user()))).status).toBe("done");
    expect((await g.registry.invoke(request("t.write", user()))).status).toBe("done");
    const third = await g.registry.invoke(request("t.write", user()));
    expect(third.decision.reason).toContain("hourly limit for this person reached (2 per hour)");
    // Someone else is not held up by it.
    expect((await g.registry.invoke(request("t.write", user(AMY)))).status).toBe("done");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect((await g.registry.invoke(request("t.write", user()))).status).toBe("done");
  });
});
