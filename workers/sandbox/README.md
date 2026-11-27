# 沙箱服務(`sandbox`)

hostd 在一台有 Docker 的電腦上跑的服務:替她(和 owner、成員、插件)在這台的容器裡跑程式、shell、瀏覽器和插件的程序。Core 經叢集叫它,協定是 HTTP + JSON,`/v1/...`。設計在 [`docs/design/v6-sandbox.md`](../../docs/design/v6-sandbox.md),程式在 [`packages/workspace/sandbox/src/service/`](../../packages/workspace/sandbox/src/service/),Core 那一側在 `packages/workspace/sandbox/src/remote/`。

```
workers/sandbox/
├── service.toml     hostd 的描述檔:`miyoria sandbox serve`,健康檢查 /health
├── routing.toml     [routing]:class = "job"、concurrency = 4、queue = true
└── image/
    ├── Dockerfile        工作跑的映像檔(Python、Node、git、ffmpeg、常用的資料處理套件),代理也用它
    ├── requirements.txt  映像檔裡的 Python 套件
    ├── .dockerignore     預設映像檔不帶 browser/
    └── browser/          瀏覽器的映像檔(第三批,另外建)
```

## 在一台電腦上開

```
miyoria add sandbox        # 寫 [services.sandbox]、在 host.toml 尾巴加註解掉的 [sandbox],問要不要現在建映像檔
miyoria sandbox build      # 建 miyoria/sandbox:1-<雜湊>;第一次約下載 2 GB,問過才做(--yes 不問)
miyoria host approve <這台> sandbox   # 在 Core 那台:owner 核准這台的 sandbox 能力
```

- **映像檔由這台的主人建**,服務自己從不下載或建置。標籤是 `image/` 裡每個檔案內容的雜湊,Dockerfile 一改就是新的標籤;還沒建新的時服務用同一個契約(`1`)最新的舊標籤(`/v1/info` 的 `stale: true`),照樣接工作。
- **沒準備好時** `/health` 照樣回 200,`ready: false` 和原因(Docker 沒有回應、映像檔還沒建好、正在建、`host.toml` 的 `[sandbox]` 讀不進來、磁碟剩不到 `disk_mb` 的 10%、重啟後還在整理上次的工作)。hostd 把它併進這台服務的 `routing.ready` / `reason`,面板的電腦頁看得到,Core 不送工作過來。
- **這台的主人決定的**在 `host.toml` 的 `[sandbox]`(每 60 秒重讀,改了不用重啟):

```toml
[sandbox]
# members = false         # 接成員要的工作。預設不接:owner 和她自己的照接
# plugins = false         # 讓插件的程序在這台跑
# cpus = 4                # 所有工作加起來最多幾顆 CPU;預設這台的一半(至少 1)
# memory_mb = 8192        # 所有工作加起來的記憶體;預設這台的一半,最多 16384
# disk_mb = 20480         # 所有工作的資料夾加起來
# max_job_cpus = 2        # 一個工作最多;預設等於 cpus
# max_job_memory_mb = 4096
# runtime = "runsc"       # Docker 的 --runtime(裝了 gVisor 的 Linux 才寫)
```

  **成員的工作要兩邊都同意**:這台寫 `members = true` 之外,Core 那台的 `miyoria.toml` 要把這台的名字列進 `[modules.sandbox.transfer] member_hosts`(Core 自己那台不用列)。`members` 是這台自己回報的,Core 不能只聽它的:沒列的電腦拿不到成員的工作和他們的資料夾,owner 跑整個工作區時也不會收到 `people/`;`/admin autonomy status` 那台的一行會寫「不在 member_hosts 裡」。Core 認得自己那台,是看它的 hostd 從 127.0.0.1 連進來;如果別台也是經過 Core 這台上的反向代理或通道連進來,它們看起來都像 Core 自己那台,這種架設要知道這件事。

  `[services.sandbox] concurrency` 把同時的工作數從 4 往下調;一個付錢的人(成員)最多佔一半。規則變嚴(例如 `members` 改回 false),開著的成員工作在服務讀到新的規則後(兩分鐘內)關掉,正在跑的那次跑完才關(`host_policy`)。

## 一個工作有什麼

每個工作是一個長駐容器(`sleep infinity`,主程序是另一個 uid),加上它自己的資料夾(`<state>/sandbox/jobs/<工作>/`,`jobs/` 是 0700)、自己的 `--internal` 網路和自己的出口代理容器。

