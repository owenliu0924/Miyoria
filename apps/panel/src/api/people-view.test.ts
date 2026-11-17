import type { HeartHistoryEntry, PersonRow } from "@miyoria/contracts/api";
import { describe, expect, it } from "vitest";
import { cardsOf, levelsOf, summaryOf, updateBodyOf } from "./people-view";

const AT = "2026-11-01T00:00:00Z";

const row = (over: Partial<PersonRow>): PersonRow => ({
  person: { id: "P1", display_name: "Owen", created_at: AT, accounts: [] },
  has_row: true,
  blocked: false,
  owner: false,
  tier: "朋友",
  bond: 15,
  ring: { lap: 0, fraction: 0.15, full: false, below: 0 },
  trust: 50,
  familiarity: 2,
  warmth: 0,
  respect: 0,
  ease: 0,
  grudge: 0,
  longing: 0,
  rapport: 0,
  cares: 0.1,
  stance: "",
  impression: "喜歡拉麵",
  public_feeling: null,
  call_name: null,
  tags: [],
  interactions: 3,
  last_interaction: null,
  last_seen: null,
  last_together: null,
  updated_at: AT,
  ...over,
});

const change = (field: HeartHistoryEntry["field"], delta: number, quote: string): HeartHistoryEntry => ({
  id: `${field}${delta}`,
  at: AT,
  field,
  delta,
  value_after: 0,
  proposed: null,
  cause: "feel",
  reason_quote: quote,
});

describe("the people route for the old pages", () => {
  it("maps a row onto the old summary and card, and someone without a row onto no relationship", () => {
    const summary = summaryOf(row({}));
    expect(summary.relationship).toMatchObject({ affinity: 15, notes: "喜歡拉麵", familiarity: 2 });
    expect(summary.label).toBe("朋友");
    expect(summaryOf(row({ has_row: false })).relationship).toBeNull();
    const cards = cardsOf({ items: [row({ has_row: false }), row({ bond: 10 }), row({ bond: 300 })] });
    expect(cards.map((c) => c.affinity)).toEqual([300, 10]);
    expect(cards[0]).toMatchObject({ level: 300, feeling: "喜歡拉麵", stance: null });
  });

  it("walks the levels back from now, oldest first, leaving other numbers out", () => {
    // Newest first, as the route pages: bond +5 after bond +10 and familiarity +1.
    const history = levelsOf(
      [change("bond", 5, "b"), change("warmth", 0.1, ""), change("familiarity", 1, ""), change("bond", 10, "a")],
      row({ bond: 15, familiarity: 2 }),
    );
    expect(history.map((d) => [d.affinity, d.familiarity, d.reason])).toEqual([
      [10, 1, "feel: a"],
      [10, 2, "feel"],
      [15, 2, "feel: b"],
    ]);
  });

  it("sends the old notes as the impression", () => {
    expect(updateBodyOf({ notes: "x", blocked: true })).toEqual({ impression: "x", blocked: true });
    expect(updateBodyOf({ call_name: null })).toEqual({ call_name: null });
  });
});
