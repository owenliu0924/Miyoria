import type { memory as en } from "../en/memory.js";

export const memory: typeof en = {
  aside: (text) => `(${text})`,
  unknownKind: (name, kind) => `provider \`${name}\`:未知的 kind \`${kind}\``,
  badSince: (text) => `--since 必須是 ISO 日期,例如 2026-11-15:${text}`,
  badMaxUsd: (text) => `--max-usd 必須是大於 0 的數字(美元):${text}`,
  noDatabase: (path) => `找不到資料庫:${path}`,
  held: "資料庫正由其他程式開啟(Core 或其他程式)。請先停止 Core;若確定沒有問題,可加上 --force。",
  noEvents: "此資料庫沒有事件記錄,沒有可重建的內容",
  section: (path) => `重建記憶:${path}`,
  scope: (since, apply) => `自 ${since} 起的聊天事件;${apply ? "會呼叫模型" : "預覽,不呼叫模型"}`,
  sessions: (n) => `  對話(session):${n}`,
  lines: (n) => `  聊天行數:${n}`,
  segments: (todo, done) => `  段落:${todo}(尚未處理;已處理的 ${done} 段會略過)`,
  unplaced: (n) => `  無法判斷所在位置的對話 ${n} 個,已略過`,
  estimate: (prompt, completion) => `  預估:輸入 ${prompt} tokens、輸出 ${completion} tokens`,
  withReasoning: (level) => `(含思考,推理等級 ${level})`,
  cost: (usd) => `  預估費用:${usd ?? "價格未知"}`,
  vectorsOff: "  向量:未啟用([memory.embedding] provider = none),筆記僅以關鍵字搜尋",
  vectorsWaiting: (waiting, lines) => `  向量:${waiting} 行尚無向量(共 ${lines} 行)`,
  applyHint: (maxUsd) =>
    `加上 --apply 才會開始(--max-usd 設定花費上限,預設 ${maxUsd});中斷後再次執行會從上次停止處繼續。`,
  noPrice: (label) =>
    `設定中沒有 ${label ?? "此用途"} 的價格([llm.pricing]);沒有價格就無法以 --max-usd 限制花費`,
  overBudget: (estimate, limit) =>
    `預估 ${estimate} 超過上限 ${limit};執行到達上限時會停止,之後可再次執行繼續`,
  resultLabel: "結果",
  result: (label, status, segments, total, empty, abandoned) =>
    `${label}:${status};已處理 ${segments} / ${total} 段(空白 ${empty}、放棄 ${abandoned})`,
  written: (lines, dropped, episodes) =>
    `  寫入 ${lines} 行(捨棄 ${dropped} 行)、${episodes} 則情節`,
  usage: (calls, prompt, completion, usd) =>
    `  模型呼叫 ${calls} 次、輸入 ${prompt}、輸出 ${completion} tokens、花費 ${usd}`,
  vectorBatch: (done, waiting) => `  向量:已完成 ${done} 行,尚餘 ${waiting} 行`,
  whyOff: "無法載入 embedding 模型(原因見上方記錄)",
  whyStalled: "embedding 模型發生錯誤(原因見上方記錄)",
  whyAborted: "已中斷",
  vectorsAdded: (done, waiting, why) =>
    `  向量:補上 ${done} 行${
      waiting === null
        ? ""
        : `,尚有 ${waiting} 行沒有向量${why === null ? "" : `(${why};Core 執行時會在背景補上)`}`
    }`,
  done: "完成",
  doneNote: "下次啟動起,角色的記憶以筆記為主:段落即時整理、停止舊的整理流程、回想時讀取筆記",
  budgetStop: "已達花費上限而停止;再次執行會從此處繼續",
  aborted: "已中斷;再次執行會從此處繼續",
  modelError: (error) => `模型發生錯誤,已停止:${error ?? "未知錯誤"}(再次執行會繼續)`,
};
