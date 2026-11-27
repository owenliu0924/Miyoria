# @miyoria/workspace/sandbox

模組 `sandbox`:讓 DeepSeek-chan 在**不能連外的 Docker 容器**裡執行她自己寫的程式(Python / Node):預設每次一個用完即丟的新容器,要分好幾步做的事可以開一個有名字的**工作階段**(session,`/work` 會留給同名的下一次執行)。另外保存她寫的腳本(工具工作區),以及管理她提出的自寫工具(`tool.propose`)。設計見 [`docs/design/autonomy.md`](../../../docs/design/autonomy.md) §7、§8.3(階段 F)。

> 這個模組是 **opt-in**:`[modules.sandbox]` 要寫 `enabled = true` 才會啟動(沒有這一節 = 關閉)。啟動後只要沙箱可用,就在自主層的閘門(`ActuatorRegistryKey`)註冊 `code.run`、`code.session`、`tool.propose` 與她已核准的工具(叢集後端另有 `shell.run`),反應回合(和之後她自己的回合)都能用,見「閘門與工具」。

## 兩種後端(`[modules.sandbox] backend`)

設計見 [`docs/design/v6-sandbox.md`](../../../docs/design/v6-sandbox.md) §9。`SandboxGate`、`ProposedTools`、`SandboxFileReader`、`workspace_run` 只看 `Sandbox` 介面,不知道程式在哪裡跑。

| 值 | 程式在哪跑 |
|---|---|
| `auto`(預設) | 叢集裡有一台 `sandbox` 服務準備好了就送過去,沒有就用這台的 Docker(和以前一樣)。工作階段留在開它的那一邊。叢集的電腦不接(不接成員、滿了、沒準備好)而這台的 Docker 可用時,fresh 的 Python / Node 改在這台跑 |
| `cluster` | 只用叢集的電腦(`src/remote/`) |
| `local` | 只用這台的 Docker(`DockerSandbox`,下面「一次執行的流程」以下講的都是它),沒有 shell |

**叢集後端**(`src/remote/`):

- `HttpSandboxClient`(`client.ts`,也以 `SandboxClientKey` 提供給瀏覽器和插件):照 `EndpointRegistry.candidates("sandbox")` 的順序,每台的 `GET /v1/info` 存一分鐘;只問準備好了、映像檔在、主人接這種工作(`policy.members` / `plugins`)的那幾台。每台先 `reserve` 再 `PUT /v1/jobs/{id}`;`busy`、`not_accepting`、`unavailable`、沒送出去就換下一台。工作開了就留在那台。
- 每台只開**一條**事件長輪詢(`GET /v1/events`):中繼每台只有 16 條串流。中繼滿了而被拒的請求(還沒送出去)會等一下再送,不當成那台壞了。每分鐘續租一次。
- 付錢的人以 Core 自己的密鑰做 HMAC 之後才送出去(`payerId`),那台認不出是誰。CPU 秒數從事件的 cgroup 累計值算差額,記到 `WorkQuota`(`WorkQuotaKey`,沒有就不記也不擋);開始前已經到上限的不開工作,回固定的一句;跑到一半超過的停掉(`killed_reason: "quota"`)。
- 檔案(`transfer.ts`):第一次整個資料夾打成 tar.gz、分段(`[modules.sandbox.transfer] part_mb`)送進去;工作階段之後每次 exec 前只送 Core 這邊改過的(和刪掉的),exec 後收回程式改的。收回來的東西一律不信:用 `tar-io` 解到工作區旁邊的暫存資料夾(只收一般檔案和資料夾、每個路徑過 `normalizeRelativePath`、有深度和那個資料夾的位元組 / 檔案數上限),再一個一個搬進去,目的地的每一段都 `lstat`(不穿過連結、不出那個資料夾;她自己的呼叫碰不到 `people/`);要刪的路徑同樣檢查。之後照舊 `enforce`、`replaceFolder`。兩邊都改了同一個檔:留程式的版本,她的改名成 `<檔名>.conflict-<時間>`,結果裡寫出來。
- 開著的工作記在 `sandbox_jobs`(`sandbox` store 外掛,`jobs-store.ts`):Core 重啟後,還在那台開著的工作階段接回來;不在的標成 `lost`,她下次用那個名字時被告知一次;其他留下的工作(run、瀏覽器、插件)直接關掉。
- 沒有電腦能用時,工具照舊撤掉,原因在模組健康和 `/admin autonomy status`(每台一行)。有電腦但不接成員的工作時工具不撤,成員要的時候回一句能轉告的話。

## 服務

| Key | 型別 | 內容 |
|---|---|---|
| `SandboxKey` | `Sandbox` | `run()`、`listSessions()`、`closeSession()`、`health()`、`tools`(工具工作區) |
| `ProposedToolsKey` | `ProposedTools` | 自寫工具的儲存與生命週期(需要 `SettingsStore`) |

