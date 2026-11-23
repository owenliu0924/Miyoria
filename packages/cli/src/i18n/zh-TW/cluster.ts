import type { cluster as en } from "../en/cluster.js";

export const cluster: typeof en = {
  unreachable: (error) => `無法連線到 Core 的管理 API：${error}。請確認 Core 正在執行。`,
  tokenRejected: "Core 的管理 API 不接受此 token。請檢查 MIYORIA_API_TOKEN。",
  moduleOff:
    "Core 的 cluster 模組未在執行。此模組需要資料庫，可用 `miyoria module list` 查看狀態。",
  coreAnswered: (detail) => `Core 回應：${detail}`,
  badTtl: (max) => `--ttl 必須是 1 到 ${max} 之間的整數（單位：分鐘）。`,
  inviteCode: (code) => `邀請碼 ${code}`,
  inviteValid: (until, minutes, name) =>
    `   有效期限至 ${until}（${minutes}內），僅能使用一次${name !== null ? `，僅限名稱為 ${name} 的主機` : ""}`,
  runOnJoining: "在要加入的主機上執行：",
  loopbackOnly: (bind) =>
    `Core 的管理 API 只監聽 ${bind}（本機），其他主機無法連線。若要讓其他主機加入，請將 [modules.api] bind 設為本機的區網或 tailnet 位址（例如 192.168.1.10:7878）並重新啟動 Core，再將上方指令中的位址換成該位址。`,
  notAUrl: (text) => `\`${text}\` 不是有效的網址（例如 http://192.168.1.10:7878）。`,
  badScheme: "Core 的位址必須使用 http:// 或 https://。",
  noDaemon: "本機的 hostd 未在執行，以 `miyoria up` 啟動時會連線到 Core。",
  oldDaemon:
    "此 hostd 不支援 host.relink（版本過舊）。請先執行 `miyoria down`，再執行 `miyoria up`。",
  relinkFailed: (reason) =>
    `要求 hostd 連線到 Core 失敗：${reason}。也可先執行 \`miyoria down\` 再執行 \`miyoria up\`。`,
  linkState: (link) => `hostd 與 Core 的連線：${link}`,
  approveNext: (command) =>
    `最後一步：在 Core 節點執行 ${command}（或使用管理面板）核准本機。核准之前，本機的服務不會被使用。`,
  approvedAlready: (capabilities) => `已核准：${capabilities}。本機不需要再核准。`,
  noEnabledServices: "（host.toml 未啟用任何服務）",
  codeInvalid:
    "邀請碼無法使用：不存在、已使用或已過期。請在 Core 節點重新執行 `miyoria host invite`。",
  nameRejected: (detail) =>
    `Core 不接受此名稱：${detail}。請用 --name 指定其他名稱，邀請碼尚未被使用。`,
  tooManyAttempts: (retry) =>
    `嘗試次數過多，Core 暫時不受理此位址的要求。${retry !== null ? `請於 ${retry}後再試。` : "請稍後再試。"}`,
  joinModuleOff: "Core 的 cluster 模組未在執行，目前無法加入。",
  notCoreApi: (url) =>
    `${url} 沒有 /api/cluster/join：這不是 Miyoria Core 的管理 API 位址，或該 Core 版本過舊。`,
  coreStatus: (status, detail) => `Core 回應 ${status}${detail !== null ? `：${detail}` : ""}`,
  missingUrl: "缺少 Core 的位址：<core-url>",
  missingCode: "缺少邀請碼：--code（請在 Core 節點執行 `miyoria host invite` 取得）",
  alreadyJoined: (file) =>
    `本機已加入一個 Core（${file} 已存在）。若要改加入其他 Core，請先在原本的 Core 執行 \`miyoria host remove\`，再加上 --force。`,
  cannotWrite: (dir, error) => `無法寫入 ${dir}：${error}`,
  cannotReach: (url, error) =>
    `無法連線到 ${url}：${error}。請確認位址是否正確，以及該 Core 的 [modules.api] bind 是否只監聽其本機。`,
  notJoinResult: (url) => `${url} 的回應不是 Miyoria Core 的加入結果。`,
  joined: (name) => `已加入 Core，名稱 ${name}`,
  keyWritten: (file) => `金鑰已寫入 ${file}（請勿外流）`,
  clusterUrl: (file, url) => `${file} 的 [cluster] url = ${url}`,
  nameTaken: (name) =>
    `Core 已有名為 ${name} 的主機。請先執行 \`miyoria host remove ${name}\` 再重試，或用 --name 指定其他名稱。`,
  localNoCode: "--local 不需要邀請碼。",
  alreadyJoinedLocal: (file) =>
    `本機已加入 Core（${file} 已存在）。若要重新加入，請先執行 \`miyoria host remove <名稱>\`，再加上 --force。`,
  joinedLocal: (name) => `已加入在本機執行的 Core，名稱 ${name}`,
  clause: {
    connected: "已連線",
    state: (link) => `連線狀態：${link}`,
    noDaemon: "hostd 未在執行",
    oldDaemon: "此 hostd 不支援 host.relink，執行 `miyoria down` 再 `miyoria up` 即可連線",
    failed: (reason) => `要求 hostd 連線失敗：${reason}`,
  },
  selfLinked: (name, capabilities, clause) =>
    `已將本機連結到在本機執行的 Core（名稱 ${name}，核准：${capabilities}）；${clause}`,
  noCapabilities: "無",
  goneFromCore: (id) =>
    `Core 中已沒有本機（${id}），未自動連結。請執行 \`miyoria host join --local --force\` 重新加入。`,
  revoked: (name) => `${name} 已在 Core 中遭撤銷，未自動核准。`,
  reapproved: (name, capabilities) => `已重新核准本機（${name}）：${capabilities}`,
  selfLinkFailed: (error) => `本機未能自動連結到在本機執行的 Core：${error}`,
  notConnected: "未連線",
  connectedFor: (duration) => `已連線${duration !== null ? ` ${duration}` : ""}`,
  columns: {
    name: "名稱",
    status: "狀態",
    connection: "連線",
    capabilities: "核准的能力",
    platform: "平台",
    version: "版本",
    lastSeen: "最後上線",
  },
  noHosts:
    "Core 尚無任何主機。請用 `miyoria host invite` 產生邀請碼，或用 `miyoria host join --local` 加入本機。",
  noSuchHost: (name) => `Core 沒有名為 ${name} 的主機。可用 \`miyoria host ls\` 查看所有主機。`,
  offlineCapabilities: (name) =>
    `${name} 目前未連線，Core 無法得知其提供的能力。請自行列出要核准的能力，例如 \`miyoria host approve ${name} asr tts\`。`,
  noReportedCapabilities: (name) => `${name} 未回報任何能力。請自行列出要核准的能力。`,
  approved: (name, capabilities) => `已核准 ${name}：${capabilities}`,
  removeNeedsYes: "不是互動式終端機：若要移除，請加上 -y。",
  removeConfirm: (name, status, connected) =>
    `移除 ${name}（${status}${connected ? "，目前已連線" : ""}）？其金鑰將失效、連線將中斷，其服務也會從 Core 的端點移除。`,
  notRemoved: "未移除",
  alreadyGone: (name) => `${name} 已不在 Core 中。`,
  removed: (name) => `已移除 ${name}`,
  hostsUnavailable: (error) => `（無法查詢各主機：${error}）`,
  allHosts: "所有主機（Core）",
  noHostsShort: "Core 尚無任何主機（`miyoria host invite`）",
  lastSeen: (when) => `最後上線 ${when}`,
  approvedList: (capabilities) => `核准：${capabilities}`,
  noServices: "  沒有任何服務",
  servicesUnavailable: (error) => `  （無法查詢服務：${error}）`,
};
