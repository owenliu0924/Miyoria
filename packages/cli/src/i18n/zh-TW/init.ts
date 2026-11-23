import type { init as en } from "../en/init.js";

export const init: typeof en = {
  intro: "Miyoria 設定精靈",
  modeQuestion: "本機的用途?(之後可重新執行 init 變更)",
  modes: {
    text: "Core 節點,僅文字(不需要顯示卡)",
    voice: "Core 節點加語音:本機同時執行語音辨識與語音合成(需要 NVIDIA 顯示卡)",
    service: "工作節點:為遠端的 Core 提供服務(例如以顯示卡執行翻唱)",
  },
  sections: {
    profile: "角色",
    llm: "LLM",
    discord: "Discord",
    database: "資料庫",
    panel: "管理面板",
    services: "服務",
  },
  existing: "已載入現有設定。每一題按 Enter 即保留目前的值;密碼類欄位不輸入就不會變更。",
  willCreate: (dir) =>
    `將在${dir === null ? "目前的資料夾" : ` ${dir} `}建立 miyoria.toml、.env、host.toml、角色與資料庫資料夾(確認後才寫入)。`,
  willCopyProfiles: (list) => `將複製內建角色:${list}`,
  willGenerateTokens: (list) => `將產生新的 token:${list}`,
  noApiKey: "尚未設定 LLM API key。請用 `miyoria config` → LLM 設定,或重新執行 `miyoria init`。",
  nextSteps: "後續步驟:",
  nextAddVoice: "安裝語音辨識、語音合成與斷句的環境(需要 NVIDIA 顯示卡;首次執行會下載數 GB 的模型)",
  nextUpVoice: "啟動 Core 與這些服務",
  nextUpText: "啟動 Core",
  nextPanel: (url) => `  管理面板:${url}。可直接在 Discord 與角色對話。`,
  nextVoiceLater:
    "  語音節點(加入 Discord 語音頻道的用戶端)與翻唱可稍後再加,做法見 docs/SETUP.md 的「加上語音」「加上翻唱」。",
  nextDoctor: "檢查尚缺的項目",
  nextConfig: "之後變更個別設定",
  serviceOnly: (file) => `只會寫入 ${file}。本機不執行 Core,因此略過 LLM、Discord 與資料庫的設定。`,
  noCatalog: "找不到服務目錄(沒有任何 service.toml):套件不完整,或這裡不是 Miyoria 的安裝目錄。",
  pickServices: "本機要提供哪些服務?(之後可用 `miyoria add` 與 `miyoria remove` 增減)",
  gpuTag: (mb) => `  [需要顯示卡${mb !== null ? `,約 ${mb.toLocaleString("en-US")} MB` : ""}]`,
  unknownServices: (unknown, available) => `本機無法提供 ${unknown}。可選:${available}`,
  noServices: "未選擇任何服務。非互動模式請用 --services asr,tts,... 指定。",
  hostCreate: (file, services) => `建立 ${file},服務:${services}`,
  hostUpdate: (file, services) => `更新 ${file},加入:${services}`,
  nextAddServices: "在本機安裝這些服務(以 uv 建立環境並下載缺少的檔案)",
  nextInvite: "  請 Core 節點的管理者在該節點執行 `miyoria host invite`,再於本機執行它印出的指令:",
  joinCommand: (cmd) => `    ${cmd} host join <位址> --code <邀請碼>`,
  nextApprove: (name) =>
    `  管理者再以 \`miyoria host approve ${name}\` 核准本機。核准後才會使用本機的服務。`,
  nextUpServices: "啟動這些服務",
};
