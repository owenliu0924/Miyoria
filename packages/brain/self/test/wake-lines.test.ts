import { describe, expect, it } from "vitest";
import { WAKE_LINES } from "../src/rules.js";

describe("the turn line of an addressed run", () => {
  it("quotes the line she answers, not the transcript's newest", () => {
    expect(WAKE_LINES.mention("amy", ["晚餐吃什麼"])).toBe(
      "amy 在叫你:要回的是他這句「晚餐吃什麼」。其他人的話是背景;有叫你的人之後會輪到。",
    );
  });

  it("names the first and the last of several lines", () => {
    expect(WAKE_LINES.dm("amy", ["在嗎", "", "幫我看一下"])).toBe(
      "amy 私訊你:要回的是他從「在嗎」到「幫我看一下」這幾句。",
    );
  });

  it("points at a message without words instead of an empty quote", () => {
    expect(WAKE_LINES.reply("amy", [" "])).toBe(
      "amy 回覆了你說的話:要回的是他剛傳的那則(沒有文字)。其他人的話是背景;有叫你的人之後會輪到。",
    );
  });

  it("says only who when the lines are not known", () => {
    expect(WAKE_LINES.name("amy")).toBe("amy 提到你的名字。");
  });
});
