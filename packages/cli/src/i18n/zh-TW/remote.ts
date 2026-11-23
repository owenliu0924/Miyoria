import type { remote as en } from "../en/remote.js";

export const remote: typeof en = {
  noToken: "尚未設定 MIYORIA_API_TOKEN。請執行 `miyoria init` 產生。",
  usageTitle: "LLM 用量(自啟動以來)",
  usage: (model, calls, prompt, cached, completion) =>
    `  ${model}: ${calls} 次呼叫,輸入 ${prompt} token(快取 ${cached}),輸出 ${completion} token`,
  replied: "回應",
  skipped: "略過",
  characters: (n) => `(${n} 字)`,
  personaUpdated: (key, version) => `\`${key}\` 已更新為第 ${version} 版,下一輪對話起生效`,
};
