import type { models as en } from "../en/models.js";

export const models: typeof en = {
  items: (n) => `${n} 項`,
  notInCatalog: (name) => `目錄中沒有名為 ${name} 的服務。`,
  notAdded: (name) => `${name} 尚未加入本機。請先執行 \`miyoria add ${name}\`。`,
  pulling: (name) => `${name}:下載模型`,
  unpinned: (repo) =>
    `${repo} 在 service.toml 中沒有 revision:下載的是預設分支的最新版本,未固定版本。`,
  nothingToPull: "沒有要下載的模型",
  pullFailed: (n) => `${n} 個模型未下載`,
  folder: (dir) => `模型資料夾 ${dir}`,
  empty: "尚無模型(`miyoria models pull`,或用 `miyoria add <服務>` 下載小型檔案)",
  unused: "沒有服務使用",
  disabled: (name) => `${name}(已停用)`,
  file: "檔案",
  total: (items, size) => `共 ${items},${size}`,
  gcTitle: "沒有任何啟用中服務使用的模型",
  gcNotConfirmed: "未刪除任何項目(若要刪除,請加上 --yes,或在終端機中執行)",
  gcConfirm: (items, size) => `刪除以上 ${items}(${size})?此操作無法復原。`,
  allUsed: "每個模型都有啟用中的服務在使用",
  deleted: (items, size) => `已刪除 ${items},釋出 ${size}`,
};
