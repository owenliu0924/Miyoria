import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BondBar } from "./status";

function bar(value: number) {
  render(<BondBar value={value} label="羈絆" />);
  const meter = screen.getByRole("meter", { name: "羈絆" });
  const fills = Array.from(meter.querySelectorAll<HTMLElement>("span")).slice(1);
  return { meter, fills };
}

describe("BondBar", () => {
  it("fills left of the centre when negative", () => {
    const { meter, fills } = bar(-40);
    expect(meter).toHaveAttribute("aria-valuenow", "-40");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.style.right).toBe("50%");
    expect(fills[0]?.style.width).toBe("20%");
  });

  it("fills the right half in proportion up to 100, with no second layer", () => {
    const { meter, fills } = bar(60);
    expect(meter).toHaveAttribute("aria-valuemin", "-100");
    expect(meter).toHaveAttribute("aria-valuemax", "1000");
    expect(meter).toHaveAttribute("aria-valuenow", "60");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.style.width).toBe("30%");
  });

  it("is a full right half at exactly 100", () => {
    const { fills } = bar(100);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.style.width).toBe("50%");
  });

  it("adds a primary layer past 100", () => {
    const { meter, fills } = bar(250);
    expect(meter).toHaveAttribute("aria-valuenow", "250");
    expect(fills).toHaveLength(2);
    expect(fills[0]?.style.width).toBe("50%");
    expect(fills[1]?.className).toContain("bg-primary");
    expect(fills[1]?.style.left).toBe("50%");
    expect(parseFloat(fills[1]?.style.width ?? "")).toBeCloseTo(((250 - 100) / 900) * 50, 3);
  });

  it("fills the whole bar at 1000", () => {
    const { meter, fills } = bar(1000);
    expect(meter).toHaveAttribute("aria-valuenow", "1000");
    expect(fills[1]?.style.width).toBe("50%");
  });

  it("clamps above 1000", () => {
    const { meter, fills } = bar(5000);
    expect(meter).toHaveAttribute("aria-valuenow", "1000");
    expect(fills[1]?.style.width).toBe("50%");
  });
});
