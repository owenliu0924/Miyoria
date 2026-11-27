import { describe, expect, it } from "vitest";
import { WORK_CUT_LINE, workCapLine } from "../src/work-line.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.UTC(2026, 10, 23, 4);

describe("the line at the work limit", () => {
  it("is fixed, with the wait rounded up: minutes to an hour, then hours", () => {
    expect(workCapLine({ which: "hour", until: T + 7 * MINUTE }, T)).toBe(
      "你這個小時找我跑的程式有點多,大概 7 分鐘後再來。",
    );
    expect(workCapLine({ which: "hour", until: T + 61 * MINUTE }, T)).toContain("2 個小時");
    expect(workCapLine({ which: "day", until: T + 5 * HOUR }, T)).toBe(
      "你今天找我跑的程式有點多了,大概 5 個小時後再來。",
    );
  });

  it("never says a time already past", () => {
    expect(workCapLine({ which: "hour", until: T - 5 }, T)).toContain("1 分鐘");
    expect(WORK_CUT_LINE).toContain("沙箱時間用完");
  });
});
