// 2026-11-09: a model with thinking off wrote its reasoning as the reply, and every line went to
// Discord as a message (23 in one turn). The net the runner's screens use (leak.ts; the runner's
// send boundary is tested in `@miyoria/brain/self`).

import { describe, expect, it } from "vitest";
import {
  isSelfTalk,
  judgeLine,
  looksLikeReasoning,
  PromptEcho,
  ReasoningGuard,
  ReplyScreen,
  reasoningScore,
} from "../src/leak.js";

const INCIDENT = [
  "好，驗收通過。A = (2, 8)。",
  "現在情緒方面：心情很好、得意，表現出來是別扭地說「……謝啦」轉移話題。語氣要傲嬌一下。",
  "回覆要短，一兩句到三句。且正在唱歌。",
  "可以說：「嗯，A 就是 (2,8)，聯立那兩行沒偷懶。過關了。」加一點得意。",
  "情緒標記： 或 。他算對了，我有點得意。 用 smug 吧，但設定說表現是 embarrassed。",
];

describe("reasoning that is not a reply", () => {
  it("plans about tone, length, emotion tag and drafts are recognised", () => {
    expect(looksLikeReasoning(INCIDENT[1] ?? "")).toBe(true);
    expect(looksLikeReasoning(INCIDENT[2] ?? "")).toBe(true);
    expect(looksLikeReasoning(INCIDENT[3] ?? "")).toBe(true);
    expect(looksLikeReasoning(INCIDENT[4] ?? "")).toBe(true);
    expect(looksLikeReasoning("<think>先算一下</think>")).toBe(true);
  });

  it("her own words are not", () => {
    for (const line of [
      "嗯，A 就是 (2,8)，聯立那兩行沒偷懶。過關了。",
      "……謝啦。好了，這個話題結束！",
      "這題的答案是 x = 2，所以 A = (2, 8)。",
      "等一下，你剛剛說的是哪一題？",
      "我可以說的是，這首歌真的很好聽。",
    ]) {
      expect(reasoningScore(line)).toBeLessThan(2);
    }
  });

  it("the prompt's own tags with their attributes, and its lines, are a leak", () => {
    for (const line of [
      "<reply_to>",
      "< style_note >短短的",
      '<data source="memory" title="你記得的事">',
      '<person name="阿明" relation="朋友"/>',
      '<example situation="被餵白飯">',
      "這回合想用顏文字的話從這幾個挑:(≧▽≦)",
      "⟦資料 來源=memory 標題=你記得的事⟧",
      "要回的訊息:阿明 問你",
    ]) {
      expect(reasoningScore(line), line).toBe(2);
    }
    // Her tags, a kaomoji, a word that starts like a tag are her words.
    for (const line of [
      "<emo:happy>好耶 (≧▽≦)",
      "<voice>えっ</voice>欸,真的嗎?",
      "<silence/>",
      "replying 中……才怪",
      "1 < 2 啦",
    ]) {
      expect(reasoningScore(line), line).toBe(0);
    }
  });

  it("a bare tag of the prompt's structure alone on its line is left out, not the reply", () => {
    for (const line of [
      "</now>",
      "</data>",
      "<turn>",
      "<example>",
      "<chat>星野: 請你吃白飯</chat>",
    ]) {
      expect(judgeLine(line), line).toEqual({ score: 1, text: null });
    }
    // Her reply in the examples' wrapping is hers, without it.
    expect(judgeLine("<reply>好耶</reply>")).toEqual({ score: 0, text: "好耶" });
    const screen = new ReplyScreen<{ text: string }>();
    const sent: string[] = [];
    for (const text of ["</now>", "欸你回來啦!", "今天考得怎樣?"]) {
      sent.push(...screen.push({ text }).send.map((i) => i.text));
    }
    sent.push(...screen.flush().map((i) => i.text));
    expect(sent).toEqual(["欸你回來啦!", "今天考得怎樣?"]);
    expect(screen.dropped).toBe(false);
    expect(screen.droppedLines).toBe(1);
  });

  it("two lines that think aloud are a leak, one is not", () => {
    const guard = new ReasoningGuard();
    expect(guard.drops("等一下，這張圖……他把斜率算成 1/2？")).toBe(false);
    expect(guard.drops("我得驗算。B(-4,-4)，C(5.6, 0.8)。")).toBe(true);
    expect(guard.leaking).toBe(true);
    // Everything after it goes too.
    expect(guard.drops("好啦，答案對了。")).toBe(true);
  });
});

