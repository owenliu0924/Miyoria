# 階段 7 第二批:沙箱是一個服務

> 2026-11-27。[v6-agent.md](v6-agent.md)「第二批」的實作設計。第三批的瀏覽器和第四批的插件程序都疊在這裡的協定上(§3.7 的 `procs`),它們自己的部分在 [v6-agent-split.md](v6-agent-split.md)。
>
> 這份文件裡講到現有程式的地方都寫了檔案和名字;沒寫的就是新的。要 owner 決定的在 §16,只有三題,其他都選了預設值並寫明。

## 結論

- 沙箱變成 hostd 管的服務 `sandbox`(`workers/sandbox/service.toml`,`class = "job"`)。它是一個 Node 程式(`miyoria sandbox serve`),在那台電腦上用 Docker CLI 開容器,沿用現在 `DockerSandbox` 的參數和防護(`packages/workspace/sandbox/src/args.ts` 的 `buildRunArgs`、`runner.ts` 的 `ProcessDockerRunner`)。
- Core 經過叢集的 `EndpointRegistry.request`(`packages/cluster/src/registry.ts`)叫它,協定是 HTTP + JSON,`/v1/...`。每個會改東西的呼叫都是 `PUT` 加 Core 自己取的編號,所以 `routedRequest`(`packages/cluster/src/routed.ts`)可以在換路徑時安全重送。輸出用一條「每台一個」的長輪詢拿回來(§3.5),不用 WebSocket(控制連線的中繼不轉 WebSocket,v5-hostd §7.1)。
- 一個「工作」(job)是一個長駐的容器(`sleep infinity` 當主程序,和現在的工作階段一樣)加上它自己的資料夾和它自己的出口代理。用完即丟的 `code_run` 也是一個工作:開、跑一次、收、關。
- 工作區跟著工作走:開始時 Core 把那個人的資料夾打成 tar、分段上傳;每次執行完,服務算出改了哪些檔,Core 拿回改動的 tar 套回自己的工作區,再跑一次現在的事後檢查(`PersistentWorkspace.enforce`)。上限 1 GiB,分段 8 MiB,每一段都有長度,經過 tunnel(100 MB 上限)也走得通。
- 能上網:每個工作一個代理容器,擋私有、連結本機、tailnet、雲端中繼資料位址和 25 / 465 / 587 埠,每個工作有連線數和流量上限,其他都放行。代理是現在的 `EGRESS_PROGRAM`(`egress.ts`)擴充,不換成別的套件(§15)。
- 映像檔 `miyoria/sandbox:1-<雜湊>` 在那台電腦上從 `workers/sandbox/image/Dockerfile` 建,帶 Python、Node、git、ffmpeg 和常見的資料處理套件。沒建好時服務回報「沒準備好」和原因,Core 不送工作。
- CPU 秒數從容器自己的 cgroup(`cpu.stat` 的 `usage_usec`)讀,算進每人的工作額度,記在現有的 `quota_spend` 表(人的鍵前面加 `~cpu:`,不用新表)。
- 跑程式在沙箱裡是中風險,不再每次過審查;存成之後會自動跑的腳本或工具仍然是高風險要審查。
- 預設不接成員的工作:一台電腦的 `host.toml` 要寫 `[sandbox] members = true` 才接。

## 現在的樣子

- `SandboxModule`(`packages/workspace/sandbox/src/module.ts`)在 Core 的程序裡建一個 `DockerSandbox`(`sandbox.ts`),直接在 Core 那台跑 Docker CLI。Docker 不在就 degraded,`SandboxGate.setAvailable(false)`(`gate.ts`)撤掉 `code_run`、`code_session`、`workspace_run`、`workspace_save_script`、`tool_propose`。工作區的檔案工具不需要 Docker,`offerWorkspace` 一直都在。
- fresh 執行是 `docker run --rm -i`;工作階段是一個 `docker run -d … sleep infinity`(`KEEPER_COMMAND`,主程序用另一個 uid,`keeperUser`),每次執行 `docker exec`,結束後 `killAllArgs` 以程式的 uid `kill -KILL -1`(`DockerSandbox.#execInSession`)。
- 工作區在 Core 的磁碟:`<root>/profiles/<profile>/workspace`(`DockerSandbox` 的建構子)。替人做的執行只掛 `people/<資料夾>/`(`people.ts` 的 `scopeFor`、`workspaceFor`、`PersonWorkspace`);整個工作區掛的時候蓋掉 `people`(`ContainerSpec.hiddenInWorkspace`)。執行完 `#runFresh` 照順序做:`snapshot()` → 跑 → `enforce(before)` → `CountedWorkspace.replaceFolder`。
- 網路:預設 `--network none`;`[modules.sandbox.network] allow` 有主機時,一個 `--internal` 網路加一個全實例共用的代理容器(`#startEgress`、`egressProxyArgs`),只放行清單上的主機的 80 / 443。backlog 記著這條路沒在真的 Docker 上跑過。
- 限制(`config.ts` 的 `SandboxLimitsSchema`、`SandboxCapsSchema`):256 MiB、1 CPU、逾時預設 30 秒最長 120 秒、單檔 16 MiB、輸出檔合計 1 MiB。
- `code_run` 是高風險、`followup`(`gate.ts` 的 `codeRunCapability`):每次過她自己的審查(`CODE_RUN_GUIDANCE`)。`CapabilityTool.followup` 的說明寫「只有高風險」(`packages/gate/actions/src/capability.ts`),`CapabilityTools.#run`(`tools.ts`)也只在 `risk === "high"` 時走 `#waitOrFollowUp`。
- 叢集:`job` 類的能力由 `EndpointRegistry.candidates` 照分數排,`reserve` 記派出去的單位(v5-hostd §15.3)。`request` 經直連、路徑表或控制連線的中繼送;中繼每台最多 16 條同時的串流,請求內容和回應都是串流,每段 64 KiB、視窗 1 MiB(§7.1)。tunnel 路徑的請求內容上限 100 MB,超過或長度不明的上傳不走那條(`routes.ts` 的 `maxBodyBytes`)。`GET` 下載有 ETag、長度和 range 時中斷會從斷點接著拿(`routed.ts` 開頭的說明)。
- hostd:`host.toml` 的 `[services.<name>] accept`、`concurrency` 已經存在(`packages/contracts/host/src/host-config.ts` 的 `HostServiceConfigSchema`),Core 照著做。準備好沒有只看 `[routing] needs`(`packages/hostd/src/routing.ts` 的 `serviceRouting`);負載從健康檢查的回答讀 `running` / `busy` / `queued`(`loadOf`、`service.ts` 的 `#readLoad`)。遠端更新在服務的健康回答說 `busy: true` 或 `queued > 0` 時會等(`daemon.ts` 的 wait 步驟,讀 `busy` 和 `queued`)。
- 沒有 Node 寫的服務檢查 `MIYORIA_SERVICE_TOKEN`:現在只有 Python 的 `workers/service_auth.py`。

## 1. hostd 的 `sandbox` 服務

### 1.1 描述檔

`workers/sandbox/service.toml`:

```toml
# 程式沙箱:在這台的 Docker 裡替她跑程式、shell、瀏覽器和插件(docs/design/v6-sandbox.md)。
name = "sandbox"
kind = "worker"
provides = ["sandbox"]
platforms = ["win32", "linux", "darwin"]
summary = "程式沙箱(Docker 容器)"

[install]
runtime = "node"
system = ["docker"]

[run]
command = ["{miyoria}", "sandbox", "serve"]
cwd = "{workspace}"
port = "auto"
host_env = "HOST"
port_env = "PORT"
# 服務自己讀 host.toml 的 [sandbox](§12.1);狀態放在 hostd 的狀態資料夾底下。
env = { SANDBOX_HOST_TOML = "{workspace}/host.toml", SANDBOX_STATE = "{state}/sandbox", SANDBOX_IMAGE_DIR = "{service}/image" }
# Docker CLI 要的;其他的照 hostd 的基本清單(packages/hostd/src/env.ts 的 workerBaseEnv)。
pass_env = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]

[run.health]
http = "/health"
startup_s = 30
interval_s = 10

[run.stop]
grace_s = 20
```

`{miyoria}`、`{workspace}`、`{state}`、`{service}` 都是 hostd 認得的佔位符(`packages/hostd/src/catalog.ts` 的 `PLACEHOLDERS`)。`workers/sandbox/routing.toml`(放在旁邊的理由見 v5-hostd §15.1):

```toml
# job:每個工作各自獨立,哪台都可以做;一個工作開了之後留在那台(Core 自己記,§9.3)。
class = "job"
latency = "interactive"
concurrency = 4          # 一台同時最多幾個工作;那台的主人用 [services.sandbox] concurrency 往下調
queue = true             # /health 回報 running、busy、queued(§1.3)
unit_s = 60
result_mb = 5
```

不寫 `yields_to`:每個工作有 `--cpus` 上限,整台另外有 `[sandbox] cpus` 總上限(§12.1),她的語音那台照樣可以接。要讓語音那台不接,owner 寫 `[modules.cluster.routing.capabilities.sandbox] exclude = ["main-pc"]`(v5-hostd §15.6),不用改描述檔。

`HOST_CAPABILITIES`(`packages/contracts/host/src/protocol.ts`)加上 `"sandbox"`,面板的核准畫面才列得出來。一台電腦要先被 owner 核准 `sandbox`(`miyoria host approve <name> sandbox`)Core 才會用它,和其他能力一樣(v5-hostd §7)。

### 1.2 程式在哪

- 服務:`packages/workspace/sandbox/src/service/`,從新的子路徑 `@miyoria/workspace/sandbox-service` 匯出 `startSandboxService(options)`。CLI 的 `packages/cli/src/commands/sandbox.ts` 有 `serve` 和 `build`(§6.3)。
- 它重用 `args.ts`(`buildRunArgs`、`execArgs`、`killAllArgs`、`keeperUser`、`dockerCliEnv`、標籤常數)、`runner.ts`、`egress.ts`、`semaphore.ts`、`paths.ts`(`normalizeRelativePath`)、`workspace.ts`(`writeInputs`、`collectOutputs`、`walkWork`)。不重用 `DockerSandbox` 這個類別本身:它綁著 profile、工具資料夾、Core 的工作區。
- 協定的形狀:`packages/contracts/workers/src/sandbox.ts`(zod,`.meta({ id })`,照 v5-contracts 的規則),匯出到 `schema/workers.json`。`@miyoria/contracts/workers` 本來就是「worker 的 HTTP 本體」(`workers/src/index.ts` 開頭)。
- HTTP 伺服器用 `node:http`,不加框架:路由十幾條,本體都是 JSON 或原始位元組。