```ts
const sandbox = ctx.services.require(SandboxKey);
const result = await sandbox.run(
  { language: "python", code, files: [{ path: "in.csv", content }], stdin, timeout_ms: 10_000,
    session: "fresh" /* 預設;或工作階段名稱,例如 "weather-tool" */ },
  { signal },
);
// → { run_id, language, exit_code, stdout, stderr, stdout_truncated, stderr_truncated,
//     files_out: [{ path, size, encoding: "utf8" | "base64", content }], files_out_truncated,
//     duration_ms, killed_reason: "timeout" | "aborted" | "output_limit" | "memory" | null,
//     session: null | { name, created, closed: null | "disk" | "lost" | "closed" | … } }
await sandbox.listSessions(); // → [{ name, language, created_at, last_used_at, runs, disk_bytes, expires_at, busy }]
await sandbox.closeSession("weather-tool"); // → true(關掉並刪掉檔案)/ false(沒有這個名字)
```

- `network` 預設 `"none"`。`{ allow: [...] }` 要 `[modules.sandbox.network] allow` 列了每一個主機才行,否則回 `SandboxError("network_unsupported")`(沒有設定任何主機)或 `invalid_request`(有主機不在清單裡);只有 fresh 執行可以(見「網路白名單」)。
- `mount_workspace: true` 把工作區讀寫掛到 `/workspace`;再加 `workspace_folder`(`people/` 底下的資料夾名,`^[a-z0-9_][a-z0-9_-]{0,64}$`)就只掛那個人的資料夾,用那個資料夾的額度(見「工作區」)。
- 無法執行時丟 `SandboxError`(`kind`:`unavailable`、`busy`、`invalid_request`、`invalid_path`、`network_unsupported`、`image_unavailable`、`docker_failed`、`closed`、`limit`(工作階段開滿)、`session_closed`(`SessionClosedError`,帶 `session` 與 `reason`)…)。程式自己的錯誤不是例外,看 `exit_code` / `stderr`。
- `health()` 用 `docker version` 檢查 daemon;Docker 沒開時模組是 **degraded**(不會 crash),`run()` 丟 `unavailable`,下次使用時重新檢查(`health_ttl_ms`)。

### 一次執行的流程(fresh)

1. 驗證請求(大小上限、逾時上限、檔名、session 名稱)→ 確認 Docker 可用 → 取得並行名額(`max_concurrent`,等待中超過 `max_queued` 回 `busy`)。
2. 映像檔不在本機就先 `docker pull`(在計時開始**之前**;`docker run` 用 `--pull never`)。
3. 開了暖池(見下,預設關閉)且有這個語言準備好的容器就用它;沒有就建立 `<root>/runs/<run id>/code`(程式,唯讀掛到 `/code`)與 `.../work`(輸入檔,讀寫掛到 `/work`)再 `docker run`(參數見下)。程式從 stdin 讀輸入。
4. 牆鐘逾時、呼叫端中止、輸出超量時以**容器名稱** `docker kill`;CLI 5 秒內沒結束就砍掉 CLI 並 `docker rm -f`。
5. 容器結束(CLI 返回)後才收集 `/work` 中新增或改過的一般檔案(有數量與大小上限),刪掉 `code/`,`work/` 保留給最近 `keep_runs` 次。
6. 啟動時移除這個實例(同一個 root)殘留的容器(`label=miyoria.sandbox.instance=<root 的雜湊>`,暖池與工作階段的也算)並清掉舊的執行與工作階段資料夾,之後才開始填暖池。

### 暖池(warm pool,她看不到)

`pool_size`(**預設 0 = 關**,預設設定不會先開任何閒置容器):設成 1 以上,每種語言就先開好那麼多個等著的容器,fresh 執行不用等容器啟動。關著時每次 fresh 執行都像以前一樣自己 `docker run`。

- 暖池的容器**就是一次 fresh 執行的 `docker run`**:同樣的旗標、自己的 `runs/<id>` 工作資料夾,只差命令先包一層 `standbyCommand`:`sh -c 'printf "\006" >&2; IFS= read -r _ || exit 0; exec "$@"' sh python3 -I -B -u /code/main.py`。它先在 stderr 印一個 `0x06`(表示準備好,收集輸出時去掉),然後等 stdin 的一行。
- 用的時候:把程式與輸入檔寫進它掛載的 `code/`、`work/`,在 stdin 寫一個換行(開始)再接著寫程式的 stdin(shell 一次讀一個 byte,不會吃掉程式的輸入),`exec` 成程式本身。程式結束 = 容器結束(`--init` 結束時核心殺掉容器裡所有程序,`--rm` 移除),CLI 返回後才收集輸出。
- **每個容器只服務一次**:這是結構上的保證(容器的生命就是那一個程式),`take` 也只把它交出去一次;用掉就在背景補一個新的。從來不會把容器還回池子。
- 掛 `/tools`(`mount_tools`)的執行不用暖池(池裡的容器沒有掛)。池裡的容器死了(Docker 重開)就丟掉、改走一般的 fresh 執行;Docker 不可用時不補,模組照樣 degraded。
- 每個等著的容器在主機上佔一個 `docker` CLI 程序,在 VM 裡佔一個閒置的 `sh`。

### 工作階段(session)

`session` 是名字(`^[a-z][a-z0-9_-]{0,47}$`,`fresh` 以外)時,第一次執行會開一個長駐的容器,之後同名的執行用 `docker exec` 進同一個容器:

