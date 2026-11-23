import type { workspace as en } from "../en/workspace.js";

export const workspace: typeof en = {
  removed: (key, old) => `- ${key}（原本為 ${old}）`,
  readFailed: (path, error) => `讀取 ${path} 失敗：${error}`,
  invalidToml: (path, error) => `${path} 不是有效的 TOML：${error}`,
  notFound: (path) => `找不到 ${path}。請先執行 \`miyoria init\` 建立設定。`,
  envOverride: (name) => `${name} 也設定於系統環境變數，執行時會覆蓋 .env 的值`,
  scaffoldProfile: (path, id) => `${path}（內建角色 ${id}）`,
  scaffoldData: (path) => `${path}（資料庫資料夾）`,
  writeFailed: (path, error) => `寫入 ${path} 失敗：${error}`,
  sources: {
    process: "環境變數",
    default: "預設值",
    unset: "未設定",
  },
  empty: "（空）",
  profileOwn: "專屬的設定與資料",
  profileShared: "安裝資料夾的設定與資料",
  profileLine: (character, id, where) => `${character}（profile ${id}，${where}）`,
  toml: {
    unclosedQuote: (key) => `\`${key}\`：引號未結束`,
    quoteNeeded: (key, ch) =>
      `\`${key}\`：含有 \`${ch}\` 的鍵名部分必須加引號，例如 modules."voice.link".bind`,
    emptyPart: (key) => `\`${key}\`：鍵名中有空的部分`,
    unexpected: (key, next) => `\`${key}\`：多出 \`${next}\``,
    emptyKey: "鍵名不可為空",
    inArrayTable: (key) => `\`${key}\` 位於 [[陣列表格]] 中，請用 \`miyoria config edit\` 修改`,
    isTable: (key) => `\`${key}\` 是表格，不能設為單一值`,
    notTable: (key) => `\`${key}\` 是單一值，不是表格`,
  },
};
