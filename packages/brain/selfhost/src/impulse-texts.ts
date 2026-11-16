// What she reads when something the Arbiter admitted wakes her (`impulses.ts`), and when she is
// asked to start a conversation (`chat.start`, `chat.dm`). Block 7 frames each (`WAKE_LINES` of
// `@miyoria/brain/self`, which also neutralizes them): a `world` wake says 「剛發生一件事:「…」」
// and that she may stay quiet; a `self` wake says it is her own time.

/** What happened, as the `world` wake carries it, by the impulse's source. */
export const ADMITTED_NOTES = {
  /** A game she plays: the narration of the log or the director's line. */
  game: (hint: string) => `你正在玩的遊戲:${hint.trim()}`,
  /** A song of hers: about to start, ready, done or failed (the singer says what is wanted). */
  song: (hint: string) => `唱歌的事:${hint.trim()}`,
  /** Anything else a module asked her to react to. */
  other: (hint: string) => hint.trim(),
} as const;

/** The tool name a notice wake shows (`result` wake: 「你之前開始的事有結果了(通知,…)」). */
export const NOTICE_TOOL = "通知";

/** A notice as a line of the result's data. */
export function noticeLine(ok: boolean, text: string): string {
  return `- ${ok ? "成功" : "失敗"}:${text.replace(/\s+/g, " ").trim()}`;
}

/** Why she was asked to start talking (`chat.start` / `chat.dm`), as a `self` wake's note. */
export const CHAT_NOTES = {
  start: (why: string | null) =>
    why === null || why.trim() === ""
      ? "你想在這裡主動開口聊聊"
      : `你想在這裡主動開口聊聊:${why.trim()}`,
  dm: (why: string | null) =>
    why === null || why.trim() === "" ? "你想私訊對方聊聊" : `你想私訊對方聊聊:${why.trim()}`,
} as const;