- **會留下的**:`/work`(`<root>/profiles/<profile>/sessions/<id>/work`)的檔案,和容器的 `/tmp`(tmpfs,算在記憶體上限裡)。**不會留下的**:程序。每次執行完(正常結束或被殺)都會以程式的 uid `kill -KILL -1` 殺掉所有程序,之後才讀輸出,所以背景程序不會活到下一次,也不能在主機讀檔時換掉檔案。
- 容器的主程序(`sleep infinity`,在 `--init` 底下)用**另一個 uid** 跑(`keeperUser`:程式是 65534 時用 65533,其他用 65534),所以 `kill -1` 殺不到它,容器留著。
- 每次執行的程式寫成 `/code/run-<run id>.py`(唯讀掛載,跑完刪掉);輸入檔寫進 `/work`,同名的舊檔會被取代,但路徑上已存在的東西必須是真的目錄、檔案(不是她之前留下的 symlink / junction),否則 `invalid_path`。`files_out` 只回這次新增或改過的檔案。Python 要 import `/work` 裡的模組:`sys.path.insert(0, "/work")`。
- 一個工作階段一次只跑一個程式(其他的排隊);也吃全域的並行名額。一個工作階段固定一種語言;不掛 `/tools`。
- **限制**(`[modules.sandbox.sessions]`):同時最多 `max` 個(預設 3,0 = 不能開);閒置 `idle_minutes`(預設 15)或開了 `lifetime_minutes`(預設 120)就自己關掉(每 1–30 秒掃一次;執行中的不會被關,用的時候才發現過期也算);一次執行後 `/work` 超過 `disk_mb`(預設 256)或超過 10 000 個項目就關掉。每次執行仍套用跟 fresh 一樣的逾時、輸出上限、記憶體、CPU、pids、`fsize`,也一樣 `--network none`。
- **關掉時**:`docker rm -f` 加上刪掉工作資料夾。過期、容器不見了(`lost`)而關掉的,她下一次用這個名字會收到 `session_closed`(說明原因、檔案已經沒了),**只說一次**,再用同一個名字就開一個新的空工作階段。因為 `disk` 關掉的直接寫在那次的結果裡(`session.closed`)。
- 模組停止時全部關掉;下次啟動時依 label 清掉殘留的容器、刪掉殘留的工作資料夾。事件:`sandbox.session.started`、`sandbox.session.closed`(`{ name, reason, runs }`)。

### `docker run` 參數

```
docker run --rm -i --name miyoria-sbx-<run id>
  --label miyoria.sandbox=1 --label miyoria.sandbox.instance=<hash> --label miyoria.sandbox.run=<run id>
  --pull never --log-driver none
  --network none
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m
  --mount type=bind,source=<root>/runs/<id>/work,target=/work
  --mount type=bind,source=<root>/runs/<id>/code,target=/code,readonly
  [--mount type=bind,source=<root>/profiles/<profile>/tools,target=/tools,readonly]
  --workdir /work --user 65534:65534 (或 Linux/macOS 上非 root 的主機 uid:gid)
  --cap-drop ALL --security-opt no-new-privileges --ipc none --hostname sandbox
  --memory 256m --memory-swap 256m --cpus 1 --pids-limit 128
  --ulimit fsize=16777216 --ulimit nofile=256:256 --init
  --env HOME=/tmp --env TMPDIR=/tmp --env LANG=C.UTF-8
  python:3.12-slim python3 -I -B -u /code/main.py      (Node:node:24-slim node /code/main.mjs)
```

數值都可在 `[modules.sandbox.limits]` 調整。程式碼**永遠不會出現在命令列**(寫成檔案再唯讀掛載),CLI 用 `spawn(docker, args, { shell: false })` 執行,不經過任何 shell(暖池的 `sh -c` 是容器裡固定的一行,程式與參數不會進去)。

- 暖池:同樣的參數(`--label miyoria.sandbox.kind=pool`),命令是 `sh -c '<standby>' sh python3 -I -B -u /code/main.py`。
- 工作階段:同樣的參數,但 `-d` 取代 `-i`、`--user <keeper uid>`、`--label miyoria.sandbox.kind=session --label miyoria.sandbox.session=<name>`、不掛 `/tools`,命令是 `sleep infinity`;每次執行是 `docker exec -i --user <程式 uid> <容器> python3 -I -B -u /code/run-<id>.py`(繼承容器的環境變數、工作目錄與限制),結束後 `docker exec --user <程式 uid> <容器> sh -c 'kill -KILL -1; kill -KILL -1; exit 0'`。

### 工具工作區

`sandbox.tools`:每個 profile 一個持久資料夾 `<root>/profiles/<profile>/tools`,放她自己寫、想留下來的腳本(`save` / `list` / `read` / `remove`,名稱 `^[a-z][a-z0-9_-]{0,47}$`,副檔名 `.py` / `.mjs`)。只有主機端會寫入;執行時加 `mount_tools: true` 才會**唯讀**掛到 `/tools`(例如 `sys.path.insert(0, "/tools")`)。跟每次執行的暫存資料夾完全分開。

### 自寫工具(`tool.propose`)

`ProposedTools`(存在 `SettingsStore`,key `sandbox:tool:<name>`):

