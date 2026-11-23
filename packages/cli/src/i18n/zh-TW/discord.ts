import type { discord as en } from "../en/discord.js";

export const discord: typeof en = {
  noToken:
    "尚未設定 Discord bot token（DISCORD_BOT_TOKEN）。請在 .env 設定，或用 `miyoria config` → Discord bot 設定。",
  apiStatus: (method, route, status) => `Discord API ${method} ${route} 回應 ${status}`,
  noApplicationId: "Discord 沒有回傳 application ID",
  willDelete: (guilds) =>
    `將刪除 bot 的所有斜線指令：全域指令，以及 ${guilds} 個伺服器的伺服器指令。`,
  reregistered: "（下次啟動 `miyoria core` 時會重新註冊）",
  needYes: "非互動環境請加上 --yes 確認。",
  confirm: "確定要刪除嗎？",
  cancelled: "已取消。",
  cleared: (scopes) => `已清除 ${scopes} 個範圍的指令`,
  scopeGlobal: "全域",
  scopeGuild: (id) => `伺服器 ${id}`,
  scopeFailed: (scope, error) => `${scope}：${error}`,
  someFailed: "部分範圍清除失敗（bot 可能已被移出該伺服器）",
  restart: "重新啟動 `miyoria core` 即會註冊目前的指令。",
};
