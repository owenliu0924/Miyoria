// What the room says to a member, in zh-TW: fixed words, never a verdict's reason or an error's text
// (docs/design/her-room.md §3.10).

export const ROOM_TEXT = {
  closed: "她的房間現在沒有對你開放",
  tooFast: "你說得太快了,等一下再說",
  tooLong: "這段太長了,分幾次說",
  tooManyFiles: "一次附太多檔案了",
  fileTooBig: (imageMb: number, fileMb: number) =>
    `檔案太大了(圖片最多 ${imageMb} MB,其他最多 ${fileMb} MB)`,
  empty: "說點什麼,或附一個檔案",
  uploadGone: "附加的檔案過期了,再附一次",
  poolFull: "現在收不下檔案,等一下再試",
  away: "她現在不在",
  ignored: "這句她收不到",
  held: "你說得有點快,她先聽著",
  voiceOff: "她的聲音現在沒有開",
  voiceLent: "聲音借給唱歌了,唱完就好",
  voiceFailing: "她的聲音暫時出不來",
  voiceHour: "這小時聽太多了",
  notFound: "找不到",
} as const;

/**
 * A tool's name as a few words of what she is doing (the stream's `step`): a verb phrase, since the
 * page says 「她在{label}」 and 「在幫你{label}」.
 */
export function stepLabel(tool: string): string {
  const name = tool.toLowerCase().replaceAll(".", "_");
  if (/^(web_search|search|knowledge|recall|memory|lookup)/.test(name)) return "查資料";
  if (/^(web_|browse|fetch|read_url|page_read)/.test(name)) return "看網頁";
  if (/^(image|draw|picture|imagegen)/.test(name)) return "畫圖";
  if (/^(sandbox|workspace|exec|run_|code|shell|file)/.test(name)) return "用電腦做事";
  if (/^(delegate|task|agent|helper|ask_)/.test(name)) return "請助手幫忙";
  return "想事情";
}

/** Her emotions as a member reads them: one word, no cause. */
export const MOOD_WORDS: Readonly<Record<string, string>> = {
  joy: "開心",
  anger: "生氣",
  sorrow: "有點難過",
  fear: "不安",
  surprise: "驚訝",
  disgust: "嫌棄",
  shy: "害羞",
  pride: "得意",
  jealousy: "吃醋",
  lonely: "寂寞",
  missing: "想念",
  gratitude: "感激",
  guilt: "不好意思",
  frustration: "不甘心",
};

/** What she is when she feels nothing above the floor. */
export const CALM = "平靜";
