// Tool calls that only look run side by side; anything that changes something runs alone, in the
// order the model gave.

import { describe, expect, it } from "vitest";
import { toolBatches } from "../src/util.js";

describe("toolBatches", () => {
  const ro = (c: string) => c.startsWith("r");
  it("groups runs of read-only calls and keeps every other call alone", () => {
    expect(toolBatches([], ro)).toEqual([]);
    expect(toolBatches(["r1", "r2"], ro)).toEqual([["r1", "r2"]]);
    expect(toolBatches(["w1", "w2"], ro)).toEqual([["w1"], ["w2"]]);
    expect(toolBatches(["r1", "r2", "w1", "r3", "w2", "w3", "r4", "r5"], ro)).toEqual([
      ["r1", "r2"],
      ["w1"],
      ["r3"],
      ["w2"],
      ["w3"],
      ["r4", "r5"],
    ]);
  });
});