```
propose(name, description, language, code, args_schema) → pending(version 1)
approve(name, { reviewer, version })  pending → approved   ← 必須指定版本:審核的就是那一版
reject(name, { reviewer, version, note }) pending → rejected
propose(同名)                          → pending(version + 1;原本的核准失效)
invoke(name, args)                     只限 approved;args 依 args_schema 驗證,以 JSON 從 stdin 傳入,
                                       在沙箱裡跑(network none);code 的 sha256 跟紀錄不符就拒絕
approvedSpecs()                        已核准的工具 { name, description, parameters, version }(註冊成 sbx_<name>)
```

`args_schema` 必須是 `type: "object"` 的 JSON Schema(用 `z.fromJSONSchema` 驗證)。事件:`sandbox.tool.proposed`、`sandbox.tool.reviewed`、`sandbox.tool.removed`、`sandbox.run.finished`(`custom` 事件,payload 不含程式碼與輸出)。

## 安全審查

### 威脅模型

- **程式碼是不可信的。** 寫程式的是 LLM,而 LLM 的輸入包含不可信的聊天、語音辨識、遊戲聊天、網頁與圖片描述。要假設攻擊者能讓她寫出**任何程式**(prompt injection),包括故意的惡意程式:讀檔、偷密鑰、連外、挖礦、塞爆磁碟、fork bomb、試圖逃出容器。
- **輸出也是不可信的。** stdout、stderr、輸出檔回到她的上下文時是**資料**,可能夾帶下一段 prompt injection。工具結果用 `formatRun` 包成不可信資料區塊(`dataBlock`:固定分隔符、跳脫裡面的分隔符與聊天模板控制字元)、截斷到 `result_chars`,輸出檔只回檔名與大小;稍後才出來的結果走 agent 的 user role 資料區塊(§8.2),不會進 system。
- 沙箱要保護的是:主機檔案與密鑰(`.env`、`miyoria.toml`、資料庫、Discord / LLM token)、主機網路與區網、主機資源、其他執行的資料。

### 容器擋下了什麼

