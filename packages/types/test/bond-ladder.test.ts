import { describe, expect, it } from "vitest";
import {
  ANCHORED_TIER_MIN,
  BOND_LADDER,
  BOND_TIERS,
  bondBand,
  RELATIONSHIP_LABELS,
  relationshipLabel,
  ringOf,
  tierFloorOf,
  tierProgress,
  tiersEntered,
} from "../src/index.js";

describe("the bond ladder", () => {
  it("runs from 認識 at 0 to 永恆羈絆 at 1000, ascending", () => {
    expect(BOND_LADDER[0]).toEqual({ min: 0, label: "認識" });
    expect(BOND_LADDER.at(-1)).toEqual({ min: 1000, label: "永恆羈絆" });
    const mins = BOND_LADDER.map((t) => t.min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    expect(new Set(mins).size).toBe(mins.length);
    // Every tier from 知心 up is one of BOND_TIERS, and nothing else is.
    expect(BOND_LADDER.filter((t) => t.min >= ANCHORED_TIER_MIN)).toHaveLength(BOND_TIERS.length);
    for (const t of BOND_LADDER) expect(RELATIONSHIP_LABELS).toContain(t.label);
  });

  it("agrees with relationshipLabel wherever familiarity is high", () => {
    for (let bond = 15; bond <= 1000; bond += 1) {
      const label = relationshipLabel({ affinity: bond, familiarity: 100 });
      expect(tierProgress(bond).tier.label).toBe(label);
    }
  });

  it("says how far into a tier a bond is and what comes next", () => {
    expect(tierProgress(30)).toEqual({
      tier: { min: 15, label: "朋友" },
      index: 1,
      next: { min: 45, label: "好朋友" },
      progress: 0.5,
    });
    expect(tierProgress(120).progress).toBe(0);
    expect(tierProgress(119.5).tier.label).toBe("摯友");
    const top = tierProgress(1000);
    expect(top.tier.label).toBe("永恆羈絆");
    expect(top.next).toBeNull();
    expect(top.progress).toBe(1);
  });

  it("reads a bond below 0 as the first tier with no progress", () => {
    const p = tierProgress(-40);
    expect(p.tier.label).toBe("認識");
    expect(p.progress).toBe(0);
    expect(p.next?.label).toBe("朋友");
    expect(tierProgress(Number.NaN).progress).toBe(0);
  });

  it("names the floor of a tier and the tiers a rise enters", () => {
    expect(tierFloorOf(-20)).toBe(0);
    expect(tierFloorOf(44.9)).toBe(15);
    expect(tierFloorOf(305)).toBe(300);
    expect(tiersEntered(100, 160).map((t) => t.min)).toEqual([120, 150]);
    expect(tiersEntered(120, 120)).toEqual([]);
    expect(tiersEntered(119, 120).map((t) => t.label)).toEqual(["知心"]);
    expect(tiersEntered(200, 100)).toEqual([]);
  });
});

describe("the ring", () => {
  it("draws one lap per 100, ten laps to 1000", () => {
    expect(ringOf(0)).toEqual({ lap: 0, fraction: 0, below: 0 });
    expect(ringOf(50)).toEqual({ lap: 0, fraction: 0.5, below: 0 });
    expect(ringOf(100)).toEqual({ lap: 1, fraction: 0, below: 0 });
    expect(ringOf(345).lap).toBe(3);
    expect(ringOf(345).fraction).toBeCloseTo(0.45);
    expect(ringOf(999).lap).toBe(9);
    expect(ringOf(1000)).toEqual({ lap: 9, fraction: 1, below: 0 });
    expect(ringOf(5000)).toEqual({ lap: 9, fraction: 1, below: 0 });
  });

  it("shows a bond below 0 apart from the laps", () => {
    expect(ringOf(-50)).toEqual({ lap: 0, fraction: 0, below: 0.5 });
    expect(ringOf(-100).below).toBe(1);
  });
});

describe("member bands", () => {
  it("keep the six old bands below 120", () => {
    expect([-60, -20, 0, 20, 50, 80].map(bondBand)).toEqual([
      "很差",
      "不太好",
      "普通",
      "不錯",
      "很好",
      "非常好",
    ]);
    expect(bondBand(-50)).toBe("很差");
    expect(bondBand(-15)).toBe("不太好");
    expect(bondBand(14.9)).toBe("普通");
  });

  it("go on to 1000 instead of stopping at 75", () => {
    expect([119, 120, 240, 450, 750, 999, 1000].map(bondBand)).toEqual([
      "非常好",
      "很親近",
      "心意相通",
      "像家人一樣",
      "無可取代",
      "無可取代",
      "永恆的羈絆",
    ]);
  });
});
