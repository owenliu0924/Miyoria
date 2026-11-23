import type { migrate as en } from "../en/migrate.js";

export const migrate: typeof en = {
  reviewSing: (keys) =>
    `sing：${keys} 保留在 [services.sing] env；hostd 的顯示卡仲裁（GPU arbiter）讀取的就是這些值，請確認是否仍正確`,
  reviewAddress: (module, key, set) =>
    `[modules.${module}] ${key}：舊設定${
      set ? "有設定（已不再有預設值；原樣保留在 miyoria.toml）" : "未設定"
    }；由本機的 hostd 執行此服務時，不需要設定任何位址`,
  exists: (file) => `${file} 已存在。若要覆寫，請加上 --force。`,
  dryRun: (file) => `將寫入 ${file}（--dry-run：未寫入）`,
  wrote: (file) => `已寫入 ${file}`,
  linkNote:
    "本機加入 Core 之後（`miyoria host join`），語音節點 與 stage 的連線位址和 token 由 Core 經 hostd 提供；尚未加入的主機仍使用 語音節點 自己的 .env。",
  notCarried: (note) => `未移轉：${note}`,
  review: (line) => `請確認：${line}`,
};
