import type { common as en } from "../en/common.js";

const int = (n: number): string => Math.round(n).toLocaleString("en-US");

export const common: typeof en = {
  list: (items) => items.join("、"),
  none: "（無）",
  yes: "是",
  no: "否",
  cancelled: "已取消",
  set: "已設定",
  notSet: "未設定",
  int,
  mb: (mb) => `${int(mb)} MB`,
  gb: (gb) => `${gb.toFixed(1)} GB`,
  duration: (seconds) => {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分鐘`;
    if (s < 86_400) return `${Math.floor(s / 3600)} 小時`;
    return `${Math.floor(s / 86_400)} 天`;
  },
  ago: (seconds) => `${common.duration(seconds)}前`,
  seconds: (n) => `${n} 秒`,
  minutes: (n) => `${n} 分鐘`,
  services: (n) => `${n} 個服務`,
  files: (n) => `${n} 個檔案`,
};
