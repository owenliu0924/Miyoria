// What she does when nothing else is going on (design doc P1): the director starts `idle` by
// itself when her body has been free for a few seconds and no decision started anything (the
// model is slow, failed, or chose nothing). Instead of standing still it picks the most useful
// small thing in reach, from the state alone: something to eat when hungry, the next pickaxe,
// wood when there is little and some in sight, else looking around somewhere new. A choice that
// just went nowhere is skipped for a while (`avoid`). Pure.

import { pickaxeTier } from "./harvest.js";
import { countOf } from "./planner.js";
import type { Snapshot } from "./summary.js";

export interface IdleChoice {
  /** A goal of the executor (`obtain`, `explore`). */
  goal: string;
  args: Record<string, unknown>;
  /** Why, in her words (the task's progress line and the start of its detail). */
  why: string;
  /** What `avoid` calls this choice. */
  key: string;
}

/** Food at or below this (of 20) with nothing to eat makes food the first thing. */
export const HUNGRY_AT = 12;
/** Fewer logs than this, with a tree in sight, makes wood worth getting. */
export const FEW_LOGS = 8;

function visible(s: Snapshot, test: (block: string) => boolean): string | null {
  for (const b of s.nearby_blocks ?? []) if (test(b.block)) return b.block;
  return null;
}

/** The choice for snapshot `s`, skipping the keys in `avoid`. Exploring is always left. */
export function chooseIdle(s: Snapshot, avoid: ReadonlySet<string> = new Set()): IdleChoice {
  const inv = s.inventory ?? {};
  const options: IdleChoice[] = [];
  if ((s.food ?? 20) <= HUNGRY_AT && countOf(inv, "#food") === 0) {
    options.push({ goal: "obtain", args: { item: "food" }, why: "肚子餓了,先找吃的", key: "food" });
  }
  const tier = pickaxeTier(inv);
  if (tier === 0) {
    options.push({ goal: "obtain", args: { item: "wooden_pickaxe" }, why: "還沒有鎬子,先做一把木鎬", key: "wooden_pickaxe" });
  } else if (tier === 1 && (countOf(inv, "#stone") >= 3 || visible(s, (b) => b === "stone" || b === "cobblestone"))) {
    options.push({ goal: "obtain", args: { item: "stone_pickaxe" }, why: "換一把石鎬", key: "stone_pickaxe" });
  }
  const log = visible(s, (b) => b.endsWith("_log") || b.endsWith("_stem"));
  const logs = countOf(inv, "#logs");
  if (log !== null && logs < FEW_LOGS) {
    options.push({
      goal: "obtain",
      args: { item: log, count: countOf(inv, log) + FEW_LOGS },
      why: "木頭不多了,旁邊剛好有樹,砍一些",
      key: `wood:${log}`,
    });
  }
  const pick = options.find((o) => !avoid.has(o.key));
  return pick ?? { goal: "explore", args: {}, why: "沒什麼急事,到處看看", key: "explore" };
}
