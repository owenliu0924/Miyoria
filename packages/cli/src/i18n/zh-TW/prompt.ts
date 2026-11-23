import type { prompt as en } from "../en/prompt.js";

export const prompt: typeof en = {
  notTty: (hint) => `此指令需要互動式終端機;${hint}`,
  notTtyHint: "在腳本中請改用 `miyoria config set <key> <value>`",
  enterKeeps: "(按 Enter 保留目前的值)",
  selectHint: "(↑↓ 移動,Enter 選擇,Esc 返回)",
  multiSelectHint: "(↑↓ 移動,空白鍵勾選,Enter 確認,Esc 返回)",
};
