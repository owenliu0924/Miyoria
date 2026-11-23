// biome-ignore-all lint/suspicious/noTemplateCurlyInString: help text names the ${VAR} syntax
import type { cli as en } from "../en/cli.js";

export const cli: typeof en = {
  root: "Miyoria — AI VTuber 框架",
  rootFooter: [
    "語言:依序採用 --lang、MIYORIA_LANG、系統語系(LC_ALL、LC_MESSAGES、LANG;Windows 為顯示語言)。",
    "zh-TW、zh-HK、zh-Hant 使用繁體中文,其他語系一律使用英文。",
  ],
  usage: "用法:",
  commandsTitle: "指令:",
  argumentsTitle: "參數:",
  optionsTitle: "選項:",
  optionsWord: "[選項]",
  commandOptional: "[指令]",
  commandRequired: "<指令>",
  defaultValue: (value) => `[預設:${value}]`,
  errors: {
    unknownOption: (token) => `未知的選項 \`${token}\``,
    needsValue: (token, value) => `\`${token}\` 需要一個值 <${value}>`,
    unknownCommand: (token) => `未知的指令 \`${token}\``,
    extraArgument: (token) => `多餘的參數 \`${token}\``,
    missingArgument: (name) => `缺少參數 <${name}>`,
    conflict: (option, arg) => `--${option} 不能與 <${arg}> 同時使用`,
    integer: (option) => `--${option} 必須是整數`,
    timeout: "--timeout 必須是正整數(秒)",
    lines: "--lines 必須是 0 或正整數",
    limit: "--limit 必須是正整數",
    badLang: (value) => `--lang 不支援 \`${value}\`;請使用 en 或 zh-TW`,
  },
  cancelled: "已取消,未寫入任何檔案",
  options: {
    config: "miyoria.toml 的路徑",
    yes: "略過所有確認,直接寫入或套用",
    help: "顯示說明",
    version: "顯示版本",
    lang: "訊息語言:en 或 zh-TW(預設依 MIYORIA_LANG,其次為系統語系)",
    hostConfig:
      "host.toml 的路徑(預設:miyoria.toml 所在資料夾中的 host.toml;該資料夾即為工作資料夾)",
    force: "即使翻唱或直播進行中也照常停止",
  },
  cmd: {
    init: {
      help: "設定精靈:先詢問本機的用途(Core 節點僅文字、Core 節點加語音,或服務節點),再設定 LLM、Discord、資料庫與管理面板登入。可重複執行,按 Enter 保留目前的值",
      mode: "本機的用途,略過第一個問題:text(Core 節點僅文字,預設)、voice(Core 節點加語音)、service(服務節點)",
      services: "搭配 --mode service:本機提供的服務(以逗號分隔,例如 asr,tts);省略則以互動方式選擇",
      notTty:
        "在腳本中請使用 `miyoria init --yes`(全部採用預設值)或 `miyoria config set <key> <value>`",
      modeChoice: (modes) => `--mode 必須是 ${modes} 其中之一`,
      servicesNeedMode: "--services 只能搭配 --mode service 使用",
    },
    config: {
      help: "變更設定(不加子指令時開啟互動選單,一次變更一項)",
      list: "列出所有設定與實際值(密碼會遮蔽,並標示來自 .env 的值)",
      reveal: "顯示密碼原文",
      get: "顯示單一設定的實際值,例如 `core.profile`",
      getKey: "以點分隔的鍵,例如 modules.api.bind 或 'modules.\"voice.link\".bind'",
      getEnv: "改為讀取 .env 的變數",
      set: "設定一個值,例如 `set core.log debug`;引用 ${VAR} 的鍵會改寫 .env 的變數",
      setArgName: "鍵 值",
      setArg: '<鍵> <值>(值以 TOML 解析:3、true、["a"];其他一律視為字串)',
      setEnv: "改寫 .env 的變數:`set --env LLM_API_KEY sk-...`",
      unset: "刪除一個設定(或以 `--env NAME` 刪除 .env 的變數)",
      unsetKey: "以點分隔的鍵",
      unsetEnv: "刪除 .env 的變數",
      edit: "以編輯器開啟 miyoria.toml($VISUAL 或 $EDITOR;Windows 預設為記事本)",
      overrides:
        "列出在管理面板變更過的設定(存於資料庫,會覆蓋 miyoria.toml 的值),以及檔案中的值與變更者",
      bake: "將管理面板的變更寫入 miyoria.toml(保留註解),再從資料庫清除這些值",
      import:
        "將 miyoria.toml 匯入資料庫,成為下一個設定版本(保留管理面板的變更;各頻道、各伺服器的值移至對應範圍)。請先備份資料庫,並以 --dry-run 預覽",
      importDryRun: "只列出會變更的內容,不寫入",
      importReplace:
        "以檔案內容完整取代資料庫的設定(移除管理面板的變更,保留版本紀錄);已匯入過之後再次匯入時需要此選項",
    },
    doctor: {
      help: "檢查設定檔、角色、LLM、Discord、資料庫,以及 host.toml 啟用的每個服務(環境、系統程式、檔案、模型、hostd、Core 連線);--deep 另外檢查匯入、埠、健康檢查、VRAM、建置與暫存檔;--fix 只執行安全的修復",
      deep: "另外檢查:以各環境的 Python 執行 check_imports、Windows 保留埠、服務健康狀態、VRAM 預算、dist 與 mod jar 是否過期、JDK 21、暫存檔",
      deepOnly: "只執行 --deep 的部署檢查(不連線 LLM、Discord、資料庫)",
      fix: "只執行安全的修復:同步缺少或過期的環境、下載缺少或不正確的模型檔(install.files;先列出大小與授權並確認一次,-y 則不詢問);不安裝系統程式,也不變更任何系統設定",
      printHashes:
        "只印出此服務在本機現有檔案(install.files 與 install.manual)的 SHA-256 與大小,格式同 service.toml,可直接填入 [[install.files]]",
    },
    db: {
      help: "資料庫切換工具(離線):檢查檔案、封存已停用的 V4 資料庫、將身分資料匯入新的資料庫",
      importLinks:
        "將 V4 資料庫中的人員、帳號、handle、隱私與語音同意、紀念卡資料匯入 core.database_url 的資料庫;只讀取舊檔,重複執行不會產生重複資料",
      from: "V4 資料庫(通常是 db archive 產生的 .single.db)",
      importDryRun: "只列出會匯入的項目與數量,不寫入",
      archive:
        "將已停用的 V4 資料庫(.db 連同 -wal、-shm)移至 data/archive/,製作單一檔案複本並記錄雜湊值;不刪除任何檔案,中斷後可重新執行",
      archiveFile: "要封存的資料庫;省略則使用 core.database_url",
      archiveDryRun: "只檢查檔案是否被開啟並列出將執行的動作,不搬移檔案",
      doctor:
        "唯讀檢查資料庫檔案:V4、V5 或空白、Core 是否會拒絕、遷移、完整性、人數與事件數;V4 另外列出 import-links 會帶入的資料",
      doctorFile: "要檢查的檔案;省略則使用 core.database_url",
    },
    memory: {
      help: "記憶的離線工具:從事件紀錄重建角色的記憶(筆記與情節)",
      rebuild:
        "以設定中的模型,重新對事件紀錄中的聊天進行分段整理,補寫筆記行與情節;預設只預覽(段落、行數、預估 token 與費用),不呼叫模型。只會新增,不刪除也不取代現有記憶;進度存於資料庫,中斷後可繼續",
      file: "資料庫檔案;省略則使用 core.database_url",
      since: "只處理此時間之後的聊天(ISO 日期)",
      apply: "實際執行(會呼叫模型並產生費用);未加此選項時只預覽",
      maxUsd: "花費達到此金額時停止,之後可繼續",
      force: "即使資料庫已被其他程式開啟(例如執行中的 Core)也照常執行",
    },
    add: {
      help: "將服務加入本機:寫入 host.toml、以 uv 建立環境、下載缺少的模型檔(先列出大小與授權並確認一次,-y 則不詢問),並列出仍缺少的項目;未指定名稱時列出服務目錄",
      service: "服務名稱(asr、tts、sing、turn、lyrics ...)",
      noInstall: "只寫入 host.toml,不建立環境、不下載",
      extra:
        "要同步的 extras(以逗號分隔,例如 sensevoice);寫入 [services.<名稱>] 的 extras,只能用於單一服務",
    },
    remove: {
      help: "從本機移除服務:停止服務、刪除其環境(保留已下載的模型),並從 host.toml 移除",
      service: "服務名稱",
      keepEnv: "保留環境資料夾",
    },
    models: {
      help: "本機的模型:下載、列出、清除未使用的模型",
      pull: "下載服務的 service.toml 所列的 Hugging Face 模型;省略名稱則為 host.toml 啟用的全部服務",
      service: "服務名稱",
      ls: "列出模型資料夾中的模型、大小,以及使用它們的服務",
      gc: "列出沒有任何已啟用服務使用的模型,確認後刪除(-y 直接刪除)",
    },
    hostd: {
      help: "在此終端機執行本機的主機常駐程式(hostd);`up` 則會在背景啟動它。按 Ctrl+C 停止全部服務",
      start:
        "hostd 啟動後立即啟動 host.toml 啟用的全部服務(登入時自動啟動即使用此選項;未加則只啟動 hostd 本身)",
    },
    up: {
      help: "請 hostd 啟動本機的服務(host.toml 啟用的全部服務,或指定的服務);hostd 未執行時先在背景啟動它",
      service: "服務名稱;省略則為 host.toml 啟用的全部服務",
      foreground: "不經由背景的 hostd,直接在此終端機監管並顯示狀態;按 Ctrl+C 依相反順序停止全部",
      timeout: "最多等待的秒數(hostd 會繼續啟動,可用 status 查看);預設等到每個服務都有結果",
      noWait: "交給 hostd 後即結束,不等待健康檢查",
      noLink:
        "Core 啟動後,不自動將本機連至在本機執行的 Core(預設:本機沒有 host.key 也沒有 [cluster] 時會連線,等同 `host join --local`)",
    },
    down: {
      help: "停止服務;未指定時停止全部服務並結束 hostd",
      service: "服務名稱;省略則停止全部服務並結束 hostd",
    },
    restart: {
      help: "重新啟動一個服務;翻唱或直播進行中時會拒絕,除非加上 --force",
      service: "服務名稱",
      timeout: "最多等待的秒數",
    },
    status: {
      help: "本機服務(hostd)與執行中 Core 的狀態:模組與 LLM 用量;--all 另外列出 Core 已知的每台主機",
      all: "另外列出 Core 中的每台主機,以及已連線主機的服務(透過 Core 的管理 API)",
    },
    logs: {
      help: "檢視服務的記錄檔(<state>/logs/<服務>.log)",
      service: "服務名稱",
      follow: "持續顯示新的內容,按 Ctrl+C 結束",
      lines: "先顯示最後幾行",
    },
    host: {
      help: "本機的設定(host.toml)與主機之間的連線:加入 Core、邀請、核准、移除",
      invite:
        "在 Core 節點上:產生邀請碼(一次性,預設 10 分鐘內有效),並印出另一台主機要執行的 join 指令",
      inviteName: "以此邀請碼加入的主機名稱",
      ttl: "邀請碼的有效分鐘數(1 到 10080)",
      join: "將本機加入 Core:使用邀請碼(Core 在其他主機),或 --local(Core 在本機)",
      coreUrl: "Core 管理 API 的位址,例如 http://192.168.1.10:7878",
      code: "`host invite` 提供的邀請碼",
      joinName: "本機在 Core 中的名稱(預設:host.toml 的 name,否則為作業系統的主機名稱)",
      local:
        "Core 在本機執行:不需要邀請碼,由管理 API 直接建立並核准本機(能力取自 host.toml 啟用的服務)",
      joinForce: "本機已有 host.key 時也重新加入",
      ls: "列出 Core 已知的主機:狀態、連線、已核准的能力、平台、版本、最後上線時間",
      approve: "核准主機,使其服務可被使用;未列出能力時,核准它目前回報的全部能力",
      hostName: "主機名稱",
      capability: "要核准的能力(asr、tts、sing ...)",
      remove: "從 Core 移除主機:撤銷其金鑰、中斷連線,不再使用其服務",
      autostart:
        "本機登入時自動啟動 hostd(再由 hostd 啟動 host.toml 啟用的服務):on 登錄、off 取消登錄、status 查看狀態",
      autostartOn:
        "登錄:此帳號登入時啟動 hostd(Windows:工作排程器中的使用者工作;Linux:systemd 使用者單元)。執行前會先印出指令並確認",
      autostartOff: "取消登錄;未登錄時不執行任何動作",
      autostartStatus: "是否已登錄、執行的指令,以及 hostd 目前是否在執行",
      migrate:
        "從 miyoria.toml 的 [machine] 與 [stack] 產生 host.toml,沿用現有的 Python 環境、埠與 worker 環境變數",
      migrateForce: "覆寫既有的 host.toml",
      migrateDryRun: "只顯示將寫入的內容,不寫入",
    },
    update: {
      help: "git pull(--ff-only)、安裝相依套件、只重建有變更的部分(SDK、擴充套件 dist、管理面板、overlay、Minecraft mod jar)、重新同步過期的 Python 環境,並逐一重新啟動執行中且有變更的服務(翻唱或直播進行中的服務暫不處理)",
      noPull: "不執行 git pull",
      force: "無論是否有變更,全部重建",
      skipMod: "不建置也不安裝 Minecraft mod",
      dryRun: "只列出將執行的動作",
      noRestart: "同步環境,但不重新啟動任何服務",
    },
    core: { help: "啟動 Core(Discord bot、agent ...)" },
    stage: {
      help: "在直播機上啟動 Stage 節點(VTube Studio、OBS、overlay)",
      obsSetup:
        "在 OBS 建立 Miyoria 的場景與來源(背景、翻唱版面、透明立繪、overlay),放在專屬的場景集合與設定檔中,不變更既有的場景集合與設定檔",
      dryRun: "只列出將執行的動作,不變更 OBS",
      relayout: "既有的項目也重新排回預設位置",
      collection:
        "要建立在哪個場景集合(不存在則建立;預設為 [stage.obs] collection,未設定則為 Miyoria)",
      here: "直接建立在 OBS 目前的場景集合中(舊做法)",
      profile: "使用的 OBS 設定檔(不存在則建立;預設為 [stage.obs] profile,未設定則為 Miyoria)",
      noProfile: "不切換設定檔,沿用 OBS 目前的設定檔",
      profileSettings: "既有的設定檔也設為 1920x1080 並開啟重播緩衝(新建立的設定檔一律會設定)",
    },
    chat: {
      help: "在終端機與角色對話(不需要 Discord)",
      name: "對話中使用的名稱",
      defaultName: "你",
      withDiscord: "對話時也連線 Discord bot",
    },
    module: {
      help: "管理執行中 Core 的模組",
      list: "列出模組(Core 未執行時顯示設定檔的內容)",
      offline: "(Core 未執行,顯示設定檔的內容)",
      enable: "啟用模組",
      disable: "停用模組",
      restart: "重新啟動模組",
      id: "模組 id",
    },
    decisions: {
      help: "最近的注意力決策(角色回應或保持沉默的原因)",
      limit: "顯示的筆數",
    },
    events: {
      help: "即時追蹤 Core 的事件,例如 `miyoria events 'agent.*'`",
      topics: "事件主題(可使用萬用字元;省略則為全部)",
    },
    persona: {
      help: "執行中 Core 的人格段落",
      show: "顯示所有人格段落",
      set: "以檔案內容取代一個段落(`-` 代表 stdin)",
      key: "段落名稱",
      file: "檔案路徑或 `-`",
    },
    profile: {
      help: "角色(profile):一次只執行一個,各自擁有人格、設定與資料;主機與配對為共用",
      list: "列出此安裝的角色(● 表示會執行的角色)",
      show: "目前執行的角色:名稱、設定檔與資料夾",
      use: "下次啟動 Core 時執行此角色(寫入 miyoria.toml 的 core.profile;執行中的 Core 需重新啟動)",
      useId: "profiles/ 下的資料夾名稱",
      new: "建立新的空白角色:在 profiles/<id>/ 下建立人格範本、專屬的 miyoria.toml、.env 與 data/",
      newId: "資料夾名稱(小寫英文字母、數字、- 或 _)",
      newName: "角色的名稱(預設:id)",
      validate: "載入並檢查目前的角色",
    },
    discord: {
      help: "Discord bot 工具",
      commands: "斜線指令",
      reset: "刪除 bot 在全域與所有伺服器的斜線指令(清除重複的舊指令;Core 下次啟動時會重新註冊)",
    },
    ext: {
      help: "擴充套件(離線工具;`dev` 會以熱重載啟動 Core)",
      new: "建立 TypeScript 擴充套件骨架",
      name: "套件名稱",
      dir: "上層資料夾",
      list: "列出找到的擴充套件",
      install: "從本機路徑或 git URL 安裝",
      source: "路徑或 git URL",
      validate: "檢查擴充套件的 manifest",
      validateDir: "擴充套件資料夾",
      dev: "以擴充套件熱重載啟動 Core",
    },
  },
};
