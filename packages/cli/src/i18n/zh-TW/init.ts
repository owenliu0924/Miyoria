import type { init as en } from "../en/init.js";

export const init: typeof en = {
  intro: "Miyoria 設定精靈。隨時可按 Ctrl+C 取消。",
  modeQuestion: "請選擇本機的用途",
  modes: {
    text: "Core 節點，僅文字（建議；不需要顯示卡）",
    voice: "Core 節點（含語音）：於本機執行語音辨識與語音合成（需要 NVIDIA 顯示卡）",
    service: "服務節點：為另一台機器上的 Core 節點提供服務（例如以顯示卡執行翻唱）",
  },
  sections: {
    profile: "角色",
    llm: "LLM 服務",
    discord: "Discord",
    database: "資料庫",
    panel: "管理面板登入",
    services: "服務",
  },
  existing: "已找到現有設定。按 Enter 保留目前的值；機密欄位留空即保留原值。",
  willCreate: (dir) =>
    `將在${dir === null ? "目前的資料夾" : ` ${dir} `}建立 miyoria.toml、.env、host.toml、角色與資料庫資料夾。確認後才會寫入。`,
  willCopyProfiles: (list) => `將複製內建角色：${list}`,
  willGenerateTokens: (list) => `將產生新的 token：${list}`,
  noApiKey: "尚未設定 LLM API key，Core 無法回應。請執行 `miyoria config` 並選擇 LLM 服務。",
  nextSteps: "後續步驟：",
  nextAddVoice: "安裝語音辨識、語音合成與斷句（需要 NVIDIA 顯示卡；首次執行會下載數 GB 的模型）：",
  nextUpVoice: "啟動 Core 與這些服務：",
  nextUpText: "啟動 Core：",
  nextPanel: "開啟管理面板：",
  nextVoiceLater: "  稍後要加入語音節點與翻唱，請參閱 docs/SETUP.md。",
  nextDoctor: "檢查尚缺的項目：",
  nextConfig: "之後變更個別設定：",
  serviceOnly: (file) =>
    `只會寫入 ${file}。本機不執行 Core，因此略過 LLM、Discord 與資料庫的設定。`,
  noCatalog:
    "找不到服務目錄（沒有任何 service.toml）。請重新安裝 miyoria 套件，或在 Miyoria 的安裝目錄中執行。",
  pickServices: "請選擇本機提供的服務（之後可用 `miyoria add` 與 `miyoria remove` 增減）",
  gpuTag: (mb) => `  [需要顯示卡${mb !== null ? `，約 ${mb.toLocaleString("en-US")} MB` : ""}]`,
  unknownServices: (unknown, available) => `本機無法提供 ${unknown}。可選：${available}`,
  noServices: "未選擇任何服務。非互動模式請用 --services asr,tts,... 指定。",
  hostCreate: (file, services) => `建立 ${file}，服務：${services}`,
  hostUpdate: (file, services) => `更新 ${file}，加入：${services}`,
  nextAddServices: "在本機安裝這些服務：",
  nextInvite: "在 Core 節點執行 `miyoria host invite`，再於本機執行其印出的指令：",
  nextApprove: "接著在 Core 節點核准本機；核准後才會使用本機的服務：",
  nextUpServices: "啟動這些服務：",
};
