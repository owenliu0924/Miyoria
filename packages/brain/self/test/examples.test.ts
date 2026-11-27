// Her example dialogues as the text and voice runs read them. Review 2026-11-27: none of them
// had a feel block, so the examples taught her to leave it out.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exampleDialogues, examplesBlock } from "../../agent/src/index.js";
import { parseFeel } from "../src/feel.js";
import { feels } from "../src/rules.js";

const FILE = fileURLToPath(
  new URL("../../../../profiles/deepseek-chan/persona/examples/basic.md", import.meta.url),
);
const NAMES = ["DeepSeek-chan"];
const dialogues = exampleDialogues([readFileSync(FILE, "utf8")]);

/** The inside of each `<feel>` block of `text`. */
function blocks(text: string): string[] {
  return [...text.matchAll(/<feel>([\s\S]*?)<\/feel>/gu)].map((m) => m[1] ?? "");
}

describe("the example dialogues", () => {
  it("every reply of hers ends with a feel block that reads, for the runs that feel", () => {
    expect(feels("text") && feels("voice")).toBe(true);
    const rendered = examplesBlock(dialogues, NAMES, { feel: true }) ?? "";
    const replies = [...rendered.matchAll(/<reply>([\s\S]*?)<\/reply>/gu)].map((m) => m[1] ?? "");
    expect(replies.length).toBeGreaterThan(dialogues.length);
    const parsed = [];
    for (const reply of replies) {
      expect(reply.trimEnd(), reply).toMatch(/<\/feel>$/u);
      const [inside] = blocks(reply);
      const feel = parseFeel(inside ?? "");
      expect(feel.dropped, reply).toEqual([]);
      expect(feel.self, reply).not.toBeNull();
      parsed.push(feel);
    }
    const lines = parsed.flatMap((p) => p.lines);
    // Good banter: a plus of rapport, no minus. Pushing on after a no: a small bond minus.
    expect(lines).toContainEqual(expect.objectContaining({ field: "rapport", direction: "up" }));
    const minus = lines.filter((l) => l.direction === "down");
    expect(minus).toEqual([expect.objectContaining({ field: "bond", amount: 5 })]);
  });

  it("whatever else reads them sees no feel block", () => {
    const rendered = examplesBlock(dialogues, NAMES) ?? "";
    expect(rendered).not.toContain("<feel");
    expect(rendered).not.toContain("我: ");
    expect(rendered).toContain("<reply><silence/></reply>");
  });
});