describe("notes to herself", () => {
  it("a third-person instruction to herself is one, words to someone are not", () => {
    expect(isSelfTalk("莎露朵在問我上面訊息寫什麼,直接念給她聽就好。")).toBe(true);
    expect(isSelfTalk("直接念給她聽就好。")).toBe(true);
    expect(isSelfTalk("Owen 要我幫他查天氣，查完回他就好")).toBe(true);
    for (const line of [
      "你直接念給她聽就好。",
      "他在問我要不要一起玩，我說好啊！",
      "她叫我唱歌我就唱了。",
      "上面寫的是「明天見」。",
    ]) {
      expect(isSelfTalk(line), line).toBe(false);
    }
  });

  it("only that line is left out of the reply", () => {
    const screen = new ReplyScreen<{ text: string }>();
    const sent: string[] = [];
    for (const text of [
      "莎露朵在問我上面訊息寫什麼,直接念給她聽就好。",
      "上面寫的是「明天見」。",
      "就這樣～",
    ]) {
      sent.push(...screen.push({ text }).send.map((i) => i.text));
    }
    sent.push(...screen.flush().map((i) => i.text));
    expect(sent).toEqual(["上面寫的是「明天見」。", "就這樣～"]);
    expect(screen.selfTalk).toBe(1);
    expect(screen.dropped).toBe(false);
  });
});

// Review 2026-11-27: ordinary lines dropped the reply, and the owner kept seeing the fixed line
// 「欸?我剛剛恍神了,可以再說一次嗎?」 instead.
describe("her ordinary words are not a leak", () => {
  const ORDINARY = [
    "我的人設是鯨魚娘",
    "這個角色設定好可愛",
    "官方設定說她18歲",
    "分析:這題其實是在考排列組合",
    "我要回答你這題…先等我一下",
    "我應該先說聲抱歉",
    "HTML 裡沒有 <example> 這個標籤啦",
    "<data> 跟 <chat> 都不是 HTML 標籤",
    "你回 <reply> 也沒用",
    "<turn> 是什麼?<now> 又是什麼?",
    "用 `<think>` 包起來的才會被藏起來",
    "你可以說:「我不要」",
    "你的回覆要短一點喔",
    "等一下,你剛剛說的是哪一題?",
  ];

  it("one at a time", () => {
    for (const line of ORDINARY) expect(looksLikeReasoning(line), line).toBe(false);
  });

  it("all in one reply, every line goes out", () => {
    const screen = new ReplyScreen<{ text: string }>();
    const sent: string[] = [];
    for (const text of ORDINARY) sent.push(...screen.push({ text }).send.map((i) => i.text));
    sent.push(...screen.flush().map((i) => i.text));
    expect(sent).toEqual(ORDINARY);
    expect(screen.dropped).toBe(false);
  });

  it("a ``` block is never judged: it goes out in its place", () => {
    const screen = new ReplyScreen<{ text: string }>();
    const code = [
      "```",
      "<example>",
      "<data>",
      "回覆要短",
      "情緒標記",
      "<think>x</think>",
      "```",
    ].join("\n");
    const sent = [
      ...screen.push({ text: "給你:" }).send,
      ...screen.push({ text: code }, true).send,
      ...screen.push({ text: "這樣就好。" }).send,
      ...screen.flush(),
    ].map((i) => i.text);
    expect(sent).toEqual(["給你:", code, "這樣就好。"]);
  });
});

describe("real leaks are still caught", () => {
  it("reasoning that consults her setting for the reply", () => {
    for (const line of [
      "但設定說表現是 embarrassed。",
      "人設上她要傲嬌,語氣不能太直接。",
      "角色設定是傲嬌,所以回覆要別扭一點。",
    ]) {
      expect(looksLikeReasoning(line), line).toBe(true);
    }
  });

  it("two hints in a row are a leak, two apart are not", () => {
    const leak = new ReasoningGuard();
    expect(leak.drops("分析:使用者在問 A 點座標。")).toBe(false);
    expect(leak.drops("我應該先回答座標,再誇他一下。")).toBe(true);

    const apart = new ReasoningGuard();
    expect(apart.drops("分析:這題是排列組合。")).toBe(false);
    expect(apart.drops("答案是 120 種。")).toBe(false);
    expect(apart.drops("我應該先說聲抱歉,剛剛算錯了。")).toBe(false);
    expect(apart.leaking).toBe(false);
  });

  it("a line that recites her prompt", () => {
    const prompt = [
      "# 規則",
      "- 只寫要給人看的話。盤算放心裡,不要寫出來;不要用括號寫動作或旁白。",
      "- 說話風格:「欸~你回來啦」這種口氣,短短的。",
    ].join("\n");
    const echo = new PromptEcho(prompt);
    expect(
      looksLikeReasoning("只寫要給人看的話。盤算放心裡,不要寫出來;不要用括號寫動作或旁白。", echo),
    ).toBe(true);
    expect(
      looksLikeReasoning("我的規則是:只寫要給人看的話。盤算放心裡,不要寫出來;不要用括號寫", echo),
    ).toBe(true);
    // Short shared words, and a sample line the prompt quotes, are hers to say.
    expect(looksLikeReasoning("只寫要給人看的話?好啦。", echo)).toBe(false);
    expect(looksLikeReasoning("欸~你回來啦", echo)).toBe(false);
  });
});