### 1.3 健康檢查和「準備好」

`GET /health`(不用 token 以外的東西,hostd 的探測本來就帶 token):

```json
{ "status": "ok", "running": 1, "busy": true, "queued": 0, "ready": false,
  "reason": "這台的 Docker 沒有回應(docker version: error during connect)" }
```

- 永遠回 200:Docker 沒開不是服務壞了。回 503 會讓 hostd 連續三次失敗就重啟它(v5-hostd §4),Docker 一關就變成重啟迴圈。
- `running` 是正在執行的 exec 數,`busy` 是 `running > 0`,`queued` 是等名額的建立請求。遠端更新的 wait 步驟讀 `busy` 和 `queued`,所以有程式在跑時更新會等;開著但閒置的工作階段不擋更新(更新重啟服務時它們照 §13.3 接回去)。
- **hostd 的改動**:`loadOf`(`packages/hostd/src/routing.ts`)多讀可省略的 `ready`(布林)和 `reason`(字串),`serviceRouting` 把「服務自己說沒準備好」併進 `ready` / `reason`,和 `needs` 的原因用「;」接起來。只對 `queue = true` 的服務讀(本來就只有它們的回答會被讀,`#reportsLoad`)。`HostServiceRoutingSchema` 已經有 `ready` 和 `reason`,協定不變,舊的 Core 照樣讀得懂。這樣「映像檔還沒建好」「Docker 沒開」會出現在面板的電腦頁,Core 的 `candidates` 也不會把工作送過去(not ready 的端點不接新工作,§15.3)。
- 沒準備好的原因(固定的幾種,zh-TW):Docker 沒有回應、映像檔還沒建好(附指令)、映像檔正在建、`host.toml` 的 `[sandbox]` 讀不進來(附錯誤)、磁碟剩不到 `[sandbox] disk_mb` 的 10%。

## 2. 一個工作

### 2.1 種類

| `kind` | 誰開 | 裡面跑什麼 | 生命 |
|---|---|---|---|
| `run` | `code_run` 的 fresh、`workspace_run`、她寫的工具、附件抽文字 | 一次 exec | 跑完收完就關 |
| `session` | `code_run` 的具名工作階段、`shell_run` | 多次 exec,一次一個 | 閒置 15 分鐘、最長 2 小時(設定) |
| `browser` | 第三批 `browse_*` | 一個 `proc`:瀏覽器驅動 | 閒置 15 分鐘、最長 2 小時 |
| `plugin` | 第四批插件 | 一個 `proc`:插件程序 | 跟著插件模組,沒有最長 |

exec 和 proc 不會在同一個工作裡:exec 結束時的 `kill -KILL -1` 會殺掉同一個 uid 的所有程序,proc 不能活在那裡。

### 2.2 服務那台的資料夾

`<state>/sandbox/`(`SANDBOX_STATE`):

```
instance.json                  這個服務的編號(標籤用)和啟動編號(boot id)
jobs/<job>/job.json            建立時的請求、租約、時間(§13.3 重啟後接回用)
jobs/<job>/work/               /work:這次的暫存,不送回 Core
jobs/<job>/workspace/          /workspace:那個人的資料夾(或她的工作區),會送回 Core
jobs/<job>/home/               /home/sandbox:裝的套件留在這,跟著工作消失
jobs/<job>/code/               /code:程式檔,唯讀掛
jobs/<job>/tools/              /tools:她留的腳本,唯讀掛(要時才有)
jobs/<job>/ext/                /ext:插件的資料夾,唯讀掛(plugin 才有)
jobs/<job>/incoming/<upload>/  上傳中的分段
jobs/<job>/outgoing/<sync>.tar 等 Core 拿走的改動
jobs/<job>/execs/<exec>.log    一次 exec 的完整輸出(最多 kill_bytes)
images.json                    建過的映像檔(§6)
```

所有路徑都用現有的檢查(`paths.ts` 的 `normalizeRelativePath`、`safeJoin`),逐段 `lstat`,不跟隨連結。

### 2.3 容器

工作的容器(把 `buildRunArgs` 加上三個欄位:`homeDir`、`cgroupns`、可寫的 `/tmp`):

```
docker run -d --name miyoria-sbx-<job>
  --label miyoria.sandbox=1 --label miyoria.sandbox.instance=<instance> --label miyoria.sandbox.job=<job>
  --label miyoria.sandbox.kind=<run|session|browser|plugin>
  --pull never --log-driver none --cgroupns private
  --network <miyoria-sbx-net-<job> | none>
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=<tmp_mb>m
  [--tmpfs /dev/shm:rw,nosuid,nodev,size=256m]                       (browser)
  --mount type=bind,source=<job>/work,target=/work
  --mount type=bind,source=<job>/workspace,target=/workspace
  --mount type=bind,source=<job>/home,target=/home/sandbox
  --mount type=bind,source=<job>/code,target=/code,readonly
  [--mount type=bind,source=<job>/tools,target=/tools,readonly]
  [--mount type=bind,source=<job>/ext,target=/ext,readonly]           (plugin)
  --workdir /workspace --user <keeper uid>
  --cap-drop ALL --security-opt no-new-privileges --ipc none --hostname sandbox
  --memory <memory_mb>m --memory-swap <memory_mb>m --cpus <cpus> --pids-limit <pids>
  --ulimit fsize=<file_bytes> --ulimit nofile=<nofile>:<nofile> --init
  --env HOME=/home/sandbox --env TMPDIR=/tmp --env LANG=C.UTF-8
  --env PATH=/home/sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin
  --env PIP_USER=1 --env NPM_CONFIG_PREFIX=/home/sandbox/.local
  [--env HTTP_PROXY=http://egress-proxy:3128 ...(proxyEnv)]
  [--runtime <runtime>]                                                (host.toml [sandbox] runtime)
  <image> sleep infinity
```

和現在一樣的:沒有主機的環境變數(值寫死在程式裡,`CONTAINER_ENV` 的做法)、Docker CLI 自己的環境也過濾(`dockerCliEnv`)、沒有 Docker socket、沒有特權、`--cap-drop ALL`、非 root(`resolveUser`、`keeperUser`)、程式不經 shell 上命令列(寫成 `/code/` 的檔案)。

和現在不同的,每一項擋的傷害:

- `/tmp` 不再 `noexec`、`/home/sandbox` 可寫可執行:`pip install`、`npm install` 編譯原生模組要。整個容器就是沙箱,容器裡能不能執行檔案不是邊界。
- `--cgroupns private`:讓容器裡的 `/sys/fs/cgroup` 是它自己的 cgroup,CPU 秒數才讀得到(§7)。cgroup v2 的 Docker 本來就預設 private,寫明是為了 cgroup v1 的機器也一樣。
- 每個工作自己的網路和代理(§5),不是整個實例共用一個。
- 沒有暖池:一個工作要建資料夾、送檔案、開代理,省下的容器啟動時間(約 200 ms,README 的量測)比不上這些。`pool_size` 只留給 `backend = "local"`(§9.1)。

uid:程式(exec)和 proc 用 `resolveUser(config.user)` 的結果(Linux 上是主機的 uid,其他是 65534),主程序用 `keeperUser`(另一個 uid)。和現在的工作階段一樣。

### 2.4 狀態

```
starting ──▶ ready ⇄ busy(一個 exec 在跑)
   │           │
   └──────────▶ ended(reason)
```

`ended` 的原因(`SandboxEndReason`):`closed`(Core 關的)、`idle`、`lifetime`、`lease`(Core 沒來續租)、`disk`(超過 `disk_mb`)、`lost`(容器不見了)、`shutdown`(服務停了)、`host_policy`(那台的主人改了設定,不再接這種工作)。前六種和現在的 `SessionCloseReason`(`types.ts`)同名同意思;Core 對應回去,`lease` 和 `host_policy` 對她說成 `lost`。

## 3. 協定

### 3.1 慣例

- 全部在 `/v1/` 底下。認證:`authorization: Bearer <MIYORIA_SERVICE_TOKEN>`,也接受 `MIYORIA_HOST_TOKEN`(v5-hostd §7)。經中繼時 hostd 自己加 token(§7.1),直連時 Core 的 registry 從端點的 `headers` 加。服務裡用 `node:crypto` 的 `timingSafeEqual` 比對,錯了一律 401、不說原因。
- 編號都是 Core 取的 ULID(小寫):工作、上傳、exec、sync、proc。會改東西的呼叫都是 `PUT <資源>/<編號>`:同一個編號、同樣的內容再送一次,回同樣的結果;同一個編號不同的內容回 409 `conflict`。`routedRequest` 只重送 `GET`、`HEAD`、`OPTIONS`、`PUT`、`DELETE` 和沒送出去的請求(`IDEMPOTENT`),所以換路徑時不會重複開工作或重複執行。
- 請求本體:JSON(`content-type: application/json`,最大 8 MiB)或原始位元組(上傳分段,§4)。每個請求都要有 `content-length`:長度不明的上傳不走 tunnel(`routes.ts`)。
- 時間是 epoch 毫秒。路徑裡的編號用 `^[0-9a-z]{26}$` 檢查。
- 錯誤一律是 `{ "error": { "code", "message", ... } }`,§3.8。

### 3.2 呼叫一覽

