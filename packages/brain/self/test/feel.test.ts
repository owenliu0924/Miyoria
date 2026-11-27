// Her `<feel>` block in the runner (docs/design/v5-heart.md §2.1, §2.9): read line by line, never
// shown or said in text or voice, kept for the host, a reply of only a block is silent.

import { toMessages } from "@miyoria/memory/transcript";
import { describe, expect, it } from "vitest";
import { isFeelLine, limitProposals, parseFeel } from "../src/feel.js";
import { PROFILES } from "../src/profiles.js";
import { FEEL_REMINDER, FEEL_RULES } from "../src/rules.js";
import { StepText } from "../src/screens.js";
import { addressed, calls, done, fakeTool, rig, SESSION, say } from "./harness.js";

const BLOCK = "我: 開心 中\n小明: 羈絆 + 「他記得我上次說想吃的東西」";

describe("reading a feel block", () => {
  it("reads her emotion and the proposals", () => {
    expect(parseFeel(BLOCK)).toEqual({
      self: { word: "開心", emotion: "joy", strength: "medium" },
      lines: [{ name: "小明", field: "bond", direction: "up", quote: "他記得我上次說想吃的東西" }],
      dropped: [],
    });
  });

  it("takes the shapes she may write and drops what does not read", () => {
    const parsed = parseFeel(
      [
        "- 我:難過 強",
        "我: 開心 弱",
        "@Owen：心結＋「他又放我鴿子」",
        "阿哲: 信任 - 沒有遵守約定",
        "阿哲: 好感 + ",
        "阿哲: 愛 + 「?」",
        "我: 很複雜 中",
        "隨便寫寫",
      ].join("\n"),
    );
    expect(parsed.self).toEqual({ word: "難過", emotion: "sorrow", strength: "strong" });
    expect(parsed.lines).toEqual([
      { name: "Owen", field: "grudge", direction: "up", quote: "他又放我鴿子" },
      { name: "阿哲", field: "trust", direction: "down", quote: "沒有遵守約定" },
    ]);
    expect(parsed.dropped.map((d) => d.why)).toEqual([
      "repeated",
      "no_quote",
      "unknown_field",
      "unknown_emotion",
      "malformed",
    ]);
  });

  it("drops a proposal the token limit cut off", () => {
    // The bracket never closes.
    expect(parseFeel("我: 開心 中\n小明: 羈絆 + 「他記得我上次說\n").dropped).toEqual([
      { line: "小明: 羈絆 + 「他記得我上次說", why: "cut" },
    ]);
    // No brackets, the last line, nothing after it: it may have been cut.
    const cut = parseFeel("我: 開心 中\n阿哲: 信任 - 沒有遵守約");
    expect(cut.lines).toEqual([]);
    expect(cut.dropped.map((d) => d.why)).toEqual(["cut"]);
    expect(cut.self?.emotion).toBe("joy");
    // The same line with the block ended after it reads.
    expect(parseFeel("阿哲: 信任 - 沒有遵守約定\n").lines).toEqual([
      { name: "阿哲", field: "trust", direction: "down", quote: "沒有遵守約定" },
    ]);
  });

  it("reads the bond she takes off after a bond minus, and a bare minus as no number", () => {
    const parsed = parseFeel(
      [
        "小林: 羈絆 -30「一直叫我閉嘴」",
        "小林: 羈絆 - 5 「又拿我的歌開玩笑」",
        "小林: 羈絆 －３００「騙我」",
        "小林: 羈絆 −40分 說我是工具",
        "小林: 羈絆 -1,000「x」",
        "小林: 羈絆 -2.6「四捨五入」",
        "小林: 羈絆 -「沒寫數字」",
        "小林: 羈絆 --「兩個減號」",
        "小林: 羈絆 - - -「空格隔開的減號」",
        "小林: 羈絆 ----20「四個減號」",
        "小林: 羈絆 -0「零」",
        "小林: 羈絆 - 3次放我鴿子",
        "",
      ].join("\n"),
    );
    expect(parsed.dropped).toEqual([]);
    expect(parsed.lines.map((l) => [l.direction, l.amount, l.quote])).toEqual([
      ["down", 30, "一直叫我閉嘴"],
      ["down", 5, "又拿我的歌開玩笑"],
      ["down", 300, "騙我"],
      ["down", 40, "說我是工具"],
      ["down", 1000, "x"],
      ["down", 3, "四捨五入"],
      ["down", undefined, "沒寫數字"],
      ["down", undefined, "兩個減號"],
      ["down", undefined, "空格隔開的減號"],
      ["down", 20, "四個減號"],
      ["down", undefined, "零"],
      // A digit that starts the quote is the quote's, not a number.
      ["down", undefined, "3次放我鴿子"],
    ]);
    // No number, no key: the line reads as it always did.
    expect(parsed.lines[6]).toEqual({
      name: "小林",
      field: "bond",
      direction: "down",
      quote: "沒寫數字",
    });
  });

  it("reads a number after a plus, or after another value's sign, past it by direction", () => {
    const parsed = parseFeel(
      [
        "小林: 羈絆 +30「陪我練歌」",
        "小林: 羈絆 ++「很開心」",
        "小林: 信任 --「說話不算話」",
        "小林: 心結 +50「又來了」",
        "小林: 好感 －１０「嫌我」",
        "",
      ].join("\n"),
    );
    expect(parsed.dropped).toEqual([]);
    expect(parsed.lines).toEqual([
      { name: "小林", field: "bond", direction: "up", quote: "陪我練歌" },
      { name: "小林", field: "bond", direction: "up", quote: "很開心" },
      { name: "小林", field: "trust", direction: "down", quote: "說話不算話" },
      { name: "小林", field: "grudge", direction: "up", quote: "又來了" },
      { name: "小林", field: "warmth", direction: "down", quote: "嫌我" },
    ]);
  });

  it("reads calm as no emotion, and a strength written onto the word", () => {
    expect(parseFeel("我: 平靜 弱").self).toEqual({
      word: "平靜",
      emotion: null,
      strength: "weak",
    });
    expect(parseFeel("我: 開心中").self).toEqual({
      word: "開心",
      emotion: "joy",
      strength: "medium",
    });
    expect(parseFeel("我: 害羞").self?.strength).toBe("medium");
  });

  it("keeps two people and three lines a turn, the same proposal once", () => {
    const p = (person: string, field: string, direction = "up") => ({ person, field, direction });
    const { kept, over } = limitProposals([
      p("a", "bond"),
      p("a", "bond"),
      p("b", "trust"),
      p("c", "bond"),
      p("a", "warmth"),
      p("b", "ease"),
    ]);
    expect(kept).toEqual([p("a", "bond"), p("b", "trust"), p("a", "warmth")]);
    expect(over).toBe(3);
  });

  it("knows a line of a block written without its tags", () => {
    for (const line of [
      "我: 開心 中",
      "我：難過強",
      "小明: 羈絆 + 「謝謝」",
      "小明: 羈絆 -30「閉嘴」",
      "Owen：心結 -",
      "</feel>",
    ]) {
      expect(isFeelLine(line), line).toBe(true);
    }
    for (const line of ["我覺得還好", "我: 今天好累", "小明說他很信任你", "好感度+1 哈哈"]) {
      expect(isFeelLine(line), line).toBe(false);
    }
  });
});

