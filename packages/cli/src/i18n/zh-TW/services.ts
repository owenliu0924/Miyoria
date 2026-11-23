import type { services as en } from "../en/services.js";

export const services: typeof en = {
  detail: (subject, detail) => `${subject}:${detail}`,
  separator: ";",
  filesTitle: "要下載的模型檔",
  fileAdopted: (service, path, size, from) =>
    `  ${service}  ${path}  ${size}  沿用 ${from}(檢查碼相同,以硬連結取用,不需下載)`,
  fileToFetch: (service, path, size, resume, license, source) =>
    `  ${service}  ${path}  ${size}${resume !== null ? `(續傳,尚需 ${resume})` : ""}  授權 ${license}  來源 ${source}`,
  fileWhat: (what, optional, wrong) =>
    `      ${what}${optional ? "(選用)" : ""}${
      wrong !== null ? `;現有檔案不正確(${wrong}),將會取代` : ""
    }`,
  checksumMismatch: "檢查碼不符",
  filesTotal: (size, dir) => `  共 ${size},存放於 ${dir}`,
  noTerminalForFiles: (command) =>
    `沒有可供確認下載的終端機。若同意下載上述檔案,請執行 \`${command}\`。`,
  confirmFiles: (files, size) => `下載這 ${files}(共 ${size})?`,
  downloaded: (path) => `已下載並驗證 ${path}`,
  downloadFailed: "下載失敗",
  fileMissing: (path, detail) => `尚無 ${path}${detail !== null ? `(${detail})` : ""}`,
  voiceNodeNeedsRepository:
    "語音節點目前尚未隨 miyoria 套件發行,需要使用原始碼 repository:請 clone 專案後在其中執行 `miyoria add voice-node`。之後的版本會將其納入套件。",
  createdHostToml: (file, name) => `已建立 ${file}(name = "${name}")`,
  unknownService: (name, known) => `沒有名為 ${name} 的服務。目錄中的服務:\n${known}`,
  catalogTitle: "可加入本機的服務",
  added: "已加入",
  addedDisabled: "已加入(已停用)",
  catalogHint: "`miyoria add <服務>...` 加入並安裝;`miyoria doctor` 檢查尚缺的項目。",
  envSynced: (extras) => `環境已建立${extras !== null ? `(extras:${extras})` : ""}`,
  envCurrent: "環境已是最新",
  envUserManaged: "使用自行管理的環境,不會變更",
  envUnsupported: (detail) => `不支援此平台:${detail}`,
  uvMissing: (detail) => `找不到 uv:${detail}`,
  uvHint: "    uv 不會自動安裝;安裝後請重新執行相同的指令。",
  envFailed: (detail) => `環境建立失敗:${detail}`,
  programMissing: (program, hint) =>
    `PATH 中找不到 ${program}(不會自動安裝)${hint !== null ? `:${hint}` : ""}`,
  manualFile: (what, path) => `需自行放置:${what}(${path})`,
  modelsNotPulled: (service, repos) => `模型尚未下載:${repos}(\`miyoria models pull ${service}\`)`,
  extraOneService: "--extra 只能用於單一服務(各服務的 extras 名稱不同)。",
  platformUnsupported: (name, platforms, platform) =>
    `${name} 只支援 ${platforms},本機為 ${platform}`,
  addedTo: (file, list) => `${file}:加入 ${list}`,
  notInstalled:
    "未安裝(--no-install)。之後可用 `miyoria add <服務>` 或 `miyoria doctor --fix` 補裝。",
  filesSkipped:
    "不下載模型檔。之後可用 `miyoria doctor --fix` 補齊;缺少必要檔案的服務,hostd 不會啟動。",
  installingInDaemon: "交由執行中的 hostd 安裝",
  installingHere: "hostd 未在執行,在此處安裝",
  installing: (name) => `安裝 ${name}`,
  installFailed: (services) =>
    `${services}安裝失敗,請見上方訊息。修正後重新執行即可(已完成的部分會略過)。`,
  doneMark: "完成",
  addDone: (mark, todo, names) =>
    `${mark}${todo ? ",上方標示 ! 的項目仍需處理" : ""}。下一步:\`miyoria up ${names}\`(\`miyoria doctor\` 可檢查尚缺的項目)`,
  notInHostToml: (file, name) => `${file} 沒有 [services.${name}],略過`,
  stopped: "已停止",
  envDeleted: (dir) => `已刪除環境 ${dir}`,
  envFromHostToml: "環境由 host.toml 指定,未變更",
  envKept: "已保留環境(--keep-env)",
  removedFrom: (file, name) => `${file}:已移除 [services.${name}]`,
  modelsKept: "模型未變更;`miyoria models gc` 會列出沒有服務使用的模型。",
  notRemoved: (services) => `${services}未移除`,
};
