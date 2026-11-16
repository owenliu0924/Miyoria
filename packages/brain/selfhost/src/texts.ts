// What the host writes for her to read, beside the runner's own texts (`self/src/rules.ts`). The
// owner has not read these yet; each is a candidate for rules.ts, where they move once reviewed.

import { neutralize, safeName } from "@miyoria/types";

/** Why `say` does not DM: DMs go through `message_dm`, whose gate checks consent and limits. */
export const SAY_DM = "私訊不能用 say:用 message_dm 工具(to 填對方的名字)";

/** Characters of the message quoted when someone asks her to answer it (the context menu). */
const ASKED_QUOTE_CHARS = 120;

/** Block 7's last part for a run someone asked for from the message's menu ("要她回這則"). */
export function askedLine(author: string, text: string): string {
  const flat = neutralize(text).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  const quote =
    chars.length > ASKED_QUOTE_CHARS ? `${chars.slice(0, ASKED_QUOTE_CHARS).join("")}…` : flat;
  return `有人請你回 ${safeName(author)} 的這則訊息:「${quote}」(不一定是對話紀錄最後一句)。當成對你說的回。`;
}