describe("the rules of a feel block", () => {
  it("count only what was done to her, and tell good pestering from bad", () => {
    expect(FEEL_RULES).toContain("只算對你做的事。群友之間互罵、互虧、吵架是他們自己的事");
    expect(FEEL_RULES).toContain("好的鬧:");
    expect(FEEL_RULES).toContain("這種不扣分");
    expect(FEEL_RULES).toContain("壞的鬧:");
    expect(FEEL_RULES).toContain("就為他寫一行「羈絆 -數字」");
    // Members' fights with each other are not hers to count.
    expect(FEEL_RULES).not.toContain("欺負別人");
  });

  it("make the bond minus the line for what bothered her, a grudge only beside it", () => {
    expect(FEEL_RULES).toContain("這一行不是留給最嚴重的事:有點煩就 -2、-5");
    expect(FEEL_RULES).toContain("不能代替它:寫了心結 + 的那個人,同一段一定也有一行羈絆 -數字");
    // Said again at the end of the prompt, where she reads it last.
    expect(FEEL_REMINDER).toContain("最後一定要有一段 <feel>");
    // Her earlier replies come back without their blocks; she is told why, so she does not copy.
    expect(FEEL_RULES).toContain("你之前的回覆看不到 <feel>,是因為它被收起來了");
    expect(FEEL_REMINDER).toContain("紀錄裡你之前的話沒有它,是因為被收起來了,這一則一樣要寫");
    expect(FEEL_REMINDER).toContain("就為他寫「羈絆 -數字」,小事就寫小數字");
    expect(FEEL_REMINDER).toContain("心結只能加在旁邊,不能代替它");
    expect(FEEL_REMINDER).toContain("好的鬧、群友之間互罵,不扣");
  });

  it("let her write how much bond goes, weighed against the bond they had, and only that", () => {
    expect(FEEL_RULES).toContain("數字你自己決定");
    expect(FEEL_RULES).toContain("沒有上限");
    expect(FEEL_RULES).toContain("也看你們原本的羈絆");
    expect(FEEL_RULES).toContain("除了羈絆的 -,其他都只寫方向");
    // The examples: a rise; a bond minus with a grudge beside it, and a small minus. They read.
    const examples = [...FEEL_RULES.matchAll(/<feel>\n([\s\S]*?)<\/feel>/gu)].map(
      (m) => m[1] ?? "",
    );
    expect(examples).toHaveLength(2);
    const parsed = examples.map((e) => parseFeel(e));
    expect(parsed.flatMap((p) => p.dropped)).toEqual([]);
    expect(parsed.map((p) => p.lines.map((l) => [l.name, l.field, l.direction, l.amount]))).toEqual(
      [
        [["小明", "bond", "up", undefined]],
        [
          ["阿哲", "bond", "down", 25],
          ["阿哲", "grudge", "up", undefined],
          ["小美", "bond", "down", 3],
        ],
      ],
    );
  });
});

