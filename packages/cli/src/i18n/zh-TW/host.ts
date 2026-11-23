import type { host as en } from "../en/host.js";

export const host: typeof en = {
  suffix: (detail) => `:${detail}`,
  noHostToml: (file) =>
    `找不到 ${file}。請執行 \`miyoria host migrate\`,從 miyoria.toml 的 [machine] 與 [stack] 產生。`,
  logFile: (file) => `    記錄檔:${file}`,
  elapsed: (seconds) => `${seconds} 秒`,
  starting: (service) => `正在啟動 ${service}`,
  running: "執行中",
  disabled: (reason) => `已停用:${reason}`,
  stopped: "已停止",
  foreignDefault: "已有其他程式在該埠回應",
  externalNotStarted: (service) => `${service} 是外部程式,hostd 不會啟動它`,
  alreadyRunningHere: (pid) => `此工作資料夾的 hostd 已在執行(PID ${pid}),不會再啟動一個。`,
  daemonRunning: (pid, port, workspace) =>
    `hostd 執行中(PID ${pid},本機 API 埠 ${port}),工作資料夾 ${workspace}`,
  startServicesFailed: (error) => `啟動服務時發生錯誤:${error}`,
  runningNoApi: (pid) => `hostd 已在執行(PID ${pid}),但其本機 API 沒有回應,未啟動任何服務。`,
  askedToStart: (pid, services) =>
    `hostd 已在執行(PID ${pid}),已要求其啟動 host.toml 啟用的 ${services}`,
  alreadyRunning: (pid) => `hostd 已在執行(PID ${pid})`,
  startedInBackground: (pid, file) => `hostd 已在背景啟動(PID ${pid}),記錄檔 ${file}`,
  cannotStart: (error) => `hostd 無法啟動:${error}`,
  exitedEarly: (code) => `hostd 啟動後即結束(結束代碼 ${code})`,
  noAnswer: (seconds) => `hostd 在 ${seconds}內沒有回應`,
  didNotStart: "hostd 未能啟動",
  nothingToStart: (file) => `沒有要啟動的服務:${file} 未啟用任何 [services.<名稱>]。`,
  startingChain: (chain) => `啟動 ${chain}`,
  handedOver: "已交由 hostd 處理。請用 `miyoria status` 查看進度。",
  couldNotStart: (services) => `${services}無法啟動`,
  stillStarting: (list) => `仍在啟動:${list}(hostd 會繼續處理,可用 \`miyoria status\` 查看)`,
  servicesDidNotStart: (services) => `${services}未能啟動`,
  allReadyMark: "全部就緒",
  allReady: (mark) => `${mark}。執行 \`miyoria down\` 可停止全部服務。`,
  alreadyInBackground: (pid) =>
    `此工作資料夾的 hostd 已在背景執行(PID ${pid})。請改用 \`miyoria up\`,或先執行 \`miyoria down\`。`,
  foregroundStart: (chain) => `啟動 ${chain}(前景執行,Ctrl+C 依相反順序停止全部)`,
  stoppingServices: "正在停止服務",
  notRunningNothingToStop: "hostd 未在執行,沒有要停止的服務。",
  noneStopped: (detail) => `未停止任何服務:${detail}`,
  daemonStopped: "hostd 已結束",
  foreignNotStopped: (service) => `${service} 不是由此 hostd 啟動,不會停止它。`,
  externalNotStopped: (service) => `${service} 是外部程式,hostd 不會停止它。`,
  servicesDidNotStop: (services) => `${services}未能停止`,
  restartNotRunning: (service) => `hostd 未在執行。請用 \`miyoria up ${service}\` 啟動。`,
  restarted: (service) => `已重新啟動 ${service},等待就緒…`,
  serviceDidNotStart: (service) => `${service} 未能啟動`,
  labels: { hostd: "hostd", gpu: "顯示卡", arbiter: "仲裁" },
  arbiterWorker: '由翻唱服務自行決定(host.toml [gpu] arbiter = "worker")',
  arbiterInactive: "hostd,但未在運作",
  arbiterActive: (policy, leases) =>
    `hostd${policy !== null ? `(政策 ${policy})` : ""},${
      leases === 0 ? "沒有服務佔用顯示卡" : `${leases} 個租約`
    }`,
  lease: (holder, stage, what, held, evicted) =>
    `${holder} 在 ${stage} 階段${what !== null ? `(${what})` : ""},已持有 ${held}${
      evicted !== null ? `,讓出:${evicted}` : ""
    }`,
  lastDecision: (stage, mode, code, ago, reason) =>
    `上次判斷:${stage} ${mode} / ${code},${ago}:${reason}`,
  link: {
    connected: "已連線",
    connecting: "連線中",
    unauthorized: "遭拒絕(host.key 無效或已撤銷)",
    stopped: "已停止",
    none: "無(host.toml 沒有 [cluster],或尚無 host.key)",
  },
  columns: {
    service: "服務",
    state: "狀態",
    health: "健康",
    port: "埠",
    pid: "PID",
    restarts: "重啟",
    since: "自從",
    reason: "原因",
  },
  noHostTomlNote: (file) =>
    `沒有 ${file}(可用 \`miyoria host migrate\` 從 [machine] 與 [stack] 產生)`,
  thisMachine: (name) => `本機:${name}`,
  notRunningStartHint: "hostd 未在執行(`miyoria up` 會啟動它)",
  enabledInHostToml: (list) => `host.toml 啟用的服務:${list}`,
  daemonLine: (pid, uptime, link) => `PID ${pid}  已執行 ${uptime}  Core 連線:${link}`,
  gpuUnreadable: "無法讀取(NVML 與 nvidia-smi 皆無回應)",
  gpuLine: (name, used, total, free, reserve) =>
    `${name}  已用 ${used} / ${total}${free !== null ? `,可用 ${free}` : ""},保留 ${reserve}`,
  noServices: "host.toml 沒有任何服務",
  coreSkipped: (error) => `(未查詢 Core:${error})`,
  coreNotAnswering: "Core 的管理 API 沒有回應",
  rpc: {
    unknownService: (service) => `沒有名為 ${service} 的服務`,
    notInstalled: (service) => `${service} 不是本機的服務(host.toml 沒有 [services.${service}])`,
    guarded: (service, states) => `${service} 受保護:${states}。請稍後再試,或加上 --force。`,
    guardUnknown: (service) =>
      `${service} 受保護,且無法取得 Core 目前的狀態。確定要執行請加上 --force。`,
    singing: "翻唱進行中",
    live: "直播進行中",
  },
  notRunningNoLog: (file) => `hostd 未在執行,也沒有 ${file}。`,
  notRunningNoFollow: "hostd 未在執行,不會有新的記錄。",
};