| 擋的傷害 | 怎麼擋 |
|---|---|
| 碰到這台的檔案和密鑰 | 只掛這個工作自己的 `work`、`workspace`、`home`、`code`(唯讀)、`tools`、`ext`(唯讀);沒有 Docker socket;唯讀的根目錄;沒有這台的環境變數(只有寫死的幾個和 Core 給的,名字檢查過);`--cap-drop ALL`、`no-new-privileges`、非 root(程式和主程序不同 uid)、`--ipc none`。服務在主機這邊讀寫工作的資料夾(上傳、送回)時,容器裡沒有程式在跑:工作階段先殺掉程式的 uid 的所有程序,有背景程序的(瀏覽器、插件)用 `docker pause` 凍住,所以容器裡的程式來不及在檢查和開檔之間把資料夾換成連結 |
| 透過 tar 寫到別的地方 | 只有 `tar-io` 解 tar:只收一般檔案和資料夾,路徑過 `normalizeRelativePath`(擋 `..`、絕對路徑、磁碟代號、反斜線、`:`、控制字元、保留名稱),不穿過已經在那裡的連結,`O_EXCL` 寫,不照 tar 裡的權限(setuid 不會落地) |
| 透過連結把這台的檔案帶出去 | 送回 Core 時逐段 `lstat`,連結、裝置不收(寫在 `skipped`),開檔用 `O_NOFOLLOW` |
| 連到區網、tailnet、管理介面、雲端中繼資料 | 工作只接自己的 `--internal` 網路,唯一的出路是代理。代理自己解析一次、所有位址都要通過、只連它檢查過的那個(不怕 DNS rebinding);擋私有、loopback、連結本機、CGNAT 和 tailnet(`100.64.0.0/10`)、中繼資料、IPv6 的 ULA、連結本機、多播和所有帶著 IPv4 的形式(mapped、compatible、NAT64 兩個前綴、6to4、Teredo);另外擋這台自己的位址、它所在的網段和 Docker 的 bridge(有些電腦的是公開位址,例如全域的 IPv6 前綴);名字 `localhost`、`metadata`、`*.internal`、`*.local`、單一標籤的名字也擋 |
| 用這台寄信 | 25、465、587 一律擋(Core 怎麼設都一樣) |
| 用光這台的資源 | 每個工作的 `--cpus`、`--memory`(沒有 swap)、`--pids-limit`、`--ulimit fsize/nofile`、`/tmp` 的大小;整台的 CPU、記憶體、磁碟預留;資料夾每 5 秒量一次,超過 `disk_mb` 就停;代理的同時連線數和進出流量上限;CPU 秒數從容器的 cgroup 讀,Core 算進每人的工作額度 |
| 留下東西 | 租約(Core 沒來續)、閒置、最長時間到了就拆掉容器、代理、網路和資料夾;服務重啟時還在跑、租約沒到的工作接回來(先殺掉之前在跑的程式),其他屬於這個服務的容器、網路、資料夾全部拆掉 |

## 剩下的風險

- **容器不是 VM**。核心的漏洞可以逃出容器;Docker Desktop 的 VM 碰得到 Windows 的磁碟。成員的程式逃出去,碰到的是這台主人的檔案。Linux 上可以寫 `runtime = "runsc"`。
- **開放的網路**:可以從這台的公開 IP 掃描或打別人的公開服務、大量下載。限制它的是連線數、流量、每人的 CPU 額度;濫用投訴會寄到這台主人的網路業者。
- **這台在 NAT 後面的公開 IPv4**:服務不知道它(要上網問),所以代理不擋它;從裡面連它會繞回路由器的連接埠轉發。這台主人轉發到這台的服務,工作連得到。
- **DNS**:工作的容器可以用 Docker 內建的 DNS 查名字(會轉給這台的 DNS),所以可以用 DNS 查詢把資料送出去;連不到任何服務。
- **磁碟**:bind mount 沒有配額,一次執行裡可以在被量到之前先寫到 5 秒的量。
- 跑過的組合:這份程式在沒有 Docker 的 Windows 上用假的 Docker 測過;真的 Docker 的測試(`test/service/docker.integration.test.ts`,攻擊者在容器裡的角度)在 CI 的 Linux 跑。Docker Desktop、`--cgroupns private` 在 cgroup v1 的機器、`--ipc none` 加 `/dev/shm` 的 tmpfs 還沒在真的電腦上驗證過。

## 協定

見設計文件 §3,形狀在 `@miyoria/contracts/workers`(`JobCreate`、`ExecStart`、`SandboxEvent`……)。補充:

- `GET /v1/jobs/{job}` 對已經結束的工作回 410(附 `ended`);`DELETE` 照樣回最後的 `JobView`。結束了的工作記一小時。
- 一次 exec 的結果在工作結束後還拿得到(`GET .../execs/{exec}`),它的 log 拿不到了。
- `PUT .../procs/{proc}` 回 `{ id, state, code, signal, stdin_offset, stdout_offset, stderr_offset }`(設計沒寫形狀);`GET .../stdout?after=&stream=stderr` 拿 stderr。
- `PUT .../uploads/{upload}` 可以帶 `x-delete`(JSON 的路徑清單):先刪那些一般檔案再解。
- sync 的 tar 一律不壓縮(`application/x-tar`)。
- 沒有 token 時服務只肯聽 loopback。