/** Every way of cutting `whole` in two. */
function splits(whole: string): string[][] {
  const out: string[][] = [[...whole]];
  for (let i = 0; i <= whole.length; i++) out.push([whole.slice(0, i), whole.slice(i)]);
  return out;
}

describe("a feel block in her text", () => {
  const run = (unit: "line" | "sentence", parts: readonly string[]) => {
    const s = new StepText(unit);
    const out = parts.flatMap((p) => s.push(p));
    const lines = [...out, ...s.finish()].map((l) => l.text);
    return { lines, screen: s };
  };

  it("never reaches a line or a sentence, at any chunk boundary", () => {
    const whole = `<emo:happy>真的嗎!謝謝你。\n今天好開心。<feel>\n${BLOCK}\n</feel>`;
    for (const unit of ["line", "sentence"] as const) {
      for (const parts of splits(whole)) {
        const { lines, screen } = run(unit, parts);
        const said = lines.join("|");
        expect(said, `${unit} ${JSON.stringify(parts)}`).not.toMatch(/feel|我:|羈絆|小明/);
        expect(screen.feel.join("").trim()).toBe(BLOCK);
        expect(screen.silence).toBe(false);
      }
    }
  });

  it("says the sentences before the block as they come; the block adds no wait", () => {
    const s = new StepText("sentence");
    expect(s.push("好啊!我們走吧。").map((l) => l.text)).toEqual(["好啊!"]);
    expect(s.push("<feel>\n我: 開心").map((l) => l.text)).toEqual(["我們走吧。"]);
    expect(s.push(" 中\n</feel>")).toEqual([]);
    expect(s.finish()).toEqual([]);
    expect(s.feel).toEqual(["\n我: 開心 中\n"]);
  });

  it("leaves out lines of a block she wrote without the tags", () => {
    for (const unit of ["line", "sentence"] as const) {
      const { lines, screen } = run(unit, ["好喔\n我: 開心 中\n小明: 羈絆 + 「他記得」\n"]);
      expect(lines, unit).toEqual(["好喔"]);
      expect(screen.feelCut, unit).toBe(2);
    }
  });

  it("is silent when the step is only a block, also after <silence/>", () => {
    for (const text of [
      `<feel>${BLOCK}</feel>`,
      `<silence/><feel>${BLOCK}</feel>`,
      "我: 開心 中",
    ]) {
      const { lines, screen } = run("line", [text]);
      expect(lines, text).toEqual([]);
      expect(screen.silence, text).toBe(true);
    }
    expect(run("line", [`<feel>${BLOCK}</feel>`]).screen.feel).toEqual([BLOCK]);
  });
});

describe("a run with a feel block", () => {
  it("delivers only her words, keeps the block for the host and out of the transcript", async () => {
    const r = await rig([say(`<emo:happy>謝謝你記得!\n<feel>\n${BLOCK}\n</feel>`)]);
    r.line("Owen", "@她 我帶了你上次說想吃的布丁");
    const result = await r.run();
    expect(r.outlet.texts()).toEqual(["謝謝你記得!"]);
    expect(result.outcome).toBe("said");
    expect(result.feel.map((f) => f.trim())).toEqual([BLOCK]);
    const tail = r.transcript.tail(SESSION.id);
    const history = JSON.stringify(toMessages(tail));
    expect(history).not.toMatch(/feel|羈絆/);
  });

  it("is a silent run, with no fixed line, when the reply is only a block", async () => {
    const r = await rig([say(`<feel>${BLOCK}</feel>`)]);
    r.line("Owen", "@她 嗯");
    const result = await r.run();
    expect(result.outcome).toBe("silent");
    expect(r.outlet.texts()).toEqual([]);
    expect(result.feel).toEqual([BLOCK]);
  });

  it("keeps the blocks of every step, around her tool calls", async () => {
    const r = await rig([
      calls([{ name: "web_search", args: {} }], "<feel>我: 害怕 弱</feel>"),
      say("查到了。<feel>我: 開心 中</feel>"),
    ]);
    r.tools.register(fakeTool("web_search", "結果", { core: true }));
    r.line("Owen", "@她 查一下");
    const result = await r.run();
    expect(r.outlet.texts()).toEqual(["查到了。"]);
    expect(result.feel).toEqual(["我: 害怕 弱", "我: 開心 中"]);
  });

  it("is never said in voice, and a block cut by the step's token limit is swallowed", async () => {
    const r = await rig([
      [
        { type: "text_delta", text: "好啊,我們走吧。" },
        { type: "text_delta", text: "\n<feel>\n我: 開心 中\n小明: 羈" },
        done(undefined, "length"),
      ],
    ]);
    r.line("Owen", "@她 走吧");
    const result = await r.run(addressed(), { profile: PROFILES.voice });
    expect(r.outlet.texts()).toEqual(["好啊,我們走吧。"]);
    expect(result.feel.join("")).toContain("我: 開心 中");
  });
});