| 攻擊 | 防護 |
|---|---|
| 讀主機檔案 / 密鑰 | 只掛載這次(或這個工作階段)的 `work/`、`code/`(唯讀)與選用的 `tools/`(唯讀);沒有 `-v` 主機目錄、沒有 Docker socket |
| 從環境變數偷密鑰 | `docker run` 不轉送任何主機環境變數;容器只拿到 `HOME` / `TMPDIR` / `LANG`(加上映像檔自己的 `ENV`)。連 Docker CLI 本身都只拿到白名單(`PATH`、`DOCKER_HOST`…),Miyoria 的密鑰不在它的環境裡 |
| 連外、打區網、打 Core API | `--network none`:只有 loopback,DNS 也查不到(整合測試驗證) |
| 改系統檔、留後門 | `--read-only` 根目錄;`/tmp` 是 `noexec` 的 tmpfs;fresh 容器每次重建(`--rm`);工作階段的容器只留 `/work` 與 `/tmp`,關掉就刪 |
| 提權 | 非 root `--user`、`--cap-drop ALL`、`no-new-privileges`、Docker 預設 seccomp、`--ipc none` |
| 資源耗盡 | `--memory`(無 swap)、`--cpus`、`--pids-limit`(fork bomb)、`--ulimit fsize/nofile`、牆鐘逾時、輸出上限(超過 `kill_output_bytes` 直接殺)、並行名額 |
| 用檔名逃出工作區 | 輸入檔名逐段檢查(拒絕 `..`、絕對路徑、磁碟代號、`\`、`:`(含 NTFS ADS)、控制字元、Windows 保留名稱、結尾的點或空白、大小寫重複),再確認解析後仍在 `work/` 內;以 `wx` 寫入,不覆寫 |
| 用輸出檔讀主機檔 | 收集輸出時用 `lstat`,只讀一般檔案;symlink、FIFO、裝置一律略過(容器裡做 `ln -s /etc/passwd` 不會被讀回;整合測試驗證);有深度與數量上限;容器結束後(工作階段:殺掉所有程式程序後)才收集,沒有競態 |
| 用參數注入 Docker 旗標 | 映像檔名、容器名、使用者、label、env 都用正規表示式檢查(不能以 `-` 開頭);`--mount` 的路徑若含 `,` 或 `"` 會以 CSV 引號包起來 |
| 審核後偷換程式 | 核准綁定版本號;再次 propose 會回到 pending;執行前比對 sha256 |
| 暖池的容器被重複使用、帶著上一次的狀態 | 容器的生命就是一個程式(`exec` 之後程式結束 = 容器結束);`take` 只交出一次、不會放回;live 測試驗證後一次看不到前一次的 `/tmp` 與 `/work` |
| 工作階段裡留背景程序(挖礦、等主機讀檔時換成 symlink) | 每次執行後以程式的 uid `kill -KILL -1`(主程序是另一個 uid,不受影響),**之後**才讀輸出、才寫下一次的輸入;live 測試驗證背景程序活不到下一次 |
| 用工作階段裡留下的 symlink / junction 讓主機把輸入檔寫到別處 | 寫輸入前逐段 `lstat`:已存在的父路徑必須是真的目錄、同名的必須是一般檔案(先刪掉再以 `wx` 寫);這時容器裡沒有任何程式在跑,沒有競態 |
| 工作階段塞爆磁碟或存活太久 | `disk_mb` / 10 000 個項目上限(每次執行後檢查,超過就關掉);`idle_minutes`、`lifetime_minutes`;同時最多 `max` 個 |

### Docker Desktop / WSL2 的剩餘風險

- **容器不是 VM。** 所有容器共用 Docker Desktop 那台 WSL2 utility VM 的 Linux 核心。核心漏洞或 runc / containerd 漏洞可以逃出容器;逃出後在 VM 裡,而 Docker Desktop 的 VM 能存取 Windows 磁碟(`/mnt/host/c`),等於拿到你的使用者檔案。保持 Docker Desktop 更新;更高要求可改用 gVisor(`--runtime runsc`,Docker Desktop 預設沒有)或 Hyper-V 隔離的 VM。
- **Docker daemon 等於 root。** 能用 Docker CLI 的程式(包括 Miyoria 本身)就能完全控制主機。沙箱只透過 CLI 下固定格式的指令,但 Miyoria 程序被攻破時這層保護就沒了。
- **磁碟。** `/work` 在主機磁碟上,沒有真正的配額:單檔被 `fsize`(預設 16 MiB)限制,但在逾時內寫很多檔案仍可能用掉數 GB。fresh 的 `keep_runs` 之後會清掉;工作階段的 `disk_mb` 是**事後檢查**(一次執行結束才量,超過就關掉並刪掉),擋不住單次執行裡先寫爆。要更嚴格可把 `root` 放在有配額的磁碟。
- **工作階段是長駐的容器。** 同一個工作階段的多次執行共用 `/work`、`/tmp` 與核心狀態,所以一次被 prompt injection 的執行可以留下檔案影響之後的執行(例如換掉她寫在 `/work` 的模組)——但只影響同一個工作階段,而且之後每次執行一樣要過審核。程序清除依賴 `kill(-1)` 的語意(殺掉同 uid 的所有程序、不含 PID 1 與其他 uid);容器沒有任何能力,程式換不了 uid。
- **工作階段的 CLI 呼叫比較多。** 每次執行是 `docker exec` 加一次清除的 `docker exec`,比暖池的 fresh 慢(見「測試」的數字);它省的是狀態,不是時間。
- **映像檔供應鏈。** 預設用 Docker Hub 的官方 `python:3.12-slim`、`node:24-slim` 標籤。標籤會變;要可重現就在設定裡釘 digest(`python:3.12-slim@sha256:…`),代價是要自己更新安全修補。
- **側通道與資訊。** 容器看得到 CPU 型號、核心版本、時間;CPU 時間測量類的側通道沒有防。`--network none` 下仍能透過輸出內容把資料帶出去——但能帶出去的只有她自己放進去的東西(沙箱裡沒有密鑰)。
- **Windows 掛載語意。** 容器建立的 FIFO 在 Windows 端連 `lstat` 都會失敗(會被略過,標成 `files_out_truncated`);檔案權限在 Windows 端沒有意義。Linux / macOS 主機上用 `user = "auto"`(主機 uid)才清得掉容器寫的子目錄。
- **Core 跑在容器裡(`deploy/`)時不建議開。** 沙箱需要主機的 Docker daemon,等於要把 `/var/run/docker.sock` 掛進 Core 容器(Core 被攻破 = 主機 root);而且 bind mount 的來源路徑是由主機 daemon 解析,`root` 必須是主機上也存在的同一個路徑。建議在主機上原生跑 Core 時才開沙箱。
- **OOM 判斷是推測。** exit 137 且不是沙箱殺的就回報 `memory`;程式自己 `kill -9` 自己也會被當成 `memory`。

### 為什麼密鑰永遠不會進容器

1. 容器的環境變數是程式裡寫死的三個值(`CONTAINER_ENV`),沒有 `--env-file`、沒有不帶值的 `-e NAME`(那會從 CLI 環境複製)。
2. Docker CLI 程序本身用過濾後的環境啟動(`dockerCliEnv`),Miyoria 的 `LLM_API_KEY`、`DISCORD_BOT_TOKEN`、`MIYORIA_API_TOKEN` 等根本不在它的環境裡,即使未來誤加 `-e` 也帶不過去(單元測試與整合測試都驗證)。
3. 讀寫掛載只有全新的 `runs/<id>/work`,和有要求時的工作區(替別人時只有那個人的資料夾);設定檔、`.env`、資料庫都不在任何掛載的目錄下。
4. 程式碼與參數不經過 shell,所以不會被展開成 `$(cat .env)` 之類的東西。

### 工作區(`[modules.sandbox.workspace]`)

她的持久資料夾 `<root>/profiles/<profile>/workspace`,以 bind mount 掛到容器的 `/workspace`。額度:`max_mb`(4096)、`max_files`(20 000)、`max_file_kb`(8192),都含每個人的資料夾;每次執行後由主機端檢查,超過額度或出現連結(symlink / junction)就移除並回報。路徑一律在主機端逐段 lstat 檢查,拒絕 `..`、絕對路徑、磁碟代號、反斜線與連結,開檔用 `O_NOFOLLOW`,寫入先寫暫存檔再 rename。工具:`workspace_list / read / write / delete`(不需要 Docker)、`workspace_export`(把一個檔案存成產物,之後用 `share` 交給人)、`workspace_save_script`(高風險,內容過 LLM 審查,雜湊記在容器寫不到的 `workspace-scripts.json`)、`workspace_run`(只跑核可過、內容沒變的腳本)。`workspace_read` 一次回 `read_chars`(3900)字,其餘用 `offset` 分段讀;較長的執行輸出存成 `outputs/<run_id>.txt` 並回報路徑,只保留最近 `keep_outputs`(20)個。

- **每個人一個資料夾**(`src/people.ts`):替別人做的呼叫(對方開口,或幫手替對方做)只碰得到 `people/<資料夾>/`:路徑從那裡算起,列出只有那裡,讀、寫、刪、匯出、掛進執行(`workspace_folder`)都出不去;太長的輸出也存在那裡。資料夾名是那個人在 heart 的 person id(小寫);heart 不認得的帳號用 `<platform>-<id>`;帶路徑字元或是保留名稱的 id 用 `_` 加雜湊。不看 principal 的種類只看 `requester`:成員叫她 `on_own` 也一樣只有自己的資料夾。面板和有 `sandbox.workspace.all` 的人(沒有角色列,只有 owner 透過 `*` 有)看得到整個工作區,路徑跟以前一樣。沒有人在背後的呼叫(她自己的、沒人要的排程、看一眼)看得到整個工作區,除了 `people/`:成員有辦法讓她做這種呼叫,所以別人的資料夾不能列、讀、寫、刪、匯出或執行,`people` 本身也不能刪;掛整個工作區的執行要把 `/workspace/people` 蓋掉(`ContainerSpec.hiddenInWorkspace`)。有人要的排程記著是誰要的,到時候替那個人做。每個人的額度:`person_max_mb`(256)、`person_max_files`(2000);單檔上限跟整個工作區一樣;路徑的上限(8 層、255 字)從那個人的資料夾算起。工作階段也分人:替別人開的工作階段名字前面加一段那個人的標記,列出與關閉只看得到自己的;她自己的呼叫用不到別人的工作階段。
- **寫檔就是寫檔**:`workspace_write` 收任何文字檔,`.py`、`.mjs` 等程式碼也是(要交給人、或用 `code_run` 加 `use_workspace` 現在跑)。審核只留給之後沒人看著就會跑的腳本:`workspace_save_script` 存的(`workspace_run` 和排程跑的)與 `tool_propose` 的工具。
- **匯出**(`workspace_export`):一個檔案最多 `export_max_kb`(8192);收文字(markdown、CSV、JSON、HTML、程式碼都存成 `text/plain`、保留自己的副檔名,永遠不會被當網頁打開)、圖片、音訊、影片、PDF、zip 和 docx / xlsx / pptx(副檔名只決定是哪一種,內容必須是 zip)。zip 只看目錄、不解開:檔名跑出資料夾(`..`、絕對路徑、磁碟代號,兩種分隔符號)、連結、項目互相重疊、項目超過 `[modules.actions.share] zip_max_entries` 或解開後合計超過 `zip_max_unpacked_mb` 都拒絕。

### 網路白名單(`[modules.sandbox.network]`)

預設關閉:`allow = []`。填入網域後,`code_run` 的 `use_network` 才可用:`--internal` 網路(無對外路由)加一個 egress proxy 容器(同時接 bridge 與 internal,別名 `egress-proxy`),只放行白名單網域、埠 80/443,並自行解析 DNS、擋私有位址。執行容器只接 internal 網路並設 `HTTP(S)_PROXY`。proxy 程式用真的子程序在 loopback 上測過,編排用 FakeRunner 測;真實 Docker 的行為見 `test/docker.workspace.integration.test.ts`(`MIYORIA_LIVE_WORKSPACE_TESTS=1`)。尚未做到:每次執行只開白名單的子集。

## 閘門與工具(`src/gate.ts`)

Docker 可用時(啟動時檢查,之後每 `recheck_ms` 再檢查),module 在 app 的 `ActuatorRegistry` 註冊下面的能力;Docker 不見了就全部撤下,module 停止時也撤下。所有呼叫都經過閘門(暫停、禁止清單、權限、預算、次數限制、審核、稽核紀錄):反應回合是 `user`(或 `on_own` 的 `self`),她自己的回合是 `self`。替誰做,就只用那個人的資料夾和工作階段(見「工作區」)。

**誰能叫**:`sandbox.workspace`、`sandbox.code.run`、`skills.use`、`work.delegate` 是做事的節點(`WORK_NODES`)。有 `work.bond` 的人(成員以上都有)羈絆到 `[modules.actions] work_min_bond`(預設 15,朋友)就算有這些節點;不夠時她看到的是一段可以轉告對方的說明(`WORK_BELOW_BOND`),不是「沒有權限」。owner 和本來就有節點的人(`sandbox.code.run` 是 trusted 以上)不看羈絆。羈絆只讀不寫。

| 能力 | 工具 | 風險 | 權限節點(`user` 要有;她可以 `on_own`) | 內容 |
|---|---|---|---|---|
| `code.run` | `code_run` | 中(`work`、`followup`) | `sandbox.code.run`(trusted 以上,或羈絆到 `work_min_bond`) | 跑一段 Python / Node。參數 `language`、`code`、`stdin`、`files`、`timeout_ms`、`session`(`"fresh"` 預設 / 工作階段名稱)、`use_workspace`、`use_network`(本地後端、設定了主機時才出現,只能連那些主機;叢集後端照 `[modules.sandbox.network] mode`);模型給不了別的網路 |
| `shell.run` | `shell_run` | 中(`work`、`followup`) | `sandbox.code.run` | 叢集後端才有:一段 bash,在那個人的工作階段(預設 `main`)裡,工作目錄 `/workspace` |
| `code.session` | `code_session` | 低 | `sandbox.code.run` | `action: "list"` 列出開著的工作階段(名稱、語言、次數、佔用空間、多久後關掉);`action: "close", name` 關掉一個並刪掉檔案。替別人時只有那個人的工作階段 |
| `workspace.list` / `.read` / `.export` | `workspace_list` / `_read` / `_export` | 低 | `sandbox.workspace`(羈絆到 `work_min_bond`) | 見「工作區」 |
| `workspace.write` / `.delete` | `workspace_write` / `_delete` | 中 | `sandbox.workspace` | 見「工作區」;次數上限用 `[modules.actions.work]` |
| `workspace.save_script` / `.run` | `workspace_save_script` / `_run` | 高 / 中 | `sandbox.code.run` | 存核准的腳本 / 跑核准過的腳本 |
| `tool.propose` | `tool_propose` | 高 | `sandbox.tool.propose`(預設只有擁有者) | 提出自寫工具;閘門放行 = **核准這個版本** |
| `sbx.<name>` | `sbx_<name>` | 中 | `tools.sandbox.<name>`(trusted 以上透過 `tools.*`) | 已核准的自寫工具;參數在閘門依 `args_schema` 驗證,`ProposedTools.invoke` 再驗一次並比對 sha256,在沙箱裡跑(逾時 `tool_timeout_ms`) |

- **跑程式不審查**(v6-sandbox §10.1):`code.run`、`shell.run` 是中風險,只照 `[modules.actions.work]` 的次數;擋傷害的是沙箱本身、出口代理和每人的 CPU 秒數。之後沒人看著就會跑的(`workspace.save_script`、`tool.propose`)照舊是高風險、要審查。
- **審核**(§8.1):高風險 → 她自己的 `review` 呼叫,看結構化請求(含完整程式碼)與能力的 `guidance`(什麼可以放行、什麼要拒絕),不看聊天原文;`uncertain` 才私訊擁有者確認卡,卡片附上程式碼檔(`main.py` / `<name>.py`)、sha256 與參數 schema,`code.run` 的卡片也寫出是用完即丟還是哪個工作階段。
- **選哪一種**(寫在 `code_run` 的工具說明裡,由她決定):一次就算完的事(算個數字、轉個格式)用 `"fresh"`;要分好幾步的事(先存資料、再分析、再整理)取一個名字開工作階段,做完用 `code_session` 關掉。工作階段已經不在(過期、容器不見了)或開滿時,`code_run` 回一段說明(原因、檔案已經沒了、怎麼辦)而不是錯誤,程式沒有執行;結果文字的開頭會寫「在工作階段「x」」與「這次新開的」/「被關掉了」。`code.session` 是低風險:只動她自己的工作階段,不跑程式,不審核也不受次數限制(仍要權限節點)。
- **結果怎麼回來**:`code_run`、`shell_run`(中風險)和 `tool_propose`(高風險)是 `followup` 工具:(審核加)執行在 `[modules.actions] inline_wait_ms`(預設 8 秒)內完成就直接回結果;否則先回「還沒有結果」,完成後用後續回合(`agent_initiative`,reason `action_result`)告訴她結果或拒絕原因。結果文字由 `formatRun` 產生:exit code、時間、被殺原因、stdout / stderr(stderr 最多佔三分之一)、輸出檔名與大小,全部在不可信資料區塊裡,總長約 `result_chars`。`ActionResult.data` 只有 `summarizeRun` 的位元組數與狀態,不含輸出。
- **自寫工具的生命週期**:`tool.propose` 被放行 → `propose` + `approve(name, { reviewer, version })`,`reviewer` 是 `self`(她的審核)或回覆確認卡的擁有者帳號;被她的審核或擁有者拒絕 → 存成 `rejected`(附理由);沒有人決定(擁有者沒回、聯絡不到、審核失敗)→ 存成 `pending`,擁有者之後可以從 API 核准。已經核准的工具,新版本被拒絕時**保留舊版**(不會因為一次失敗的提案讓她失去工具)。同名再提出且被放行 → 版本 +1。`sandbox.tool.*` 事件一來就重新同步 `sbx_<name>` 的註冊。
- **中風險的理由**:程式碼在核准時已經審過(綁定版本與 sha256),每次呼叫只差參數(已驗證 schema)而且仍在離線沙箱裡;再對每次呼叫做審核既貴又慢,等於讓核准沒有意義。剩下的風險是資源用量,交給次數限制(預設中風險上限:每天 30 次、每人 8 次、冷卻 20 秒;`[modules.actions.limits."sbx.<name>"]` 可調,`forbidden = ["sbx.*"]` 可全部關掉)。
- **做事的次數上限**:`code.run`、`workspace.write / delete / save_script / run`、`skill.write / delete` 是做事的能力(`Capability.work`),用 `[modules.actions.work]` 而不是中風險那組:沒有冷卻、每人每小時 300 次、每人每天 3000 次、所有人每天 20 000 次。一件事要寫好幾個檔案、跑好幾次程式是正常的;每個人的 AI 額度和資料夾額度擋其他的。
- 參數名稱 `why`、`on_own` 是工具保留的,`args_schema` 不能用(閘門的參數檢查就擋下)。
- **擁有者看得到的地方**:`/admin autonomy status`(Docker 狀態、能力是否開放、已核准 / 待審 / 已拒絕的工具);API `GET /api/sandbox/tools`(清單與 Docker 狀態,不含程式碼)、`GET /api/sandbox/tools/:name`(含程式碼)、`POST /api/sandbox/tools/:name/approve|reject`(body `{ "version": n, "note"?: "..." }`;版本不是目前版本 → 409;需要 token,或面板帳號有 `owner.autonomy.approve` 與寫入權限)。面板頁面尚未做。
- 工具工作區(`sandbox.tools.save` 等)沒有開放給模型;`code_run` 的工具說明沒有列出 `mount_tools`(schema 仍接受,掛載是唯讀的)。

## 別人傳來的檔案(`src/files.ts`、`src/extract.ts`)

模組另外提供 `FileReaderKey`(`[modules.sandbox.files]`):agent 把使用者傳的文字、程式碼、pdf、docx、xlsx、pptx 交給它,它下載位元組(只搬運),再把檔案當輸入檔放進一次性、斷網的容器,由標準庫寫的抽取程式讀出文字,回傳成不可信的資料區塊。沙箱不能用時拒絕,不在 Core 裡處理。設計與限制見 `docs/design/file-attachments.md`。

## 設定

見 `miyoria.example.toml` 的 `[modules.sandbox]` 與 `src/config.ts`(每個欄位都有預設值)。

## 測試

- `pnpm --filter @miyoria/workspace test`:單元測試用注入的假 `DockerRunner`,不需要 Docker。
- `test/remote/`:叢集後端對測試程序裡的假服務(`fake-service.ts`,經假的 `EndpointSource`):挑台和換台、不接成員時的那一句、付錢的人不送出去、額度在開始前和跑到一半擋下、資料夾送進送出、惡意的那台送回 `..`、連結、絕對路徑、別人的資料夾時都擋下、超過額度的被 `enforce` 刪掉、太大的資料夾回那一句、工作階段只送改的和刪的、兩邊都改的留下她的、那台關掉的工作階段說一次、重啟後接回;`sandbox_jobs`;模組沒有電腦時撤掉工具、有了就開放。`docker.e2e.test.ts` 對真的服務和 Docker(要 P2 的服務、建好的映像檔和 `MIYORIA_SANDBOX_IMAGE_TESTS=1`,否則跳過)。
- `test/gate.test.ts`:閘門路徑(不審查、沒有節點不跑、太久的結果用後續告訴她)、本地後端的 `network` 永遠是 `none`、叢集後端的 `shell_run` 和她看到的原因、輸出的不可信框與截斷、後續回合、自寫工具的核准 → 註冊 → 呼叫。
- `test/sessions.test.ts`:工作階段(同名重用、檔案只回這次改的、閒置 / 存活上限與「只說一次」、數量上限、磁碟上限、逾時只殺程式、容器不見了、一次一個、關掉時中止、輸入檔不能寫穿之前留下的路徑、停止與啟動時清理)與暖池(每個容器只跑一個程式、逾時以名稱 kill、容器死了改走 fresh、`mount_tools` 不用暖池、壞的請求也會丟掉拿走的容器、沒有 Docker / 沒有 `warm()` 時不開)。
- `test/docker.integration.test.ts` 會真的跑容器(也有一個經過閘門的 `code_run` 與 `sbx_<name>` 案例,以及工作階段的重用 / 過期 / 上限、暖池的一次性與延遲量測);偵測不到 Docker daemon(或設 `MIYORIA_SKIP_DOCKER_TESTS=1`)時自動跳過。第一次會下載映像檔(在作者的機器上 `python:3.12-slim` 約 9 秒、`node:24-slim` 約 3 秒)。
- 延遲(2026-11-03,Windows 11 + Docker Desktop 29.8.2 / WSL2,`print(1)`,從呼叫 `run()` 到拿到結果,7 次的中位數):fresh 沒有暖池(預設) **約 395 ms**;fresh 用暖池(測試裡明確設 `pool_size = 1`,容器已準備好)**約 185 ms**;`pool_size = 1` 連續跑時一半命中、一半等不到補上的容器(約 180 / 385 ms 交替);工作階段 **約 420 ms**(`docker exec` + 清除)。Docker CLI 每次呼叫在這台機器上本身就要 150–250 ms。
