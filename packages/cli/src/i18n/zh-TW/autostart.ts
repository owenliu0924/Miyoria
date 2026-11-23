import type { autostart as en } from "../en/autostart.js";

export const autostart: typeof en = {
  macosUnsupported: "macOS 尚不支援登入時自動啟動 hostd。請用 `miyoria up` 手動啟動。",
  unsupported: (platform) => `${platform} 不支援登入時自動啟動 hostd。`,
  needsConfirmation: "此指令需要確認。請在終端機執行,或加上 -y。",
  commandNotFound: (command) => `找不到 ${command}`,
  commandFailed: (command, code, detail) =>
    `${command} 失敗(結束代碼 ${code})${detail !== null ? `:${detail}` : ""}`,
  needsAdmin:
    "本機需要系統管理員權限才能建立登入工作。請在以「以系統管理員身分執行」開啟的終端機中再執行一次相同的指令。工作內容不變(仍以目前的帳號、一般權限,在目前的登入工作階段中執行)。",
  notCompleted: "系統指令未完成。",
  onTitle: (update) => `登入時自動啟動 hostd(${update ? "更新現有的登錄" : "新增登錄"})`,
  workspace: (dir) => `工作資料夾:${dir}`,
  runs: (command) => `將執行:${command}`,
  writes: (file) => `將寫入:${file}`,
  deletes: (file) => `將刪除:${file}`,
  systemCommands: "將執行以下系統指令:",
  confirmOn: "是否登錄?",
  notRegistered: "未登錄",
  registered: (name) => `已登錄 ${name}`,
  windowsNext:
    "下次此帳號登入時,工作排程器會在登入工作階段中以無視窗方式啟動 hostd,再由 hostd 啟動 host.toml 啟用的服務。",
  windowsTry: (command) => `  立即測試:${command}(請先以 \`miyoria status\` 確認沒有 hostd 在執行)`,
  windowsLogs: (dir) => `  記錄檔:hostd 的記錄檔位於 ${dir}`,
  windowsHeadless:
    "  無視窗執行依賴 conhost.exe --headless(Microsoft 未正式記載此旗標)。若某次 Windows 更新後出現視窗,請執行 `miyoria host autostart off` 並回報問題。",
  linuxNext: (retry) => `下次此帳號登入時,systemd 會啟動 hostd(失敗時於 ${retry}後重試)。`,
  linuxLinger: (command) => `  若要在開機時即啟動而不需登入:${command}(以自己的帳號執行一次即可)`,
  linuxNoNow: "目前已有 hostd 在執行,因此未加上 --now;此單元會在下次登入時啟動。",
  undoHint: (command, undo, file) =>
    `取消:${command}(等同於 ${undo}${file !== null ? `,並刪除 ${file}` : ""})`,
  nothingToUndo: "未登錄登入時自動啟動 hostd,沒有需要取消的項目。",
  offTitle: "取消登入時自動啟動 hostd",
  confirmOff: "是否取消?",
  notRemoved: "未取消",
  removed: (name) => `已取消 ${name}`,
  entryName: (name) => `登錄名稱:${name}`,
  registeredStatus: "已登錄:此帳號登入時會啟動 hostd",
  runsIndented: (command) => `  執行:${command}`,
  stale:
    "登錄的內容與目前的設定不同(資料夾或 Node 是否搬移過?)。請再執行一次 `miyoria host autostart on`。",
  notRegisteredStatus: (mark) => `${mark}:登入時不會自動啟動(\`miyoria host autostart on\`)`,
  daemonNow: (state) => `hostd 目前:${state}`,
  running: "執行中",
  notRunning: "未在執行",
};