| 方法 | 路徑 | 做什麼 | Core 的逾時 |
|---|---|---|---|
| GET | `/health` | §1.3 | hostd 的探測 |
| GET | `/v1/info` | 這台的狀態、規則、空位 | 5 s |
| PUT | `/v1/jobs/{job}` | 開一個工作 | 120 s |
| GET | `/v1/jobs/{job}` | 一個工作的狀態和用量 | 10 s |
| GET | `/v1/jobs` | 這台所有的工作(Core 重啟後對帳) | 10 s |
| PUT | `/v1/jobs/{job}/lease` | 續租 | 10 s |
| DELETE | `/v1/jobs/{job}` | 關掉,回最後的用量 | 60 s |
| PUT | `/v1/jobs/{job}/uploads/{upload}/parts/{n}` | 上傳一段 | 60 s 一段 |
| PUT | `/v1/jobs/{job}/uploads/{upload}` | 上傳完成:檢查、解開 | 120 s |
| PUT | `/v1/jobs/{job}/execs/{exec}` | 開始一次執行(立刻回) | 15 s |
| GET | `/v1/jobs/{job}/execs/{exec}` | 一次執行的狀態;結束了附結果 | 10 s |
| DELETE | `/v1/jobs/{job}/execs/{exec}?reason=` | 停掉一次執行 | 15 s |
| GET | `/v1/jobs/{job}/execs/{exec}/log` | 完整輸出(range) | 標頭 60 s |
| PUT | `/v1/jobs/{job}/syncs/{sync}` | 算出 `/workspace` 改了什麼,打成 tar | 120 s |
| GET | `/v1/jobs/{job}/syncs/{sync}/tar` | 拿那個 tar(ETag、長度、range) | 標頭 60 s,內容沒資料 60 s 就斷 |
| DELETE | `/v1/jobs/{job}/syncs/{sync}` | 收完了,刪掉 | 10 s |
| PUT | `/v1/jobs/{job}/procs/{proc}` | 開一個背景程序,stdio 接到頻道 | 30 s |
| PUT | `/v1/jobs/{job}/procs/{proc}/stdin?offset=` | 寫進 stdin | 15 s |
| GET | `/v1/jobs/{job}/procs/{proc}/stdout?after=` | 補拿 stdout(漏掉時) | 10 s |
| DELETE | `/v1/jobs/{job}/procs/{proc}` | 停掉 | 15 s |
| GET | `/v1/events?after=&wait_ms=` | 長輪詢:這台所有工作的事件 | wait + 15 s |

### 3.3 形狀

```ts
// packages/contracts/workers/src/sandbox.ts(這裡寫成 TypeScript;檔案裡是 zod,型別由它推出)

export const SANDBOX_API_VERSION = 1;

/** 映像檔的角色;實際的標籤由那台電腦決定(§6)。 */
export type SandboxImage = "default" | "browser";

/** 替誰做:那台的主人用 [sandbox] members / plugins 決定接哪些(§12.1)。 */
export type SandboxFor = "self" | "owner" | "member" | "plugin";

export type SandboxEndReason =
  | "closed" | "idle" | "lifetime" | "lease" | "disk" | "lost" | "shutdown" | "host_policy";

export type SandboxKilledReason =
  | "timeout" | "aborted" | "output_limit" | "memory" | "quota" | "disk" | "lost";

export interface SandboxInfo {
  api: 1;
  service_version: string;
  /** 每次服務啟動換一個;事件的游標帶著它(§3.5)。 */
  boot: string;
  platform: string;            // process.platform
  arch: string;
  docker: { available: boolean; server_version: string | null; error: string | null;
            cgroup: "v2" | "v1" | null; runtime: string | null };
  images: Record<SandboxImage, {
    tag: string; present: boolean; building: boolean;
    /** 用的是之前建的版本(Dockerfile 改過、新的還沒建)。 */
    stale: boolean;
  }>;
  ready: boolean;
  reason?: string;
  /** host.toml 的 [sandbox],套上預設之後(§12.1)。 */
  policy: { members: boolean; plugins: boolean; cpus: number; memory_mb: number;
            disk_mb: number; max_job_cpus: number; max_job_memory_mb: number };
  /** 現在用掉的(預留的,不是量到的)。 */
  load: { jobs: number; running: number; queued: number;
          cpus: number; memory_mb: number; disk_mb: number };
}

export interface SandboxLimits {
  cpus: number;          // --cpus
  memory_mb: number;     // --memory = --memory-swap
  pids: number;          // --pids-limit
  tmp_mb: number;        // /tmp 的 tmpfs
  file_mb: number;       // --ulimit fsize
  nofile: number;
  /** /work + /workspace + /home 合計;每 5 秒量一次,超過就停 exec、關工作(disk)。 */
  disk_mb: number;
}

export interface SandboxNetwork {
  mode: "open" | "allowlist" | "none";
  /** allowlist 才看:主機名稱或 *.example.com,和現在的 ALLOWED_HOST 同規則。 */
  allow: string[];
  /** open 也擋的埠。 */
  deny_ports: number[];
  /** 同時開著的連線。 */
  max_connections: number;
  /** 進出合計,MiB。 */
  max_mb: number;
}

export interface JobCreate {
  kind: "run" | "session" | "browser" | "plugin";
  image: SandboxImage;
  for: SandboxFor;
  /**
   * 付錢的人的代號:HMAC-SHA256(Core 自己的密鑰, person key) 的前 16 個十六進位字。
   * 那台只用它算每人同時幾個工作、寫日誌;認不出是誰。她自己的工作是 null。
   */
  payer: string | null;
  limits: SandboxLimits;
  network: SandboxNetwork;
  /** 0 = 沒有上限(plugin)。 */
  lifetime_s: number;
  idle_s: number;
  /** 這麼久沒有任何呼叫碰到這個工作就關(lease)。 */
  lease_s: number;
  mounts: { tools: boolean; ext: boolean };
  /** 給容器的環境變數:名字 ^[A-Z][A-Z0-9_]{0,63}$,值最多 4 KiB,最多 32 個;Core 自己的環境從來不送。 */
  env: Record<string, string>;
  /** 給人看的:工作階段的名字、插件的 id。不影響行為。 */
  label: string | null;
}

export interface JobUsage {
  /** 容器的 cgroup 用掉的 CPU,毫秒(§7)。 */
  cpu_ms: number;
  /** 量法:cgroup 的累計值,或 docker stats 抽樣加總(較不準)。 */
  cpu_source: "cgroup" | "sampled";
  wall_ms: number;
  disk_bytes: number;
  egress: { bytes_in: number; bytes_out: number; connections: number;
            refused: { address: number; port: number; cap: number } };
}

export interface JobView {
  id: string;
  kind: JobCreate["kind"];
  state: "starting" | "ready" | "busy" | "ended";
  ended: { reason: SandboxEndReason; at: number } | null;
  image_tag: string;
  /** 實際套用的(那台可能往下調,§12.1)。 */
  limits: SandboxLimits;
  created_at: number;
  last_used_at: number;
  /** idle、lifetime、lease 裡最早的那個。 */
  expires_at: number;
  usage: JobUsage;
  /** 正在跑的 exec。 */
  exec: string | null;
  procs: string[];
}

export interface UploadPartResult { n: number; bytes: number; sha256: string }

export interface UploadCommit {
  parts: number;
  bytes: number;
  /** 所有分段接起來的 SHA-256。 */
  sha256: string;
  format: "tar" | "tar.gz";
  /** 解到哪:/workspace、/tools、/ext、/work。 */
  target: "workspace" | "tools" | "ext" | "work";
  /** true:先清空 target。開工作後第一次送 workspace 時是 true。 */
  replace: boolean;
  /** 這份 tar 的清單(§4.2);服務解開後用它當「Core 那邊現在的樣子」。 */
  manifest: ManifestEntry[];
}

export interface ManifestEntry { path: string; size: number; sha256: string; mtime_ms: number }

export interface UploadResult {
  files: number;
  bytes: number;
  /** 不收的項目和原因(連結、裝置、路徑不對、太大)。 */
  skipped: { path: string; why: string }[];
}

export interface FileIn { path: string; content: string; encoding?: "utf8" | "base64" }

export interface ExecStart {
  /** 二選一:一段程式(寫成 /code/<exec>.<ext>),或一個參數清單。 */
  program?: { language: "python" | "node" | "shell"; code: string };
  argv?: string[];
  stdin?: string;                    // 最多 1 MiB
  files?: FileIn[];                  // 先寫進 /work,合計最多 4 MiB
  cwd?: "/work" | "/workspace";      // 預設 /workspace
  timeout_ms: number;
  env?: Record<string, string>;      // 同 JobCreate.env 的規則
  output: {
    /** stdout、stderr 各留多少給結果。 */
    keep_bytes: number;
    /** 合計超過就停(output_limit)。 */
    kill_bytes: number;
    /** 事件裡最多送多少,之後只送 cpu 和 exit;完整的在 log。 */
    stream_bytes: number;
  };
  /** 結束時把 /work 新增或改過的檔案一起帶回(現在的 files_out)。 */
  collect: { max_files: number; max_bytes: number } | null;
}

export interface FileOut { path: string; size: number; encoding: "utf8" | "base64"; content: string }

export interface ExecResult {
  exit_code: number | null;
  killed_reason: SandboxKilledReason | null;
  duration_ms: number;
  /** 這次 exec 期間容器用掉的 CPU(開始和結束時 cgroup 的差)。 */
  cpu_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  files_out: FileOut[];
  files_out_truncated: boolean;
  /** log 的長度,要完整輸出時用 range 拿。 */
  log_bytes: number;
}

export interface ExecView {
  id: string;
  state: "running" | "done" | "lost";
  started_at: number;
  result: ExecResult | null;
}

export interface SyncStart {
  /** 只有 workspace 會送回 Core。 */
  target: "workspace";
}

export interface SyncResult {
  /** 和上次 sync(或上傳的清單)比,改過或新增的。 */
  changed: ManifestEntry[];
  deleted: string[];
  skipped: { path: string; why: string }[];
  /** changed 是空的時候沒有 tar。 */
  tar: { bytes: number; sha256: string } | null;
}

export interface ProcStart {
  argv: string[];
  cwd?: "/work" | "/workspace" | "/ext";
  env?: Record<string, string>;
}

export type SandboxEvent =
  | { seq: number; job: string; kind: "state"; state: JobView["state"] }
  | { seq: number; job: string; kind: "cpu"; cpu_ms: number }            // 工作累計,每 10 秒
  | { seq: number; job: string; exec: string; kind: "stdout" | "stderr"; text: string }
  | { seq: number; job: string; exec: string; kind: "exit"; result: ExecResult }
  | { seq: number; job: string; proc: string; kind: "proc_out";
      stream: "stdout" | "stderr"; offset: number; data_b64: string }
  | { seq: number; job: string; proc: string; kind: "proc_exit";
      code: number | null; signal: string | null }
  | { seq: number; job: string; kind: "ended"; reason: SandboxEndReason; usage: JobUsage };

export interface EventsPage {
  /** 下一次的 after:`<boot>:<seq>`。 */
  cursor: string;
  events: SandboxEvent[];
  /**
   * 游標是別次啟動的,或 Core 太久沒來、事件已經丟掉:Core 要用 GET /v1/jobs 重新對帳,
   * proc 的輸出用 GET .../stdout?after= 補。
   */
  reset: boolean;
}
```

