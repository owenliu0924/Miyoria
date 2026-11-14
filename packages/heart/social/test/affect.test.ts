// The social side of the affect layer: one label scale and the bond changes Reflect proposes.

import type { Relationship } from "@miyoria/store";
import { AFFECT_BOND_TOPIC, relationshipLabel } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { applyBond, label, socialConfig } from "../src/index.js";
import { acc, dm, Harness, t } from "./helpers.js";

describe("one label scale", () => {
  it("`label` is `relationshipLabel` for every combination", () => {
    for (let affinity = -100; affinity <= 100; affinity += 5) {
      for (const familiarity of [0, 2, 3, 9, 10, 29, 30, 80]) {
        expect(label({ affinity, familiarity } as Relationship)).toBe(
          relationshipLabel({ affinity, familiarity }),
        );
      }
    }
  });

  it("the attitude carries the label of the shared scale, and what the affect card needs", async () => {
    const h = new Harness();
    await h.say("discord:2", "Amy", "你好", dm(), t(1, 10));
    const attitude = h.social.attitude(acc("discord:2"));
    expect(attitude).toMatchObject({
      label: relationshipLabel({
        affinity: h.rel("discord:2").affinity,
        familiarity: h.rel("discord:2").familiarity,
      }),
      owner: false,
      display_name: "Amy",
      interactions: 1,
    });
    expect(attitude?.last_interaction).not.toBeNull();
  });
});

describe("bond changes proposed by Reflect", () => {
  it("are applied to the relationship as small steps", async () => {
    const h = new Harness(socialConfig());
    await h.say("discord:2", "Amy", "你好", dm(), t(1, 10));
    const person = h.person("discord:2");
    const before = h.rel("discord:2");
    await applyBond(
      h.social,
      { person, affinity: 2, trust: 1, familiarity: 2, why: "她很照顧我" },
      t(1, 11),
    );
    const after = h.rel("discord:2");
    expect(after.affinity).toBeCloseTo(before.affinity + 2, 6);
    expect(after.trust).toBeCloseTo(before.trust + 1, 6);
    expect(after.familiarity).toBeCloseTo(before.familiarity + 2, 6);
    expect(h.store.deltas(person).map((d) => d.reason)).toContain("reflect: 她很照顧我");
  });

  it("ignores malformed payloads", async () => {
    const h = new Harness(socialConfig());
    await h.say("discord:2", "Amy", "你好", dm(), t(1, 10));
    const before = JSON.stringify(h.rel("discord:2"));
    await applyBond(h.social, "nonsense", t(1, 11));
    await applyBond(h.social, { person: "x" }, t(1, 11));
    await applyBond(h.social, { person: h.person("discord:2") }, t(1, 11));
    expect(JSON.stringify(h.rel("discord:2"))).toBe(before);
    expect(AFFECT_BOND_TOPIC).toBe("affect.bond");
  });
});
