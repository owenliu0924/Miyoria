// The exchange's pictures: each one draws (a smoke test of every template), ends with the small
// print, states the colour convention in a legend, and switches red and green with it.

import type { PictureKind } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { conventionWord, moveColors } from "../src/pictures/exchange.js";
import { layoutPicture, PICTURE_SAMPLES } from "../src/pictures/index.js";

const KINDS = [
  "exchange_overview",
  "exchange_quote",
  "exchange_portfolio",
  "exchange_rich",
  "exchange_receipt",
  "exchange_bankrupt",
] as const satisfies readonly PictureKind[];

const BASE = "魚幣是遊戲點數";

describe("the exchange pictures", () => {
  it.each(KINDS)("%s draws, with the small print at the bottom", (kind) => {
    const layout = layoutPicture(kind, PICTURE_SAMPLES[kind] as never);
    const svg = layout.svg(null);
    expect(svg).toContain(BASE);
    expect(layout.alt.length).toBeGreaterThan(5);
  });

  it("states the convention and swaps red and green with it", () => {
    expect(moveColors("tw").up).toBe(moveColors("us").down);
    expect(moveColors("tw").down).toBe(moveColors("us").up);
    const tw = layoutPicture("exchange_quote", PICTURE_SAMPLES.exchange_quote).svg(null);
    const us = layoutPicture("exchange_quote", { ...PICTURE_SAMPLES.exchange_quote, colors: "us" }).svg(
      null,
    );
    expect(tw).toContain(conventionWord("tw"));
    expect(us).toContain(conventionWord("us"));
    // The sample is up: its line is drawn in the convention's up colour.
    expect(tw).toContain(`stroke="${moveColors("tw").up}"`);
    expect(us).toContain(`stroke="${moveColors("us").up}"`);
    // Never colour alone: the arrow and sign are written.
    expect(tw).toContain("▲ +1.7%");
  });
});