### 3.4 開一個工作

`PUT /v1/jobs/{job}` 本體 `JobCreate`,回 `201 JobView`(同一個編號再送回 `200`)。服務照順序:

1. 檢查本體;`for` 不被 `policy` 接受(`member` 而 `members = false`,`plugin` 而 `plugins = false`)回 403 `not_accepting`。
2. 預留資源:`limits` 先往下調到 `max_job_cpus`、`max_job_memory_mb`;加上已經預留的超過整台的 `cpus`、`memory_mb`、`disk_mb`,或工作數到了 `concurrency`,回 429 `busy`(附 `retry_after_ms`)。不排隊:Core 有別台可以換(§9.2)。
3. 映像檔不在回 503 `unavailable`(附原因)。
4. 建資料夾、寫 `job.json`;`network.mode` 不是 `none` 就開網路和代理(§5);開容器;等它 `running`。
5. 回 `JobView`(`state: "ready"`)。

任何一步失敗:已經開的容器、網路、資料夾都拆掉,回錯誤。

### 3.5 事件:每台一條長輪詢

`GET /v1/events?after=<cursor>&wait_ms=<≤25000>&max_bytes=<≤1048576>`:有事件就馬上回,沒有就等到 `wait_ms`。一頁最多 `max_bytes`。

- **為什麼一台一條**:中繼每台同時最多 16 條串流(v5-hostd §7.1),長輪詢會一直佔一條。每個 exec、每個 proc 各一條的話,幾個插件加兩個 exec 就滿了。所以 Core 的 `SandboxClient` 對每個端點只開一條,所有工作的事件都在裡面。
- 服務保留最近 4096 個事件或 8 MiB,超過就丟最舊的;Core 給的游標比留著的還舊,或游標的 boot 不是這次的,回 `reset: true` 和新的游標。
- `stdout` / `stderr` 事件:每次 exec 最多送 `stream_bytes`(預設 256 KiB),之後只剩 `cpu` 和 `exit`。文字用串流式 UTF-8 解碼(和 `decodeOutput` 一樣不嚴格),所以字不會被切半。給結果用的頭幾 KiB 在 `exit` 的 `result` 裡,不靠事件。
- `proc_out`:原始位元組(base64),帶 `offset`(這個串流從頭算的位元組位置)。Core 發現 offset 跳了(事件丟了,或 reset)就用 `GET .../stdout?after=<自己收到的位置>` 補;服務每個 proc、每個串流留最後 4 MiB,比這更舊的回 410 `gone`(插件的連線就斷了,模組重啟,§13)。
- 每一頁也算一次所有「Core 拿過事件的工作」的續租(§13.1)。

### 3.6 執行

`PUT /v1/jobs/{job}/execs/{exec}` 本體 `ExecStart`,回 `202 ExecView`(`state: "running"`)。工作裡已經有一個 exec 在跑回 409 `conflict`(一次一個,和現在的工作階段一樣;等的由 Core 排,§9.3)。

服務做的和 `#execInSession` 一樣:寫 `/code/<exec>.<py|mjs|sh>`(`shell` 用 `bash /code/<exec>.sh`)、把 `files` 寫進 `/work`(`writeInputs` 的檢查)、記下 cgroup 的 CPU、`docker exec -i --user <程式 uid> --workdir <cwd>`、餵 stdin、開計時。結束、逾時、停掉、超過輸出:都以程式的 uid `kill -KILL -1`(`killAllArgs`),再讀一次 CPU,再收 `files_out`(`collectOutputs`),最後發 `exit` 事件。

`DELETE .../execs/{exec}?reason=aborted|quota` 停掉它,`killed_reason` 就是那個 reason。exec 自己的完整輸出寫在 `execs/<exec>.log`,`GET .../log` 支援 `range`,Core 拿來存成工作區的 `outputs/<run_id>.txt`(現在的 `renderRun` 做法,`format.ts`)。

### 3.7 背景程序(第三批、第四批用)

`PUT /v1/jobs/{job}/procs/{proc}` 本體 `ProcStart`:`docker exec -i --user <程式 uid>` 一個程序,不佔 exec 的位子,stdin / stdout / stderr 接到頻道。只在 `kind` 是 `browser` 或 `plugin` 的工作裡可以(§2.1)。

- 寫:`PUT .../stdin?offset=<n>`,本體是原始位元組(最多 1 MiB)。`offset` 是 Core 從頭算已經寫了多少。等於服務寫過的位置就接著寫;`offset + 長度` 不超過寫過的位置就當作重送,回 200 不重寫;跳過去了回 409。所以重送是安全的。
- 讀:事件的 `proc_out`,漏了用 `GET .../stdout?after=` 補(§3.5)。回原始位元組,標頭 `x-next-offset`、`x-proc-state: running|exited`、`x-exit-code`。
- 這條頻道是位元組管子,不懂裡面是什麼。插件用 `Content-Length` 框起來的 JSON-RPC(`packages/sdk/src/transport.ts` 的 `StreamTransport`),瀏覽器驅動也是,MCP 的 stdio 伺服器是一行一個 JSON。Core 那邊把它包成 Node 的 `Readable` / `Writable`,現有的程式碼不用知道它在別台(v6-agent-split.md 的 `ProcChannel`)。

### 3.8 錯誤

```ts
export type SandboxErrorCode =
  | "bad_request"     // 400 本體或參數不對
  | "unauthorized"    // 401
  | "not_accepting"   // 403 這台的主人不接這種工作(members / plugins)
  | "not_found"       // 404 沒有這個工作、exec、上傳、sync、proc
  | "conflict"        // 409 編號重用了不同的內容;已經有 exec 在跑;stdin 的 offset 跳了
  | "gone"            // 410 工作已經結束(附 ended);proc 的輸出已經丟了
  | "too_large"       // 413 本體、分段、合計、單檔超過上限
  | "limit"           // 422 工作的磁碟、出口流量用完
  | "busy"            // 429 這台現在沒有空位(附 retry_after_ms)
  | "docker_failed"   // 502 Docker CLI 自己失敗了(不是程式的錯)
  | "unavailable"     // 503 Docker 沒開、映像檔不在或正在建(附 reason)
  | "internal";       // 500

export interface SandboxErrorBody {
  error: { code: SandboxErrorCode; message: string; retry_after_ms?: number;
           ended?: { reason: SandboxEndReason; at: number }; reason?: string };
}
```

Core 對應到現有的 `SandboxErrorKind`(`types.ts`):`busy` → `busy`、`unavailable` → `unavailable`(映像檔的情況 → `image_unavailable`)、`gone` → `session_closed`(`SessionClosedError`)、`limit` → `limit`、`bad_request` / `too_large` → `invalid_request`、`docker_failed` → `docker_failed`;`not_accepting` 是新的 kind,她看到的是一句能轉告的話(§10.4)。

### 3.9 逾時

- 表 §3.2 的是每個請求的逾時(到回應標頭)。中繼本身的標頭逾時是 120 秒(§7.1),都在它以內。
- exec 的時間上限是 `timeout_ms`(服務計時)。Core 另外有一個保險:`timeout_ms + 60 s` 還沒收到 `exit` 就自己 `DELETE` 那個 exec、把結果當成 `lost`。
- 下載(`GET .../tar`、`.../log`)的內容沒有總逾時,60 秒沒資料就斷,`routedRequest` 會從斷點換路徑接著拿(需要 ETag、長度和 range,服務都給)。

## 4. 檔案怎麼進出

### 4.1 上限

| 項目 | 預設 | 在哪設 |
|---|---|---|
| 一次送進去的資料夾 | 1024 MiB | `[modules.sandbox.transfer] max_mb`(Core) |
| 每一段 | 8 MiB | `[modules.sandbox.transfer] part_mb` |
| 單檔 | 256 MiB | `[modules.sandbox.workspace] max_file_kb`、`[modules.sandbox] limits.max_file_size_bytes` |
| 項目數 | 一個人的 `person_max_files`(2000);她自己的 `max_files` | `[modules.sandbox.workspace]` |
| 一個人的資料夾 | 1024 MiB | `[modules.sandbox.workspace] person_max_mb`(從 256 調高) |

設計的對象是幾十 MB 的資料夾;1 GiB 是上限不是常態。八 MiB 一段的理由:每段都有長度、能重送(`PUT`),經過 tunnel(100 MB 上限)不會被排除,經過中繼時一段在 1 MiB 的視窗下約 8 個來回。上傳前比對清單,沒變的工作階段不用再送(§4.4)。

### 4.2 送進去

1. Core 走那個人的資料夾(她自己的就是整個工作區扣掉 `people/`,和 `hiddenInWorkspace` 同一個規則;owner 叫的就是整個工作區),只收一般檔案和資料夾,逐段 `lstat`,連結、裝置略過。每個檔算 SHA-256,做成清單 `ManifestEntry[]`。
2. 用 `tar-stream`(§15)打成 tar,gzip 等級 1(文字多,壓得很好;等級 1 幾乎不花 CPU)。tar 只寫路徑、大小、時間,不寫擁有者和權限(全部 0644 / 0755)。
3. 切成 `part_mb` 一段,每段 `PUT .../parts/{n}`,標頭 `x-sha256` 是這段的雜湊。服務收到就驗、寫到 `incoming/`。
4. `PUT .../uploads/{upload}`(`UploadCommit`):服務把各段接起來驗整個的 SHA-256,用 `tar-stream` 一個項目一個項目解:只收一般檔案和資料夾;路徑過 `normalizeRelativePath`(擋 `..`、絕對路徑、磁碟代號、反斜線、`:`、控制字元、Windows 保留名稱);深度最多 8 層;單檔、合計、項目數有上限;`O_EXCL` 寫;不照 tar 裡的權限。不收的寫在 `skipped`。
5. 解完刪掉 `incoming/<upload>/`。

