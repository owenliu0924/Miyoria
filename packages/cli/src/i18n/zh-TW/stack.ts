import type { stack as en } from "../en/stack.js";

export const stack: typeof en = {
  checks: {
    winnatList:
      "以系統管理員身分開啟 PowerShell 查看保留範圍:netsh interface ipv4 show excludedportrange protocol=tcp",
    winnatRestart:
      "重新啟動 WinNAT 通常可以釋放:net stop winnat 後再執行 net start winnat(重新開機後可能再次出現)",
    winnatMove:
      "長期做法是將動態埠範圍移到 49152 以後:netsh int ipv4 set dynamic tcp start=49152 num=16384(需要重新開機;Miyoria 不會自行變更此設定)",
    dynamicPortRange: "動態埠範圍",
    dynamicPortLow: (start) =>
      `從 ${start} 開始(Windows 預設為 49152);Hyper-V 或 WinNAT 可能在開機時保留 Miyoria 使用的埠`,
    dynamicPortOk: (start) => `從 ${start} 開始`,
    port: (port, label) => `埠 ${port}(${label})`,
    inReservedRange: (start, end) => `位於 Windows 保留範圍 ${start}-${end}`,
    bindDenied: "Windows 拒絕綁定",
    portBlocked: (where) => `${where},服務無法綁定(EACCES),但目前沒有程式使用此埠`,
    portOurs: "已有 Miyoria 服務在監聽",
    portForeign: "已有其他程式在監聽;若不是 Miyoria,服務將無法綁定此埠",
    portForeignFind: (port) => `查出佔用的程式:netstat -ano | findstr :${port}(最後一欄為 PID)`,
    portForeignStop: "若是舊的 Miyoria 處理程序,請先結束它;`miyoria up` 不會結束其他程式",
    portUntestable: "無法測試此埠",
    portFree: "可以使用",
    build: (label) => `建置 ${label}`,
    rebuildStale: "執行 `miyoria update` 重新建置(只重建過期的項目)",
    notBuiltUnused: "尚未建置(設定檔未使用)",
    buildWhenNeeded: "需要時執行 `miyoria update --force`",
    notBuiltOrEmpty: "尚未建置,或上次建置失敗並留下空的輸出",
    runUpdate: "執行 `miyoria update`",
    modJar: "mod jar(建置)",
    notBuilt: "尚未建置",
    runUpdateJdk: "執行 `miyoria update`(需要 JDK 21)",
    jdkOnPath: "在 PATH 上",
    jdkMissing: (onPath) =>
      `找不到 JDK 21${onPath !== null ? `(PATH 上的 java 版本為 ${onPath})` : ""}`,
    jdkInstall: "安裝 Temurin 21:winget install EclipseAdoptium.Temurin.21.JDK",
    jdkJavaHome:
      "或將 JAVA_HOME 指向 JDK 21(`miyoria update` 會使用找到的 JDK 21,不會變更系統設定)",
    jdkNeededLater: (missing) => `${missing};下次修改 mod 時需要`,
    protocolVersion: "mod 協定版本",
    protocolMismatch: (source, doc) =>
      `Protocol.java 為 ${source},PROTOCOL.md 為 ${doc};adapter 依文件實作`,
    protocolFix: "兩邊須一併修改,完成後執行 `miyoria update`",
    protocolOk: (version) => `協定 ${version}`,
    installedMod: "遊戲中的 mod",
    noMinecraftDir: "未設定 minecraft_dir,無法比對遊戲中的 mod jar",
    minecraftDirExample:
      '[extensions."miyoria.minecraft"] minecraft_dir = "<Prism 實例>\\.minecraft"',
    noBridgeJar: (mods) => `${mods} 中沒有 miyoria-bridge jar`,
    runUpdateCopy: "執行 `miyoria update`(複製前會先詢問)",
    modSame: "與建置出的 jar 相同",
    modDiffers: (files) => `${files} 不是目前建置的版本(找不到 adapter / task executor 的常見原因)`,
    modReplace: "先關閉遊戲,再執行 `miyoria update`(複製前會備份舊的 jar)",
    tempFiles: "暫存檔",
    tempOk: (dir, size) => `${dir} 可以寫入、讀取、刪除 ${size} 的檔案`,
    tempFailed: (dir, code) => `${dir} 的大檔案操作失敗(${code}):常見原因是防毒軟體鎖住暫存檔`,
    tempNoBuildWeb:
      "請勿使用 `pnpm build:web`;請使用 `miyoria update`(vite 加上 --minify false --target esnext)",
    tempExclusion: "也可以將暫存資料夾加入防毒軟體的排除清單(需自行設定)",
    esbuildTemp: "esbuild 暫存檔",
    esbuildLeftovers: (dir, count) => `${dir} 留有 ${count} 個 esbuild-* 檔案(上次建置遭到阻擋)`,
    esbuildCleanup: "確認沒有建置正在執行後,可以手動刪除;建置請使用 `miyoria update`",
    antivirus: "防毒軟體",
    antivirusFound: (product) =>
      `偵測到 ${product};它可能鎖住 esbuild 的暫存檔,導致管理面板建置失敗`,
    antivirusBuild: "建置一律使用 `miyoria update`(內含 vite build --minify false --target esnext)",
  },

  hostChecks: {
    platform: "平台",
    platformUnsupported: (platforms, here) => `僅支援 ${platforms};本機為 ${here}`,
    platformFix: (service) =>
      `從 host.toml 移除 [services.${service}],或執行 \`miyoria remove ${service}\``,
    environment: "環境",
    envReady: (dir, extras) => `${dir}${extras !== null ? `(extras:${extras})` : ""}`,
    envStale: (reasons) => `與目前的 uv.lock、extras 或 service.toml 不一致:${reasons}`,
    envStaleFix: "執行 `miyoria doctor --fix` 或 `miyoria update` 重新同步",
    envMissing: (dir) => `尚未建立:${dir}`,
    envMissingFix: (service) =>
      `以 \`miyoria add ${service}\`(或 \`miyoria doctor --fix\`)建立;若尚未安裝 uv,請先安裝`,
    envUserManaged: (dir) => `使用 host.toml 指定的 ${dir}(Miyoria 不會變更它)`,
    envUserMissing: (dir) => `host.toml 指定的環境不存在:${dir}`,
    envUserMissingFix: (service) =>
      `請建立它,或從 [services.${service}] 移除 python,改由 Miyoria 建立`,
    systemProgram: (program) => `系統程式 ${program}`,
    onPath: "在 PATH 上",
    notOnPath: "不在 PATH 上",
    manualItem: "手動項目",
    manualPresent: (what, path) => `${what}:${path}`,
    manualMissing: (what, path) => `缺少 ${what}:${path}`,
    manualFix: "Miyoria 不會自動下載;請自行放置後再執行 `miyoria doctor`",
    file: (path) => `檔案 ${path}`,
    fileVerified: (size) => `已驗證(${size})`,
    fileWrong: (detail) => `不正確:${detail}`,
    checksumMismatch: "檢查碼不符",
    fileRefetch: "執行 `miyoria doctor --fix` 重新下載(會先列出檔案並詢問)",
    fileMissing: (what, size, license, source) =>
      `缺少 ${what}(${size},授權 ${license},來源 ${source})`,
    fileFetch: "執行 `miyoria doctor --fix` 下載(會先列出檔案並詢問)",
    fileRequired: "缺少此檔案時,hostd 不會啟動此服務",
    model: (repo) => `模型 ${repo}`,
    modelCached: "已在快取中",
    modelMissing: "尚未下載(首次啟動時會自動下載,但需要較長時間)",
    modelPull: (service) => `執行 \`miyoria models pull ${service}\``,
    importCheck: "匯入檢查",
    pythonMissing: (python) => `找不到 ${python}`,
    importFailed: (modules, timedOut, last) =>
      `import ${modules} 失敗${timedOut ? "(逾時)" : ""}${last !== null ? `:${last}` : ""}`,
    importFix: (service) =>
      `執行 \`miyoria doctor --fix\` 重新同步;若仍無法解決,請執行 \`miyoria remove ${service}\` 後再執行 \`miyoria add ${service}\``,
    hostdNotRunning: "未在執行",
    hostdStart: "以 `miyoria up` 啟動(`miyoria status` 可查看狀態)",
    hostdRunning: (name, running, total) => `${name},${running} / ${total} 個服務執行中`,
    hostKeyUnreadable: (error) => `無法讀取:${error}`,
    hostKeyRejoin: "以 `miyoria host join` 重新加入 Core",
    hostKeyMissing: (url) => `已設定 ${url},但本機尚未加入 Core`,
    hostKeyJoin:
      "在 Core 節點執行 `miyoria host invite`,再於本機執行它印出的 `miyoria host join ...`",
    hostKeyOk: (id) => `已加入 Core(主機 ID ${id})`,
    coreLink: "Core 連線",
    linkConnected: (url) => `已連線到 ${url}`,
    linkUnauthorized: "Core 拒絕了本機(host.key 無效或已撤銷)",
    linkRejoin: "以 `miyoria host join` 重新加入",
    linkConnecting: "連線中;Core 未啟動或網址無法連線時會持續重試",
    linkReachable: (url) => `確認可以連線到 ${url}`,
    linkNone: "未連線",
    linkCheck: "執行 `miyoria up` 後,再以 `miyoria status` 查看",
    service: (name) => `服務 ${name}`,
    serviceNotRunning: (state) => `未在執行(${state})`,
    unknownToHostd: "hostd 不認得此服務",
    upService: (service) => `執行 \`miyoria up ${service}\``,
    noAnswer: (url) => `${url} 沒有回應(尚未啟動?)`,
    upStart: "以 `miyoria up` 啟動",
    httpStatus: (url, status) => `${url} 回應 HTTP ${status}`,
    modelsNotLoaded: (url, models) => `${url} 正在執行,但 ${models} 模型未載入`,
    modelsNotLoadedFix:
      "查看 /health 的 errors,多半是模型檔不存在;以 `miyoria doctor --fix` 下載後重新啟動",
    versionMismatch: (running, cli) => `執行中的 Core 版本為 ${running},此 CLI 為 ${cli}`,
    versionFix: "重新啟動 Core 以使用新版本(`miyoria update` 後需要重新啟動)",
    healthy: (version) => `正常${version !== null ? `(版本 ${version})` : ""}`,
    vram: "VRAM",
    noSmi: "找不到 nvidia-smi,略過 VRAM 預算(沒有 NVIDIA 顯示卡則不需要)",
    smiUnreadable: "無法讀取 nvidia-smi 的輸出",
    vramUsed: (gpu, used, total) => `${gpu}:已使用 ${used} / ${total}`,
    vramBudget: "VRAM 預算",
    peakResident: "所有常駐服務都載入時",
    peakOnDemand: (service) => `${service} 工作時(可卸載的服務先卸載)`,
    vramDetail: (head, reserve, peak, why) =>
      `${head};保留 ${reserve};估計尖峰 ${peak}(${why};各服務的估計值在 service.toml 的 [gpu] vram_mb)`,
    vramOver: (detail, available) => `${detail},超過 ${available} 的 92%`,
    vramFix:
      "將 host.toml 的 [services.<名稱>.gpu] policy 改為 evictable 或 on_demand,或改用較小的模型(ASR_QWEN_SIZE=0.6B)",
  },

  builds: {
    noOutput: "沒有建置輸出",
    stale: (by) => `原始碼比輸出新(約 ${by})`,
    upToDate: "與原始碼一致",
    contracts: "契約(@miyoria/contracts)",
    sdk: "SDK(@miyoria/sdk)",
    extension: (id) => `擴充 ${id}`,
    panel: "管理面板(apps/panel)",
    overlay: "Overlay(apps/overlay)",
  },

  plan: {
    workersNeedRepository:
      "[stack.workers] 只能在 Miyoria 的原始碼資料夾中使用(找不到 workers/ 與 pnpm-workspace.yaml)",
    voiceNodeNeedsRepository: "voice node 只能在原始碼資料夾中使用(apps/voice-node)",
  },

  roles: {
    label: {
      broadcast: "直播機",
      core: "Bot 服務機",
      inference: "GPU 推論機",
    },
    help: {
      broadcast: "直播機:Discord 語音與 Go Live(voice node)、VTube Studio / OBS / overlay(stage)",
      core: "Discord bot、所有模組、資料庫、管理面板(core),判斷發言結束的 worker(turn),檔案沙箱使用的 Docker",
      inference: "全部 AI 模型:語音辨識(asr)、語音合成(tts)、翻唱(sing);三者須在同一台主機執行",
    },
    unknownTarget: (word, roles, services) =>
      `無法辨識 \`${word}\`;機器角色:${roles}(或 all);服務:${services}`,
    custom: (services) => `自訂:${services}`,
    noRoles: "(未選擇機器角色)",
    withLabel: (role, label) => `${role}(${label})`,
  },

  config: {
    workerNeedsPort: (worker) => `[stack.workers.${worker}] 必須設定 port`,
  },
};
