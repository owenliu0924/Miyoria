// Applying her `<feel>` blocks after a run (docs/design/v5-heart.md §2.9): names matched to the
// people present like an `@name`, blocked people and her own accounts never moved, the turn's caps,
// her emotion through the engine's appraisal entry.

import type {
  AccountRef,
  AffectInput,
  AffectState,
  FeelProposal,
  HeartPeople,
  PersonId,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { Wake } from "../../self/src/index.js";
import { answeredLine, applyFeel, type FeelDeps, feelCause, readFeel } from "../src/feel.js";

const CTX = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const acct = (id: string): AccountRef => ({ platform: "discord", id });

const PEOPLE = [
  { account: acct("1"), name: "Owen Liu" },
  { account: acct("2"), name: "小明:D" },
  { account: acct("3"), name: "阿哲" },
  { account: acct("4"), name: "壞人" },
  { account: acct("self"), name: "她自己" },
  { account: acct("5"), name: "Owen Chen" },
];

const WAKE: Wake = {
  kind: "addressed",
  reason: "mention",
  from: { account: acct("1"), name: "Owen Liu" },
  message: { context: CTX, id: "m1" },
};

interface Recorded {
  appraised: AffectInput[];
  felt: { person: PersonId; proposals: readonly FeelProposal[]; turn: string | null }[];
}

function deps(): { deps: FeelDeps; rec: Recorded } {
  const rec: Recorded = { appraised: [], felt: [] };
  const heart = {
    feel(person: PersonId, proposals: readonly FeelProposal[], o: { turn: string | null }) {
      rec.felt.push({ person, proposals, turn: o.turn });
      return proposals.length;
    },
  } as unknown as HeartPeople;
  const affect = {
    appraise(input: AffectInput) {
      rec.appraised.push(input);
      return [];
    },
  } as unknown as AffectState;
  return {
    rec,
    deps: {
      personOf: (a) => (a.id === "9" ? null : `p${a.id}`),
      excluded: (a) => a.id === "4" || a.id === "self",
      handleOf: (a, name) => (a.id === "2" ? "ming" : name),
      heart: () => heart,
      affect: () => affect,
      log: { debug: () => undefined },
      now: () => Date.UTC(2026, 10, 17, 4),
    },
  };
}

describe("matching the names of a feel block", () => {
  it("matches like an @name: case, a handle, a cleaned name, a first word only one has", () => {
    const { deps: d } = deps();
    const read = readFeel(
      d,
      [
        ["owen liu: 羈絆 + 「他記得」", "MING: 信任 + 「有守約」", "@阿哲: 好感 - 「他嗆我」"].join(
          "\n",
        ),
      ],
      PEOPLE,
    );
    expect(read.proposals.map((p) => [p.person, p.field, p.direction])).toEqual([
      ["p1", "bond", "up"],
      ["p2", "trust", "up"],
    ]);
    // Three people named: the third is over the turn's two.
    expect(read.over).toBe(1);
  });

  it("drops a name that is nobody here or two people, a blocked person and her own account", () => {
    const { deps: d } = deps();
    const read = readFeel(
      d,
      [
        [
          "Owen: 羈絆 + 「?」",
          "路人: 羈絆 + 「?」",
          "壞人: 心結 + 「他罵我」",
          "她自己: 好感 + 「?」",
          "阿哲: 默契 + 「接得好」",
        ].join("\n"),
      ],
      PEOPLE,
    );
    expect(read.proposals.map((p) => p.person)).toEqual(["p3"]);
    expect(read.unmatched).toBe(4);
  });

  it("counts lines that do not read, and keeps three lines at most", () => {
    const { deps: d } = deps();
    const read = readFeel(
      d,
      [
        "我: 開心 中\nOwen Liu: 羈絆 + 「a」\nOwen Liu: 好感 + 「b」",
        "我: 難過 弱\nOwen Liu: 信任 + 「c」\nOwen Liu: 自在 + 「d」\nOwen Liu: 喜歡 + 「e」",
      ],
      PEOPLE,
    );
    expect(read.self?.emotion).toBe("joy");
    expect(read.proposals.map((p) => p.field)).toEqual(["bond", "warmth", "trust"]);
    expect(read.over).toBe(1);
    // The second block's own line, and the unknown value.
    expect(read.unreadable).toBe(2);
  });
});

describe("applying a feel block", () => {
  it("sends her emotion to the engine and her proposals to the heart, with the turn", () => {
    const { deps: d, rec } = deps();
    const out = applyFeel(d, {
      turn: "t1",
      context: CTX,
      wake: WAKE,
      feel: ["我: 開心 強\nOwen Liu: 羈絆 + 「他記得我想吃布丁」\n阿哲: 好感 + 「他也有買」"],
      people: PEOPLE,
      line: "Owen Liu: 我帶了布丁",
    });
    expect(out).toMatchObject({ felt: true, applied: 2 });
    expect(rec.appraised).toEqual([
      {
        source: "feel",
        events: [
          { emotion: "joy", strength: "strong", toward: "Owen Liu", cause: "Owen Liu: 我帶了布丁" },
        ],
        context: CTX,
        at: "2026-11-17T04:00:00.000Z",
      },
    ]);
    expect(rec.felt).toEqual([
      {
        person: "p1",
        proposals: [{ field: "bond", direction: "up", quote: "他記得我想吃布丁" }],
        turn: "t1",
      },
      {
        person: "p3",
        proposals: [{ field: "warmth", direction: "up", quote: "他也有買" }],
        turn: "t1",
      },
    ]);
  });

  it("moves nothing for calm and no proposal, and nothing without the services", () => {
    const { deps: d, rec } = deps();
    const calm = applyFeel(d, {
      turn: "t2",
      context: CTX,
      wake: WAKE,
      feel: ["我: 平靜 弱"],
      people: PEOPLE,
      line: null,
    });
    expect(calm).toMatchObject({ felt: false, applied: 0 });
    expect(rec.appraised).toEqual([]);
    const off = applyFeel(
      { ...d, heart: () => null, affect: () => null },
      {
        turn: "t3",
        context: CTX,
        wake: WAKE,
        feel: ["我: 開心 中\nOwen Liu: 羈絆 + 「a」"],
        people: PEOPLE,
        line: null,
      },
    );
    expect(off).toMatchObject({ felt: false, applied: 0 });
  });

  it("takes the cause from the line answered, else from what woke her", () => {
    expect(feelCause({ kind: "world", what: "遊戲贏了" }, null, null)).toBe("遊戲贏了");
    expect(feelCause({ kind: "glance", lines: 2 }, null, "他說謝謝")).toBe("他說謝謝");
    expect(feelCause({ kind: "self", note: null }, null, null)).toBe("剛剛的對話");
    expect(answeredLine({ kind: "timer", note: "x" }, [], [])).toBeNull();
  });
});