`tools`(她留的腳本)和 `ext`(插件的資料夾)也是這樣送,`replace: true`,唯讀掛。

### 4.3 收回來

每次 exec 結束後(fresh 的就是那一次),Core:

1. `PUT .../syncs/{sync}`:服務走 `/workspace`(同樣只收一般檔案,`walkWork` 的規則),和上次的清單比(大小和時間不同才重算雜湊),新的、改的打成 tar 放在 `outgoing/`,回 `SyncResult`。
2. `GET .../syncs/{sync}/tar`,邊收邊驗雜湊。
3. 在 Core 這邊做的和現在 `#runFresh` 一樣:`before = snapshot()` → 把 tar 解進那個人的資料夾(同樣的解法和檢查,§4.2 第 4 步,共用 `tar-io.ts`)、刪掉 `deleted` 的 → `enforce(before)`(超過額度的、連結,只從這次改的裡面刪,`roomLeft` 照舊)→ `replaceFolder`。被刪的照舊放在結果的 `workspace_removed` 告訴她。
4. `DELETE .../syncs/{sync}`。清單更新成這次的。

### 4.4 兩邊都改了

一個工作階段開著的時候,她可能在 Core 這邊用 `workspace_write` 改了同一個人的檔案。規則:

- 每次 exec 開始前,Core 比對自己的資料夾和上次的清單;有變的(新增、改過、刪掉)先送進去(`replace: false` 的上傳,加刪除清單 `x-delete` 標頭的 JSON),所以容器裡看到的是最新的。
- exec 跑的時候 Core 這邊又改了同一個檔,收回來時以容器的為準,Core 那份改名成 `<檔名>.conflict-<時間>` 留著,結果裡寫一句「這幾個檔兩邊都改了,留下的是程式的版本,你改的在 …」。不做合併。

## 5. 出口代理

### 5.1 網路的樣子

```
          bridge(Docker 預設,NAT 到外面)
                   │
   miyoria-sbx-egress-<job>     代理:sandbox 映像檔裡的 node 跑 EGRESS_PROGRAM
                   │ alias egress-proxy
   miyoria-sbx-net-<job>        --internal:沒有往外的路由
                   │
   miyoria-sbx-<job>            工作的容器:只接這個網路
```

- 每個工作自己一個網路和一個代理(現在是整個實例共用一個,`egressNetworkName(instance)`)。理由:工作之間連不到彼此;每個工作的連線數和流量各算各的,不用在代理裡認人;工作關掉就一起拆,不會留下共用的狀態。代價是每個工作多一個小容器(記憶體上限 64 MiB、0.25 CPU)和約一秒的啟動,一台同時頂多幾個工作,划得來。
- 指令(`egressProxyArgs`、`networkCreateArgs`、`networkConnectArgs` 加上工作的編號):`docker network create --internal`、`docker run -d … --network bridge --read-only --tmpfs /tmp:size=1m --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges --ipc none --memory 64m --memory-swap 64m --cpus 0.25 --pids-limit 64 --init <image> node -e <EGRESS_PROGRAM>`、`docker network connect --alias egress-proxy`,然後 `egressReadyArgs` 等它在聽。
- `network.mode = "none"` 的工作(附件抽文字)用 `--network none`,沒有代理。

### 5.2 代理擋什麼

照順序:

1. 只收 `CONNECT host:port` 和絕對網址的 HTTP(現在的兩條路)。
2. **埠**:`open` 模式擋 `deny_ports`(預設 25、465、587),其他都放行;`allowlist` 模式照現在,只有 80、443。
3. **主機名稱**:`allowlist` 模式要在清單上(`hostOk`)。兩種模式都擋 `metadata`、`metadata.google.internal`、`instance-data` 這幾個名字和所有 `.internal`、`.local`、`.localhost` 結尾的。
4. **位址**:代理自己解析(`dns.lookup` 全部位址),任何一個在下面的範圍就拒絕;然後連它檢查過的那個位址,中間不會被換掉(現在的 `resolve` + `connectAny`)。
   - IPv4:`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`(tailnet、電信 NAT、阿里雲中繼資料 100.100.100.200)、`127.0.0.0/8`、`169.254.0.0/16`(連結本機、AWS / GCP / Azure 中繼資料 169.254.169.254)、`172.16.0.0/12`(含 Docker 的 bridge 閘道)、`192.0.0.0/24`、`192.0.2.0/24`、`192.168.0.0/16`(含 Docker Desktop 的主機位址 192.168.65.x)、`198.18.0.0/15`、`198.51.100.0/24`、`203.0.113.0/24`、`224.0.0.0/4`、`240.0.0.0/4`。
   - IPv6:`::`、`::1`、`::ffff:0:0/96`(看裡面的 IPv4)、`64:ff9b::/96`(NAT64,看裡面的 IPv4)、`100::/64`、`2001:db8::/32`、`fc00::/7`(含 Tailscale 的 `fd7a:115c:a1e0::/48`、AWS 的 `fd00:ec2::254`)、`fe80::/10`、`ff00::/8`。
   - 和 Core 的 `isBlockedAddress`(`packages/workspace/web/src/net.ts`)用同一張表:代理是 `node -e` 跑的一段程式,不能 import,所以測試拿同一組位址比對兩邊的答案。
5. **連線數**:同時開著超過 `max_connections`(預設 64)回 503,`CONNECT` 的通道也算。
6. **流量**:進出合計超過 `max_mb`(預設 4096 MiB)就斷掉所有連線,之後一律回 403「這個工作的網路流量用完了」。
7. 連線逾時 30 秒、閒置 5 分鐘斷(現在的 `setTimeout(300000)`)。

不做的:不解 TLS(看不到內容,只看得到主機和埠)、不限速度、不擋 UDP(本來就沒有路:工作只接 `--internal` 網路,連 DNS 都只能經過代理)。不照 `HTTP(S)_PROXY` 走的程式連不出去,這是要的。

代理每 2 秒把計數寫到自己的 `/tmp/egress.json`(`{bytes_in, bytes_out, open, total, refused:{address, port, cap}}`),服務在要用量和工作結束時用 `docker exec <代理> cat /tmp/egress.json` 讀。

### 5.3 擋得住、擋不住的

擋得住:連 Core 的 API、hostd 的本機 API、那台電腦的區網(路由器、NAS)、tailnet 上的其他電腦和它們的管理介面、雲端中繼資料、寄信。

擋不住、也不打算擋(owner「其他都放行」):從那台電腦的公開 IP 去掃描或打別人的公開服務、大量下載、經過代理的挖礦連線。限制它們的是連線數、流量、每人的 CPU 額度(§8)和每個工作的 `--cpus`;濫用投訴會寄到那台電腦主人的網路業者,這是那台的主人開 `members = true` 時接受的。

## 6. 映像檔

### 6.1 內容

`workers/sandbox/image/Dockerfile`:

```dockerfile
# The image every sandbox job runs in (docs/design/v6-sandbox.md §6). Built on the machine that
# runs the sandbox service: `miyoria sandbox build`. Pin the three bases by digest when this is
# changed (`docker buildx imagetools inspect <image>`), and the Python packages in requirements.txt.
# syntax=docker/dockerfile:1.7
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NODE_IMAGE=node:24-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.8

FROM ${NODE_IMAGE} AS node
FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git jq less file \
      unzip zip xz-utils bzip2 p7zip-full \
      ffmpeg imagemagick poppler-utils ghostscript sqlite3 \
      build-essential pkg-config \
      fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY requirements.txt /opt/miyoria/requirements.txt
RUN pip install --no-cache-dir -r /opt/miyoria/requirements.txt
RUN mkdir -p /home/sandbox /work /workspace /code /tools /ext && chmod 0777 /home/sandbox
LABEL org.opencontainers.image.title="miyoria-sandbox" miyoria.sandbox.image="default" miyoria.sandbox.contract="1"
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

`workers/sandbox/image/requirements.txt`(版本用 `uv pip compile` 釘住):numpy、pandas、scipy、scikit-learn、matplotlib、pillow、openpyxl、xlsxwriter、python-docx、python-pptx、pypdf、pdfplumber、beautifulsoup4、lxml、requests、httpx、pyyaml、jinja2、markdown、tabulate、sympy、rich。

- Node 從官方 node 映像檔複製(不跑 nodesource 的 `curl | bash`),uv 用官方文件寫的 `COPY --from`。
- apt 的系統套件在映像檔裡就有;工作裡不能 `apt-get`(非 root),`pip`、`npm`、`uv` 裝到 `/home/sandbox`,跟著工作留到它關掉。她的工具說明要寫清楚(§10.2)。
- 代理也用這個映像檔(有 node),所以一台電腦只要一個映像檔;瀏覽器的另外一個(第三批,`workers/sandbox/image/browser/`,基於 Playwright 官方映像檔,見分工文件)。
- 大小約 2 GB,第一次建要下載差不多這麼多。

### 6.2 標籤

`miyoria/sandbox:1-<hash>`、`miyoria/sandbox-browser:1-<hash>`。

- `1` 是「映像檔契約」的版本:服務對映像檔的要求(`/home/sandbox`、`/ext`、有 node 給代理、有 `bash`、`cat`、`sleep`)。契約變了才變。
- `<hash>`:映像檔資料夾裡每個檔案(相對路徑排序後,路徑和內容)的 SHA-256 前 12 個十六進位字。Dockerfile 或 requirements 一改,標籤就變。
- 建好後加標籤 `miyoria.sandbox.hash=<hash>`,寫進 `<state>/sandbox/images.json`。

### 6.3 怎麼建、沒有的時候

- `miyoria sandbox build [--yes]`(在那台電腦上):列出要做的事和大約的下載量,問一次(和 v5-hostd §9.1 下載模型的規則一樣;`--yes` 同意;沒有終端機又沒有 `--yes` 就印出指令,不做)。執行 `docker build --pull --tag <tag> --label … <image 資料夾>`,經 `ProcessDockerRunner`(不經 shell、過濾過的環境),最久 30 分鐘,輸出寫進服務的日誌。成功後刪掉同契約更舊的標籤,留前一個。
- `miyoria add sandbox` 加完服務後問要不要現在建;`miyoria doctor` 檢查 Docker 在不在、映像檔建了沒、是不是最新的,`--fix` 會問要不要建。
- **服務自己不建**:建要下載約 2 GB,只在那台的主人說好的時候做。
- **Dockerfile 改了、新的還沒建**(例如遠端更新拉到新的 Dockerfile):服務用同契約、最新的那個舊標籤,`stale: true`,照樣準備好,面板寫「沙箱映像檔不是最新的」。遠端更新本來就不下載東西(v5-hostd §14),這樣朋友的電腦不會因為 owner 改了 Dockerfile 就停擺。
- **完全沒有**:`ready: false`,原因「沙箱映像檔還沒建好:在這台執行 miyoria sandbox build」。

## 7. CPU 秒數

- **讀法**:`docker exec --user <keeper uid> <容器> cat /sys/fs/cgroup/cpu.stat`,取 `usage_usec`(cgroup v2,`--cgroupns private` 下這是容器自己的 cgroup)。cgroup v1 的機器讀 `/sys/fs/cgroup/cpuacct/cpuacct.usage`(奈秒)。容器裡的 `/sys` 是 Docker 唯讀掛的,程式改不了。
- **什麼時候讀**:exec 開始前、exec 跑的時候每 10 秒、exec 結束殺完程序之後;proc 的工作每 10 秒。累計值,所以漏讀一次不會少算,只是晚一點才算到。
- **兩種都讀不到**(很少見):每 10 秒 `docker stats --no-stream --format "{{json .}}"` 抽一次 `CPUPerc`,乘以間隔加總,`cpu_source: "sampled"`。
- **回報**:`cpu` 事件(工作的累計)、`ExecResult.cpu_ms`(這次 exec 的差)、`JobUsage.cpu_ms`。代理容器的 CPU 不算(它上限 0.25 CPU,跟著工作的流量走)。
- **分數**:`EndpointRegistry.reserve(endpoint).done({ run_ms })` 的 `run_ms` 用 exec 的 `duration_ms`,讓 §15.4 的估計學到每台的速度。

## 8. 工作額度

### 8.1 記在哪、什麼單位

- **重用 `quota_spend`**(`packages/brain/selfhost/src/quota-schema.ts`):不加表、不加欄位。工作額度的列,`person` 欄是 `~cpu:<人的鍵>`(人的鍵和 AI 額度同一個:`personKey`,`packages/brain/selfhost/src/quota.ts`),`micros` 欄存的是 CPU 微秒。`person` 是自由文字、沒有外鍵;`~` 不會出現在 person id 或 `platform:id` 裡,所以不會撞到。
- **重用 `PersonQuota`**(`packages/brain/self/src/quota.ts`):另外建一個實例,規則是 `{ usdPerHour: cpu_seconds_per_hour, usdPerDay: cpu_seconds_per_day, unpricedUsdPerMtok: 0 }`,`add(person, now, cpuSeconds)`,裡面乘一百萬存成整數,剛好就是 CPU 微秒。滾動一小時、她的當地日、「一段時間只說一次」(`capped`、`claimNotice`)全部照舊。
- 它的 `QuotaBook` 是一層包裝:讀寫時在人的鍵前面加 `~cpu:`;`dayTotals` 只回有這個前綴的、拿掉前綴。AI 額度那邊的 `QuotaStore.dayTotals`(`quota-store.ts`)要改成不回 `~` 開頭的列,管理頁才不會把 CPU 當美元。`prune` 兩邊共用,本來就按 slot 和 key 清,不用改。
- 對外的介面是 `@miyoria/types` 的 `WorkQuota`(`WorkQuotaKey`,文字執行的 host 提供,和 `PersonQuotaKey` 同一個地方,`packages/brain/selfhost/src/host.ts`)。形狀在分工文件。

### 8.2 設定

`[modules.agent.quota]`(`packages/brain/agent/src/config.ts` 的 `QuotaConfigSchema`)多兩個鍵:

```toml
# person_cpu_seconds_per_hour = 7200   # 每人最近一小時的沙箱 CPU 秒數(兩顆 CPU 滿載一小時);0 = 不設
# person_cpu_seconds_per_day = 28800   # 每人她的一天(八個 CPU 小時)
```

預設很高,和 AI 額度一樣先看實際用量再調。

### 8.3 算誰的、在哪裡算

- 付錢的人:發起這次呼叫的人(`ExecContext.principal.requester`),和 AI 額度同一套:有人要的就是那個人,owner 記帳不受限(`exempt`),她自己的(沒有 requester)不算任何人。替人做的小幫手工作照第一批的規則算那個人。
- 在 Core 算,不在那台電腦算:Core 的 `RemoteSandbox` 收到 `cpu` 事件和 `exit` 時,把這個工作上次算到現在的差加給付錢的人(工作階段一次只跑一個人的 exec,工作階段本來就分人,`sessionView`)。
- **開始前**:付錢的人已經到上限,不開工作、不開 exec,工具回固定的一句,不叫模型:「你這個小時找我跑的程式有點多,大概 N 分鐘後再來。」/「你今天找我跑的程式有點多了,大概 N 個小時後再來。」(和 AI 額度的說法、`capMinutes` 同一套)。
- **跑到一半**:`cpu` 事件之後發現到了上限,Core `DELETE` 那個 exec(`reason=quota`),結果的 `killed_reason` 是 `quota`,她拿到「跑到一半停了:那個人這段時間的沙箱時間用完了」。這就是「CPU 長時間滿載超過工作額度就停」。
- 瀏覽器和插件的工作:瀏覽器算開它的那個人;插件的工作記在 `~cpu:plugin:<id>`,只記帳不設限(owner 裝的)。
- **看得到**:`GET /api/llm/quota` 每個人多一欄 `work`(這小時、今天的 CPU 秒和上限),`GET /api/member/me` 的 `quota` 多一欄 `work`。

## 9. Core 這邊

### 9.1 選哪個後端

`[modules.sandbox] backend`:

| 值 | 意思 |
|---|---|
| `auto`(預設) | 叢集模組在跑(有 `EndpointsOption` 給的 registry)就用叢集的 `sandbox` 服務;沒有就用這台的 Docker,和今天一樣 |
| `cluster` | 只用叢集 |
| `local` | 只用這台的 Docker(今天的 `DockerSandbox`,照舊的參數和暖池;沒有 shell 和瀏覽器) |

`SandboxModule` 多收一個 `endpoints`(和 `ImageGenModule` 一樣,`packages/core/src/modules.ts`)。叢集後端是 `RemoteSandbox implements Sandbox`(`packages/workspace/sandbox/src/remote/`),所以 `SandboxGate`、`ProposedTools`、`SandboxFileReader`(`files.ts`)、`workspace_run` 都不用知道沙箱在哪。舊的 `miyoria.toml` 照樣開得起來:沒寫 `backend` 就是 `auto`。

### 9.2 挑一台

1. `candidates("sandbox")`(已經照分數排,不接新工作的不在裡面,§15.3)。
2. 每個端點的 `GET /v1/info` 存 60 秒(`watch("sandbox")` 一變就清)。留下 `ready`、需要的映像檔在、`policy` 接這種 `for` 的、`policy.max_job_*` 和 `load` 看起來放得下的。
3. 照順序 `reserve(endpoint)` 再 `PUT /v1/jobs/{job}`;`busy`、`unavailable`、`not_accepting`、沒送出去(`neverSent`)就 `done({ ok: false })` 換下一台;都不行就回她一句原因(§10.4)。成功 `accepted()`,工作結束 `done({ run_ms })`。
4. 一個工作開了就留在那台,不換台:要換台得把檔案和裝的套件全部搬過去,不如重開。那台不見了,工作就是 `lost`。

### 9.3 工作階段

- Core 記著每個開著的工作:`sandbox` store 外掛的第 1 個 migration,只新增一張表:

```sql
CREATE TABLE `sandbox_jobs` (
	`id` text PRIMARY KEY,
	`host` text NOT NULL,
	`service` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`folder` text,
	`payer` text,
	`for` text NOT NULL,
	`state` text NOT NULL,
	`ended_reason` text,
	`manifest` text,
	`cpu_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "sandbox_jobs_kind_check" CHECK("kind" IN ('run','session','browser','plugin')),
	CONSTRAINT "sandbox_jobs_state_check" CHECK("state" IN ('open','ended'))
) STRICT;

CREATE INDEX `sandbox_jobs_open_idx` ON `sandbox_jobs` (`state`) WHERE "sandbox_jobs"."state" = 'open';
```

  `manifest` 是上次 sync 的清單(JSON;兩千個檔約 200 KB)。照 store 的慣例由 Drizzle 的表產生、加 `STRICT`、之後不再改。
- 工作階段的名字、分人、「被關掉只說一次」(`#tombstones`)、`listSessions`、`closeSession` 的行為不變,只是資料在這張表和遠端。`sessions.max` 改成全部人加起來(預設 8),另加 `sessions.per_person`(預設 2):現在的 3 是給她一個人的。
- 同一個工作階段的 exec 在 Core 排隊(一個 `Semaphore`),服務那邊永遠只看到一個。
- `shell_run` 不寫名字時用那個人的工作階段 `main`(她自己的叫 `main`,替人做的照 `sessionView` 加上那個人的標記),所以裝過的套件、`cd` 以外的狀態(檔案)留到工作階段關掉。

### 9.4 沒有電腦可以用的時候

- `RemoteSandbox.health()`:有任何一台 `ready` 就是 `available`;沒有的話 `error` 是每台的原因接起來(「main-pc:沒開沙箱;friend-pc:沙箱映像檔還沒建好」)。`SandboxGate.setAvailable` 照今天的方式撤掉或加回工具,`recheck_ms` 之外也在 `watch("sandbox")` 一變就重算。
- 撤掉的工具和今天一樣:`code_run`、`code_session`、`shell_run`、`workspace_run`、`workspace_save_script`、`tool_propose`、她寫的 `sbx_<name>`;附件抽文字(`FileReaderKey`)回 `sandbox` 的拒絕代碼。原因寫在模組健康、`/admin autonomy status`(`statusLines`)和小幫手的說明裡。
- 有電腦但都不接成員的工作:工具不撤(owner 和她自己還能用),成員要的時候回一句能轉告的話(§10.4)。

## 10. 閘門與工具

### 10.1 風險等級

| 能力 | 工具 | 現在 | 之後 |
|---|---|---|---|
| `code.run` | `code_run` | 高,每次審查 | **中**、`work`、`followup` |
| `shell.run` | `shell_run` | 沒有 | **中**、`work`、`followup` |
| `code.session` | `code_session` | 低 | 低 |
| `workspace.run` | `workspace_run` | 中 | 中 |
| `workspace.save_script` | `workspace_save_script` | 高 | 高(之後沒人看著就會跑) |
| `tool.propose` | `tool_propose` | 高 | 高(同上) |
| `sbx.<name>` | `sbx_<name>` | 中 | 中 |

- 中風險不審查,照 `[modules.actions.work]` 的次數(`WorkLimitSchema`:沒有冷卻、每人每小時 300 次)。擋傷害的是沙箱本身、網路代理和每人的額度。
- **`followup` 也給中風險用**:`CapabilityTools.#run`(`packages/gate/actions/src/tools.ts`)改成 `risk === "high"` 或 `tool.followup` 為真時都 `invoke(..., { activity: "detach" })` 再走 `#waitOrFollowUp`:在 `inline_wait_ms` 內做完就直接回,否則先回「還沒有結果」,做完用後續回合告訴她(`notifyLate`)。中風險的 `followup` 工具不經審查,只是不佔著她的回合等十分鐘。`CapabilityTool.followup` 的說明改成「高風險或中風險」。
- `CODE_RUN_GUIDANCE` 不再給 `code_run` 用(沒有審查了),留給 `workspace_save_script`(`workspace-gate.ts`)。
- 誰能叫:不變。`sandbox.code.run` 是做事的節點(`WORK_NODES`),羈絆到 `work_min_bond` 就有(`permit`,`work.ts`)。`shell.run` 用同一個節點。

### 10.2 工具

`shell_run`(新):

- 參數:`command`(一段 bash,最多 256 KiB)、`timeout_ms`(可省)、`session`(可省,預設 `main`)、`stdin`(可省)。
- 在那個人的工作階段裡,工作目錄 `/workspace`(那個人的資料夾,或她的工作區),`bash /code/<exec>.sh`。
- 說明(zh-TW,要點):這是一台 Linux 機器;有 Python、Node、git、ffmpeg、常見的資料處理套件;能上網(經過代理,連不到內網);`pip install`、`npm install` 會裝在這個工作階段裡,關掉就沒了,系統套件(apt)不能裝;`/workspace` 是你(或這個人)的檔案,會留下來;`/work` 是暫存;單次最長 10 分鐘;工作階段閒置 15 分鐘或開了 2 小時自己關。
- `meta: { effect: "external", speed: "long", group: "code", core: true }`。

`code_run`:參數不變(舊的呼叫照樣能用)。說明拿掉「沒有網路、只能用標準函式庫」,改成和 `shell_run` 一樣的環境;`use_network` 留著但沒有作用(網路照 `[modules.sandbox.network] mode`,預設開著);`use_workspace` 在工作階段也可以用了(檔案會送進送出)。

結果文字照 `renderRun`(`format.ts`),多兩種被停的原因:`quota`、`disk`;開頭多一句在哪台跑(「在 friend-pc 的沙箱」),讓她知道慢是因為別台。

### 10.3 誰的資料夾

和第一批一樣(`scopeFor`):成員只送他自己的 `people/<資料夾>/`;她自己的送整個工作區扣掉 `people/`;owner 和面板送整個工作區。送不出去的(超過 `transfer.max_mb`)回一句:「這個資料夾太大了(N MB),一次最多送 M MB 進沙箱;先刪掉用不到的,或只把要用的檔案放到一個子資料夾。」

### 10.4 她看到的原因

全部是可以轉告的話,`data.error` 是代碼:

| 代碼 | 她看到的 |
|---|---|
| `no_machine` | 現在沒有能跑程式的電腦(每台的原因)。 |
| `not_accepting` | 能跑程式的電腦現在都不接成員的工作,那幾台的主人沒開;這次沒有跑。 |
| `busy` | 能跑程式的電腦現在都滿了,稍後再試。 |
| `quota` | §8.3 的那一句。 |
| `too_large` | §10.3 的那一句。 |
| `lost` | 那台電腦斷線了,工作階段和裡面的檔案不見了(`/workspace` 的改動收到上一次執行為止)。 |

## 11. 附件進去、結果出來

### 11.1 附件

新的中風險 `work` 工具 `workspace_attach`(能力 `workspace.attach`,節點 `sandbox.workspace`;中風險是因為它寫進工作區,和 `workspace_write` 一樣):把觸發這次的訊息(或同一個人最近的訊息)附的檔案存到那個人的資料夾 `inbox/<檔名>`,之後的 `shell_run` 在 `/workspace/inbox/` 看得到。

- 下載照 `SandboxFileReader` 的規則(`files.ts` 的 `allowedHost`:只從平台的 CDN、HTTPS、量著下載),單檔上限是 `[modules.sandbox.workspace] max_file_kb`(256 MiB)和那個人的額度。
- 附件從哪來:selfhost 已經把每次執行的輸入檔案挑出來(`around.ts` 的 `#files`、`selectFiles`);多一個 `MessageFilesKey` 服務,記著最近的訊息附了哪些檔(`FileRequest`,`packages/types/src/files.ts`),工具用 `ExecContext.request.message` 查。
- 圖片也可以存(她要拿圖去處理時);存的是原始檔,分享出去時照舊清掉資料(`ArtifactCleanerKey`)。

### 11.2 `share` 放寬

`share`(`packages/gate/actions/src/share.ts`)的規則 6、9 改:

- **壓縮檔和 Office 檔不再只限「做給的那個人」**(`checkContent` 的 `owner` 參數):`share` 本來就只傳給開口的人(規則 2),她自己做的(`made_for` 是 null)也可以給。zip 照舊整個讀過、檢查跑出資料夾的路徑、連結、解開後的大小、每個文字項目過密鑰檢查(`inspectZip`)。
- **多收**:OpenDocument(odt、ods、odp,是 zip,`ZIP_MIMES` 加上它們的型別)、epub(zip)、tar、tar.gz / tgz、gz(單一檔案)。tar 用 `tar-stream` 照 zip 的規則檢查(新的 `tar.ts`,和 `zip.ts` 同一組上限 `zip_max_entries`、`zip_max_unpacked_mb`)。7z、rar 讀不了內容,照舊拒絕,原因寫「這種壓縮檔我沒辦法先檢查裡面,改用 zip」。
- **網頁**:HTML 本來就能當附件(私訊以外加 `.txt`);要在瀏覽器裡打開的用 `page_publish`(第一批)。不變。
- **大小**:`[modules.actions.share] max_bytes` 的預設改成 0 = 只看平台的上限(`PlatformSink.attachmentLimit`,`packages/types/src/platform.ts`)。超過的照舊只給連結(要有 `[modules.api.files] origin`),沒有檔案網域就照第一批的「結果說實話」回原因。
- `workspace_export` 收的型別(`workspace-export.ts`)跟著放寬成同一張表,單檔上限 `export_max_kb` 預設 262144(256 MiB)。
- 舊的設定:寫死 `max_bytes = 10485760` 的照舊。

## 12. 設定

### 12.1 `host.toml`

```toml
[services.sandbox]
enabled = true
# accept = false          # 跑著但不接任何工作(v5-hostd §15.6)
# concurrency = 2         # 同時最多幾個工作,低於描述檔的 4

[sandbox]                 # 這台的主人決定;Core 改不了
# members = false         # 接成員要的工作。預設不接:owner 和她自己的照接
# plugins = false         # 讓插件的程序在這台跑(第四批)
# cpus = 4                # 所有工作加起來最多幾顆 CPU;預設這台的一半(至少 1)
# memory_mb = 8192        # 所有工作加起來的記憶體;預設這台的一半,最多 16384
# disk_mb = 20480         # 所有工作的資料夾加起來
# max_job_cpus = 2        # 一個工作最多;預設等於 cpus
# max_job_memory_mb = 4096
# runtime = "runsc"       # Docker 的 --runtime(裝了 gVisor 的 Linux 才寫)
```

- `HostConfigSchema`(`packages/contracts/host/src/host-config.ts`)多一個可省略的 `sandbox` 物件,strict。整張表可以不寫:不寫就是上面註解的預設。
- 跟 `accept`、`concurrency` 一樣(v5-hostd §15.8),比較舊的 hostd 讀到 `[sandbox]` 會拒絕整個檔案:先更新那台再寫。沒寫這張表的機器沒有任何差別。考慮過另開 `sandbox.toml`(像 `routes.toml`),沒選:這幾個鍵只對有 `sandbox` 服務的新 hostd 有意義,一台電腦的主人只要看一個檔。
- 服務自己讀這張表(`SANDBOX_HOST_TOML`,用 `@miyoria/hostd` 的 `parseHostConfig`),每 60 秒重讀,改了不用重啟;規則變嚴(例如 `members` 改成 false),開著的成員工作在下一次 exec 前關掉(`host_policy`)。
- `miyoria add sandbox` 寫 `[services.sandbox] enabled = true`,檔尾加上 `[sandbox]` 的註解(`packages/cli/src/host-toml.ts`,和 `UPDATE_HINT` 同樣做法)。

### 12.2 `miyoria.toml`

全部有預設,寫出來的是改過的:

```toml
[modules.sandbox]
# enabled = true
# backend = "auto"                 # auto | cluster | local(§9.1)
# default_timeout_ms = 300000      # 原本 30000
# max_timeout_ms = 600000          # 原本 120000:單次 10 分鐘
# limits = { memory_mb = 2048, cpus = 2, pids_limit = 512, tmpfs_mb = 512, max_file_size_bytes = 268435456, nofile = 4096 }
#                                  # 原本 256 MiB、1 CPU、128、64 MiB、16 MiB、256
# sessions = { max = 8, per_person = 2, idle_minutes = 15, lifetime_minutes = 120, disk_mb = 2048 }
#                                  # max 原本 3(只有她一個人用);disk_mb 原本 256
# [modules.sandbox.transfer]
# max_mb = 1024                    # 一次送進沙箱的資料夾
# part_mb = 8                      # 每一段
# lease_secs = 600                 # Core 這麼久沒來,那台就關掉工作(§13.1)
# trusted_hosts = []               # 有密鑰的插件只在這幾台跑;空 = 只有 Core 自己那台(§16 第 3 題)
# [modules.sandbox.network]
# mode = "open"                    # open | allowlist | none。舊設定 allow 有寫主機、沒寫 mode 的當作 allowlist
# allow = []
# deny_ports = [25, 465, 587]
# max_connections = 64             # 每個工作同時開著的連線
# max_mb = 4096                    # 每個工作進出合計
# [modules.sandbox.workspace]
# max_file_kb = 262144             # 原本 8192
# person_max_mb = 1024             # 原本 256
# export_max_kb = 262144           # 原本 8192

[modules.agent.quota]
# person_cpu_seconds_per_hour = 7200
# person_cpu_seconds_per_day = 28800

[modules.actions.share]
# max_bytes = 0                    # 原本 10485760;0 = 只看平台的上限
```

- 預設值改了的鍵,舊設定裡明寫的值照舊(例如寫死 `max_timeout_ms = 120000` 的還是兩分鐘)。沒有拿掉的鍵,不用加進 `removed-config.ts`。
- `images`、`pool_size`、`user`、`docker` 只對 `backend = "local"` 有用;叢集後端由那台電腦決定映像檔和 uid。
- `network.mode` 的「舊設定當 allowlist」寫在 `SandboxConfigSchema` 讀完之後(module 的 `start`),不用 zod 的 transform。

## 13. 壽命和當掉之後

### 13.1 租約、閒置、最長

- 每個工作有三個時間:`lease_s`(預設 600)、`idle_s`(工作階段 15 分鐘)、`lifetime_s`(2 小時;插件 0 = 沒有)。服務每 15 秒掃一次,到了就關(正在跑的 exec 不會被閒置關掉,和現在的 `#expiry` 一樣)。
- 續租:任何碰到那個工作的請求、事件長輪詢的每一頁(Core 拿過事件的工作)、Core 每 60 秒對開著的工作 `PUT .../lease`。
- 600 秒的理由:Core 重啟(連登入 Discord 和載入模型)通常一兩分鐘,這段時間工作階段不會被關。

### 13.2 Core 當掉或重啟

- 開機時讀 `sandbox_jobs` 裡 `open` 的列,對記著的那台 `GET /v1/jobs/{id}`:還在就接回來(工作階段照用,清單在 `manifest` 欄);不在(404、410、那台沒連上超過租約)就標成 `ended`、`lost`,她下次用那個名字時被告知一次。
- 跑到一半的 exec:Core 重啟後 `GET .../execs/{exec}` 拿結果(結束了就照常收檔、記額度,結果當成遲到的通知給她;第一批的「重啟後接續」讓工作接著跑);還在跑就接著等事件。
- 插件的工作:插件模組重啟時開新的,舊的直接 `DELETE`。
- 留在服務那邊、Core 不再要的:租約到了自己關。

### 13.3 服務或 hostd 重啟

- 服務重啟(當掉後 hostd 照策略重啟、遠端更新重啟它、`miyoria restart sandbox`):開機時讀每個 `jobs/<id>/job.json`,`docker ps --filter label=miyoria.sandbox.job=<id>` 還在跑、租約沒到的就接回來:先以程式的 uid `kill -KILL -1`(重啟前在跑的 exec 的 CLI 已經死了,容器裡的程序不一定),那個 exec 標成 `lost`;proc 也算斷了(插件模組會重啟)。其他的容器、網路、代理、資料夾都拆掉(現在的 `reap`、`prune` 用標籤找的做法,範圍換成這個服務的 instance)。
- 事件游標帶著 boot id,Core 看到 `reset` 就重新對帳。
- Docker 或那台電腦重開:容器都不在了,工作全部 `lost`,資料夾在下次啟動清掉。
- 遠端更新:健康回答的 `busy` 讓 wait 步驟等正在跑的程式(§1.3);閒置的工作階段照上面接回來。

## 14. 測試

- **單元**(`FakeRunner`,`packages/workspace/sandbox/test/fake-runner.ts` 的做法):容器參數、uid、租約和閒置、預留資源、`host_policy`、cgroup 解析、事件環形緩衝和 reset、stdin 的 offset 規則、上傳分段和雜湊、tar 解開的每一種拒絕(`..`、絕對路徑、連結、裝置、太深、太大、項目太多、大小寫重複)、sync 的差異和衝突規則。
- **HTTP**:真的 `node:http` 伺服器加假的 Docker:token、每個錯誤碼、`PUT` 重送拿到同樣的結果、同編號不同內容 409、經過 `routedRequest` 換路徑重送不會重複執行。
- **Core**:`RemoteSandbox` 對假的服務(測試裡的 HTTP 伺服器,經 `EndpointRegistry` 加 static 端點):挑台和換台、額度在開始前和跑到一半擋下、sync 套回之後 `enforce` 刪掉超額的、重啟後接回、沒有電腦時工具撤掉。
- **代理**:`egress.test.ts` 的做法(真的子程序在 loopback 上),加 `open` 模式、擋埠、連線數、流量、和 `isBlockedAddress` 同一張位址表。
- **真的 Docker**(`describe.skipIf(!dockerAvailable())`,和 `docker.integration.test.ts` 同一個判斷;CI 的 ubuntu 有 Docker 會跑,本機沒 Docker 跳過):開工作、exec、讀到 CPU、`kill -1` 之後背景程序不在、送進送出一個幾 MB 的資料夾、代理擋 `172.17.0.1` 和 `169.254.169.254` 而放行一個公開網站、超過流量被斷、租約到了容器被拆、服務重啟後接回。用 `python:3.12-slim` 當工作的映像檔、`node:24-slim` 當代理的映像檔(測試設定),不用先建 2 GB 的映像檔。
- **映像檔**:CI 多一個 job 用 buildx 建 `workers/sandbox/image`(不推),像現在的 `docker-core`;`MIYORIA_SANDBOX_IMAGE_TESTS=1` 時拿建好的映像檔跑一次上面的真 Docker 測試。

## 15. 考慮過的套件

| 要做的 | 考慮的 | 選的和理由 |
|---|---|---|
| 和 Docker 說話 | `dockerode`(Engine API:stats、archive、attach 都有) | **照舊用 Docker CLI**(`ProcessDockerRunner`):已經測過的參數檢查和環境過濾(`dockerCliEnv`)、Windows 的 named pipe 不用另外處理;CPU 用 `docker exec cat` 讀 cgroup,不需要 stats API |
| tar | `tar`(node-tar)、`tar-stream`、`tar-fs` | **`tar-stream`**:只做格式,檔案系統的部分用我們自己已經有的路徑檢查(`normalizeRelativePath`、`lstat`、`O_EXCL`)。node-tar 自己決定怎麼寫檔、以前有過連結和路徑的漏洞,用它還是得自己再擋一次 |
| 出口代理 | Squid(`dst` ACL 會解析後比對位址)、Stripe 的 Smokescreen(專門擋 SSRF 的出口代理)、tinyproxy、npm 的 `proxy` | **擴充現有的 `EGRESS_PROGRAM`**:已經做到「自己解析、連檢查過的位址」,有測試;每個工作的流量上限在 Squid 和 tinyproxy 都不是現成的功能,Smokescreen 要另一個映像檔和 Go 的建置。八十行的程式加上埠、連線數、流量比換一套好 |
| 磁碟上限 | `--storage-opt size=`、資料夾放有配額的磁碟 | **每 5 秒量一次,超過就停**:`--storage-opt` 只在 overlay2 加 xfs pquota 時有用,Docker Desktop 沒有;bind mount 沒有配額。和現在的事後檢查同一個思路,只是在執行中也量 |
| 輸出串流 | WebSocket、HTTP 回應串流、長輪詢 | **長輪詢**:中繼不轉 WebSocket(§7.1);串流回應換路徑時接不回來;長輪詢的每一次都是 `GET`,換路徑可以重送,一台一條不會用完中繼的串流 |
| 瀏覽器 | Playwright 官方映像檔、自己裝 Chromium | **官方映像檔**(第三批):版本和瀏覽器配好,不用自己追 Chromium 的相依套件 |
| 更強的隔離 | gVisor(`runsc`)、Kata、每個工作一台 VM | **可選的 `[sandbox] runtime`**:裝了 gVisor 的 Linux 主人可以開;Docker Desktop 沒有,不當預設 |

新加的相依只有 `tar-stream`(和它的型別)。

## 16. 要 owner 決定的

1. **映像檔從哪來**。預設:每台電腦自己建(`miyoria sandbox build`,約 2 GB 下載,主人說好才建)。另一個做法:CI 建好推到一個 registry(例如 GitHub 的 ghcr.io),各台用 `docker pull`,更快、每台一樣、Dockerfile 改了遠端更新後也能拉新的;要 owner 的 registry 帳號和 CI 的推送權限。
2. **成員的檔案會暫時放在接工作的那台電腦上**。那台的主人看得到工作資料夾裡的東西(成員的 `people/<資料夾>/`、瀏覽器的登入狀態),直到工作關掉。預設:只送到主人自己寫了 `members = true`、而且 owner 核准了 `sandbox` 的電腦;不另外告訴成員。另一個做法:成員的工作只送到 `[modules.sandbox] member_hosts` 列的電腦(例如只有 owner 自己的)。
3. **插件的密鑰和放在哪跑**(第四批,先寫在這裡因為它決定 `plugins` 這個鍵):插件放進沙箱後,它需要的 API 金鑰也會送到那台電腦的容器裡。預設:插件在 `[extensions."<id>"] secrets = [...]` 列出、owner 在設定裡同意的才給,而且有密鑰的插件只在 Core 自己那台(或 `[modules.sandbox] trusted_hosts` 列的)跑;遊戲轉接器(`kind = "game-adapter"`)和要 `input` 權限的照舊在主機上跑,因為它們要碰到那台的遊戲。

## 17. 不做的、留給之後的

- 沒有沙箱的 shell(v6-agent.md「不做的」)。
- 工作換台(把開著的工作階段搬到別台)。
- 服務那台的磁碟配額(只能量)。
- 代理看 TLS 的內容、限速。
- k8s 或其他後端:`Sandbox` 介面和 `RemoteSandbox` 留著,哪天有固定的 Linux 伺服器,加一個後端或一台跑這個服務的機器就好。
- 第一批的 `[modules.sandbox.files] per_person` / `global`(backlog 記著還沒收的上限)不在這批動。
