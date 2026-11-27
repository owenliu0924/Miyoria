# 階段 7 第二到四批:分工

> 2026-11-27。[v6-agent.md](v6-agent.md) 的第二、三、四批,分給幾個同時在同一個 worktree 裡做事的人。第二批的設計在 [v6-sandbox.md](v6-sandbox.md)(以下「沙箱文件 §n」)。這份文件只講誰做什麼、碰哪些檔、彼此之間的介面。
>
> 介面都寫成 TypeScript,兩個人可以在對方還沒寫好之前就照著寫;實際的檔案出來後以檔案為準,和這裡不同的地方由寫的人回頭改這份文件。

## 0. 共同的規則

- **檔案只屬於一個工作包**。表 §2 的「擁有」以外的檔案只讀;要改別人的檔,寫在自己的交付說明裡,由擁有者或整合(P9)改。新檔案優先於改共用的檔。
- **同一個 worktree**:不要切分支、不要 commit、不要 stash、不要對整個 repo 跑會寫檔的格式化或 lint `--write`;只格式化自己擁有的檔。檢查只跑自己碰到的套件(`pnpm --filter <套件> typecheck`、`test`)。全部的測試由 P9 在最後跑。
- **相依套件和 lockfile 只有 P1 改**(`pnpm install` 只有 P1 跑)。需要新的相依,先告訴 P1。
- **另一個工作正在改** `packages/brain/self/src/rules.ts`、`packages/memory/learning/`、`tools/eval/`:這三處誰都不碰,`rules.ts` 要加的字由 P9 在那個工作結束後一次加(§4)。2026-11-27 寫這份文件時,`git status` 顯示那個工作也改著 `miyoria.example.toml`(兩份)、`packages/brain/agent/src/config.ts`、`packages/brain/selfhost/src/host.ts`、`packages/brain/self/src/index.ts`、`run.ts`、`types.ts`、`packages/brain/selfhost/src/voice.ts`。其中 `brain/agent/src/config.ts`(P4)、`host.ts` 和兩份 `miyoria.example.toml`(P9)在這份分工裡有擁有者:**擁有者等那個工作結束才動手,從它留下的版本開始,只加不改它的部分**;動手前先 `git status` 看一次。
- 舊的 `miyoria.toml`、`host.toml` 要照樣開得起來;store 的 migration 只新增表或欄位;既有的工具名字(`code_run`、`code_session`、`workspace_run`……)照舊可以叫。
- 需要 Docker 的測試用 `describe.skipIf(!dockerAvailable())`(`packages/workspace/sandbox/test/docker.integration.test.ts` 的判斷):CI 的 Linux 會跑,沒有 Docker 的機器跳過。
- 文件、程式、註解裡不寫歸屬、工具名稱或表情符號(AGENTS.md)。

## 1. 工作包

| 包 | 交付 | 批 | 可以開始 | 要等 |
|---|---|---|---|---|
| **P1** 基礎 | 協定的形狀、共用型別、`tar-io`、相依和匯出路徑 | 2–4 | 馬上 | 無 |
| **P2** 沙箱服務 | hostd 的 `sandbox` 服務、映像檔、出口代理、`procs` 頻道、CLI 的 `sandbox serve/build` | 2(+3、4 的頻道) | 馬上 | 型別檢查要 P1 |
| **P3** Core 的沙箱 | `RemoteSandbox`、`SandboxClient`、檔案進出、工作階段表、`shell_run`、風險等級、`followup` 給中風險 | 2 | 馬上 | 型別檢查要 P1;真的跑要 P2 |
| **P4** 額度、附件、分享 | 每人的工作額度、`workspace_attach`、`share` 和 `workspace_export` 放寬 | 2 | 馬上 | 型別檢查要 P1 |
| **P5** 第三批的工具 | `workspace_edit`、`workspace_grep`、`image_make`、排程開工作 | 3 | 馬上 | 型別檢查要 P1 |
| **P6** 瀏覽器 | 瀏覽器映像檔和驅動、`browse_open/act/read/shot` | 3 | 馬上(驅動、工具) | 端到端要 P2、P3 |
| **P7** 插件和外部工具走閘門 | 插件工具、MCP 工具走閘門;成員到 `work_min_bond` 叫得到;宣告式 HTTP 工具;插件排程;`ext new` 範本 | 4 | 馬上 | 型別檢查要 P1 |
| **P8** 插件的程序進沙箱 | `ExtensionLauncher` 的沙箱實作、插件附的 MCP 伺服器在同一個工作裡跑 | 4 | 馬上(對假的 client) | 端到端要 P2、P3、P7 |
| **P9** 整合 | 共用熱點檔、設定範例、接線、文件、全部測試 | 2–4 | P1 之後可以先做骨架 | 其他每一包 |

順序:

```
P1 ──┬─▶ P2 ──────────────┐
     ├─▶ P3 ──────────────┤
     ├─▶ P4 ──────────────┤
     ├─▶ P5 ──────────────┼─▶ P9
     ├─▶ P7 ──────────────┤
     ├─▶ P6(對 P2、P3 的介面寫;端到端等它們)
     └─▶ P8(對 P3、P7 的介面寫;端到端等它們)
```

- P1 很小(半天),先落地;其他包從第一天就照 §3 的介面寫,P1 落地後型別檢查才會過。
- P2、P3、P4、P5、P7 互不相依,可以完全同時做。
- P6、P8 也可以同時開始,用假的 `SandboxClient`(§3.3)測;端到端的測試等 P2、P3(P8 另外等 P7 的 `launch.ts`)。
- P9 最後;它的骨架(設定範例的段落、熱點檔的空位)可以在 P1 之後先寫。

## 2. 每一包

### P1 基礎

**交付**

- `packages/contracts/workers/src/sandbox.ts`:沙箱文件 §3.3、§3.8 的每個形狀,zod,沒有 transform,新欄位可省或有預設。匯出名字照沙箱文件(`SandboxInfoSchema` / `SandboxInfo`、`JobCreateSchema` / `JobCreate`……);JSON Schema 的 id 是 `WorkersSandbox<名字>`(`WorkersSandboxJobCreate`),因為 kit 規定 id 以部分的名字(`Workers`)開頭。另外多了 `JobList`(`GET /v1/jobs` 的回應,`{ jobs: JobView[] }`,沙箱文件沒寫形狀)和 `SANDBOX_ERROR_STATUS`(錯誤碼到 HTTP 狀態)。重新產生 `workers/contracts.py`(Python 那邊的 pydantic 模型,CI 會比對)。`workers/src/index.ts` 加一行 `export * from "./sandbox.js"`。重新產生 `schema/workers.json`。
- `packages/contracts/host/src/host-config.ts`:`HostConfigSchema` 加可省略的 `sandbox`(`HostSandboxConfigSchema`,沙箱文件 §12.1 的鍵,strict,全部可省);`protocol.ts` 的 `HOST_CAPABILITIES` 加 `"sandbox"`。重新產生 `schema/host.json`。
- `packages/contracts/ext/src/tools.ts`:`ExtToolDeclSchema` 加 `risk`(`ExtToolRiskSchema`:`"low" | "medium" | "high"`,預設 `"medium"`,所以輸出型別裡一定有)、`work`(可省的布林)、`limits`(可省的 `ExtToolLimitsSchema`:`per_hour`、`per_person_per_hour`、`per_day`、`per_person_per_day`、`cooldown_ms`,各自可省)、`followup`(可省的布林)。`contracts/ext` 多 `schedule.set`、`schedule.cancel`、`schedule.list`(插件到 host)和 `schedule.fire`(host 到插件,通知)的參數形狀(§3.6):`ExtScheduleSetParamsSchema`、`ExtScheduleCancelParamsSchema`、`ExtScheduleListResultSchema`(裡面是 `ExtScheduleEntrySchema`)、`ExtScheduleFireParamsSchema`,都從 `@miyoria/contracts/ext` 匯出。重新產生 `schema/ext.json`。
- `packages/contracts/api/src/core.ts`:`QuotaWorkSchema`(`{ hour: number; day: number; limit_hour: number; limit_day: number; capped: "hour" | "day" | null }`),`QuotaPersonSchema`(管理端)多可省略的 `work`;會員頁的 `MemberQuotaSchema`(`member.ts`)也多可省略的 `work`(同一個形狀,從 `core.ts` import)。
- `packages/contracts/events/src/workspace.ts`:`sandbox.run.finished`(`host`、`cpu_ms`)、`sandbox.session.started`(`host`)、`sandbox.session.closed`(`host`、`cpu_ms`)的 payload 多可省略的欄位(`host` 是可省略、可 `null`);`EventsSandboxKilledReason` 加 `quota`、`disk`、`lost`。
- `packages/types/src/work-quota.ts`、`packages/types/src/sandbox-client.ts`(新),`packages/types/src/files.ts` 加 `MessageFiles`,`packages/types/src/index.ts` 匯出(§3.1–§3.3)。
- `packages/commands/src/nodes.ts`:`WORK_IMAGE = "work.image"` 加進 `WORK_NODES`,`packages/commands/src/index.ts` 匯出(`packages/gate/actions/src/index.ts` 重新匯出 `WORK_DELEGATE` 那一行是 P7 的,P5 要從 `@miyoria/gate/actions` 用時告訴 P7;直接從 `@miyoria/commands` 拿不用)。
- `packages/workspace/sandbox/src/tar-io.ts`(新):`packTree`、`extractTar`、`TarError`(§3.4),和它的測試 `packages/workspace/sandbox/test/tar-io.test.ts`。`sandbox/src/index.ts` 的匯出是 P9 的,所以現在從同套件裡用 `../tar-io.js` / `./tar-io.js`。
- 相依:`tar-stream` 和 `@types/tar-stream` 加到 `packages/workspace/package.json`;`packages/cli/package.json` 的 devDependencies 加 `@miyoria/workspace`(和其他 `@miyoria/*` 一樣,打包時一起 bundle)。`packages/workspace/package.json` 的 `exports` 加 `"./sandbox-service"`(指到 `./sandbox/src/service/index.ts`,P2 寫內容;P1 放一個只有 `export {}` 的檔讓路徑存在)。用 `pnpm add --filter` 加,更新 `pnpm-lock.yaml`。

**擁有**:上面每個檔;`packages/contracts/schema/*.json`;`pnpm-lock.yaml`;`packages/workspace/package.json`;`packages/cli/package.json`;`packages/plugin-host/package.json`(P7 若要新的子路徑,告訴 P1)。

**只讀**:沙箱文件全部。

**測試**:contracts 的既有測試(每個 schema 有 id、產生的 JSON 和檔案一致);`tar-io` 的拒絕案例(`..`、絕對路徑、磁碟代號、反斜線、連結、裝置、太深、太大、項目太多、大小寫重複)和來回一致。

### P2 沙箱服務

**交付**:沙箱文件 §1–§7、§13.3 在服務那台的部分。

- `workers/sandbox/service.toml`、`workers/sandbox/routing.toml`、`workers/sandbox/README.md`、`workers/sandbox/image/Dockerfile`、`workers/sandbox/image/requirements.txt`。
- `packages/workspace/sandbox/src/service/`(新資料夾):
  - `index.ts`:`startSandboxService(options: SandboxServiceOptions): Promise<RunningSandboxService>`(§3.5)。
  - `server.ts`(`node:http`,路由、token、錯誤本體)、`jobs.ts`(工作的狀態機、租約、閒置、預留資源、重啟後接回)、`execs.ts`、`procs.ts`(頻道)、`uploads.ts`、`syncs.ts`、`events.ts`(環形緩衝、游標)、`cpu.ts`(cgroup 和抽樣)、`policy.ts`(讀 `host.toml` 的 `[sandbox]`)、`images.ts`(標籤、建、找舊的)、`disk.ts`(每 5 秒量)、`auth.ts`。
- `packages/workspace/sandbox/src/args.ts`:`ContainerSpec` 加 `homeDir`、`extDir`、`cgroupns`、`tmpExec`、`shmMb`、`runtime`;`buildRunArgs` 照沙箱文件 §2.3。既有的呼叫者不傳這些欄位時參數和今天完全一樣(本地後端靠這個)。
- `packages/workspace/sandbox/src/egress.ts`:`EGRESS_PROGRAM` 加 `EGRESS_MODE`(`open` / `allowlist`)、`EGRESS_DENY_PORTS`、`EGRESS_MAX_CONNECTIONS`、`EGRESS_MAX_BYTES`、名字的拒絕、沙箱文件 §5.2 的整張位址表、`/tmp/egress.json`;`egressNetworkName`、`egressProxyName` 多一個工作編號的版本。沒有這些環境變數時行為和今天一樣。
- `packages/hostd/src/routing.ts`:`loadOf` 多讀 `ready`、`reason`;`serviceRouting` 把它併進去(沙箱文件 §1.3)。`packages/hostd/src/service.ts` 只動 `#readLoad` 需要的地方。
- `packages/cli/src/commands/sandbox.ts`(新):`sandboxServe(options)`、`sandboxBuild(options: { yes: boolean })`、`sandboxDoctorChecks(): DoctorCheck[]`、`sandboxAfterAdd(ctx)`(加完服務後問要不要建映像檔)。命令表的註冊由 P9 做。
- `packages/cli/src/host-toml.ts`:新的 `host.toml` 有 `sandbox` 服務時檔尾加 `[sandbox]` 的註解(和 `UPDATE_HINT` 同樣做法)。

**擁有**:上面每個檔;`packages/workspace/sandbox/test/service/**`、`packages/workspace/sandbox/test/egress.test.ts`、`packages/hostd/test/routing*.test.ts` 裡新加的案例。

**只讀**:`sandbox.ts`、`runner.ts`、`workspace.ts`、`paths.ts`、`semaphore.ts`(重用,不改;要改告訴 P3)、`packages/cluster/src/routed.ts`、`relay.ts`。

**依賴**:P1 的 `@miyoria/contracts/workers`(`Sandbox*` 形狀)、`tar-io.ts`、`HostConfigSchema.sandbox`。

**測試**:沙箱文件 §14 的單元、HTTP、代理、真的 Docker(服務那一側)。`MIYORIA_SANDBOX_IMAGE_TESTS=1` 時用建好的映像檔。

### P3 Core 的沙箱

**交付**:沙箱文件 §9、§10、§13.1–§13.2,和 §4 在 Core 這一側。

- `packages/workspace/sandbox/src/remote/`(新):`client.ts`(`HttpSandboxClient implements SandboxClient`:挑台、`/v1/info` 快取、每台一條事件長輪詢、續租)、`job.ts`(`SandboxJob` 的實作)、`transfer.ts`(§3.4 的 `sendWorkspace`、`receiveWorkspace`)、`remote-sandbox.ts`(`RemoteSandbox implements Sandbox`)、`jobs-store.ts`(`sandbox` store 外掛:`sandbox_jobs` 表和它的 migration)、`proc-stream.ts`(頻道包成 Node 的 `Readable` / `Writable`)、`index.ts`。
- `packages/workspace/sandbox/src/types.ts`:`Language` 多 `"shell"`(模型看到的 `code_run` 的 enum 不變);`KilledReason` 多 `"quota" | "disk" | "lost"`;`SandboxErrorKind` 多 `"not_accepting" | "too_large"`;`RunRequest` 多可省略的 `for`、`payer`(誰的,§3.1;本地後端不看)。
- `config.ts`:沙箱文件 §12.2 的 `[modules.sandbox]` 鍵和新的預設值。
- `module.ts`:`SandboxModuleOptions` 多 `endpoints?: EndpointsOption`;照 `backend` 建 `DockerSandbox` 或 `RemoteSandbox`;叢集後端時 `ctx.provide(SandboxClientKey, client)`。
- `gate.ts`:`codeRunCapability` 改成中風險(`work: true`、`followup: true`),新的 `shellRunCapability`;`setAvailable` 時一起註冊 `shell_run`;沙箱文件 §10.4 的原因;`statusLines` 列每台。P4、P5、P6 的能力的註冊位置留好(§4 的「P3 留的位置」)。
- `capabilities.ts`(`SHELL_RUN`、`ShellRunArgsSchema`)、`format.ts`(`quota`、`disk`、在哪台)、`workspace-gate.ts`(`workspace_run` 經 `RemoteSandbox` 時要的小改動;`workspace_save_script` 的審查說明不變)。
- `packages/gate/actions/src/tools.ts`、`capability.ts`:中風險的 `followup`(沙箱文件 §10.1)。
- `packages/store/scripts/schema-sql.ts`:加 `sandbox` 外掛的那一行。
- `packages/workspace/sandbox/README.md`:改成兩種後端的說明。

**擁有**:上面每個檔(`sandbox.ts` 也是 P3 的,但除了跟著 `types.ts` 的改動以外不動:本地後端照舊);`packages/workspace/sandbox/test/` 裡除了 P2、P4、P5、P6 寫的新檔以外的檔;`packages/gate/actions/test/tools*.test.ts`。

**只讀**:`people.ts`、`workspace-store.ts`、`workspace-totals.ts`(用 `snapshot`、`enforce`、`subdir`、`replaceFolder`)、`packages/cluster/src/registry.ts`、`packages/runtime/kernel/src/endpoints.ts`。

**依賴**:P1 的 `SandboxClient`、`WorkQuota`(§3.1–§3.3)、wire 形狀、`tar-io`。P2 的 HTTP 協定(沙箱文件 §3)。P4 的 `WorkQuota` 實作在執行時由 `WorkQuotaKey` 拿;沒有時不擋也不記(測試用假的)。

**測試**:沙箱文件 §14 的「Core」那幾條;`gate.test.ts` 的 `code_run` 改成不審查;`followup` 的中風險工具在 `inline_wait_ms` 內、外兩種情況。

**做成的樣子和上面不同的地方**(P3,2026-11-27):

- `Language` 沒有加 `"shell"`:它是本地後端每種語言一個映像檔用的型別。另加 `RunLanguage`(`python | node | shell`),`RunRequest.language` 用它;本地後端收到 `shell` 回 `invalid_request`。`NetworkPolicy` 多 `"open"`(照 `[modules.sandbox.network]`:叢集是 `mode`,本地是有設定的白名單或沒有網路)。`SandboxErrorKind` 另外多 `"quota"`。`Sandbox` 多可省略的 `features`(`SandboxFeatures`:在哪、有沒有 shell、網路),閘門照它寫工具說明,換後端時重新註冊。
- `backend = "auto"` 是「叢集裡有一台準備好了就用叢集,沒有就用這台的 Docker」(`remote/auto.ts` 的 `AutoSandbox`),不是「叢集模組在跑就用叢集」:Core 的接線一定給 `endpoints`(叢集模組沒跑時是 Core 自己的 registry),照字面會讓沒有 sandbox 服務的設定失去今天的本地沙箱。叢集的電腦不接(不接成員、滿了、沒準備好)而這台的 Docker 可用時,fresh 的 Python / Node 改在這台跑。
- `sandbox_jobs` 的 Drizzle 定義寫在 `packages/store/scripts/schema-sql.ts` 裡:`packages/workspace` 沒有 `drizzle-orm` 相依(不加相依),所以 `jobs-store.ts` 用 `Db` 的純 SQL 讀寫;drift 測試照常比對。`payer` 欄存 JSON(`{ person, exempt? }`),重啟後 owner 的 `exempt` 才不會不見。
- `trusted_hosts` 照沙箱文件 §12.2 放在 `[modules.sandbox.transfer]`(P8 讀 `config.transfer.trusted_hosts`)。`[modules.sandbox.workspace] max_mb` 的預設沒有跟著 `person_max_mb` 調高(32 GiB 是 Core 磁碟的上限,不是預先佔用)。
- P4、P5、P6 的註冊位置是 `SandboxGateOptions` 的兩個掛鉤 `extraWorkspace(o)`、`extraAvailable(features)`,P9 在 `module.ts` 傳進去,不改 `gate.ts`。
- `workspace_run`、她的工具都經 `Sandbox.run`;有 `workspace_folder` 的執行一律當成成員的(`for: "member"`),那個人的檔案只會送到主人接成員工作的電腦。
- 協定上沙箱文件沒寫死、Core 這邊選了的(分段從 0 起、`x-delete` 標頭、第一次長輪詢不帶 `after` 拿到留著的全部、shell 的 `cwd` 是 `/workspace`)寫在 `.tmp-test/handoff-P3.md` 的 A 節;P2 的服務照同樣的做法。
- 沒做的:Core 重啟時跑到一半的 exec 不接回(表沒有 exec 欄,工作階段本身接回);完整輸出(`GET .../log`)還沒存進 `outputs/`;`shell` 的執行在事件的語言清單加上 `shell` 之前不發 `sandbox.run.finished`。

### P4 額度、附件、分享

**交付**:沙箱文件 §8、§11。

- `packages/brain/selfhost/src/work-quota.ts`(新):`hostWorkQuota(agent: Agent, quiet: LocalTime | null): WorkQuota`,包 `PersonQuota` 和加前綴的 `QuotaBook`。
- `packages/brain/selfhost/src/quota-store.ts`:`dayTotals` 不回 `~` 開頭的列。
- `packages/brain/selfhost/src/message-files.ts`(新):`MessageFilesBook implements MessageFiles`(最近的輸入檔案,依訊息,最多 256 則、30 分鐘)和 `recordRunFiles(book, inputs)`(P9 在 `around.ts` 呼叫)。
- `packages/brain/agent/src/config.ts`:`QuotaConfigSchema` 加 `person_cpu_seconds_per_hour`、`person_cpu_seconds_per_day`。
- `packages/api/src/quota.ts`:管理端和會員頁的 `work`。
- `packages/workspace/sandbox/src/attach.ts`(新):`workspaceAttachCapability(o: WorkspaceAttachOptions): Capability`(§3.5)。
- `packages/workspace/sandbox/src/workspace-export.ts`:型別放寬、`export_max_kb` 用新的預設。
- `packages/gate/actions/src/share.ts`、`zip.ts`(`ZIP_MIMES` 加 OpenDocument 和 epub)、`tar.ts`(新,`inspectTar`)、`config.ts`(`ShareConfigSchema.max_bytes` 預設 0 = 平台的上限)。
- `packages/store/src/artifacts/media.ts`:`sniff` 認得 gzip、tar(store 收這些型別)。

**擁有**:上面每個檔和它們的測試。

**只讀**:`packages/brain/self/src/quota.ts`(`PersonQuota`、`capMinutes`)、`packages/brain/selfhost/src/quota.ts`(`personKey`、`payerOfAuthor`)、`files.ts`(`allowedHost`、下載的做法)。

**依賴**:P1 的 `WorkQuota`、`MessageFiles`、`api` 的額度形狀。

**測試**:額度的前綴不會出現在 AI 額度的管理頁;CPU 秒的滾動一小時和她的一天;到上限只說一次;`workspace_attach` 只從允許的主機、量著下載、寫進那個人的 `inbox/`;`share` 的 tar / tgz / ods 收、7z 拒絕並說原因、她自己做的 zip 可以給、`max_bytes = 0` 照平台的上限、超過給連結。

**實作時和上面不同的地方(P4,2026-11-27)**

- `tar.ts` 是自己寫的唯讀解析(`inspectTar`、`inspectGzip`、`isTar`、`isGzip`、`isUnreadableArchive`),沒有用 `tar-stream`:`@miyoria/gate` 沒有這個依賴,也不能 `pnpm install`;自己讀才能照 zip 的規則逐項拒絕(檢查碼、padding 裡藏東西、結尾之後的資料、連結、裝置、重複的名字、超過上限)。單一 `.gz` 和 `tar.gz` 都走 `inspectGzip`(先在上限內解開,而且 gzip 後面不能還有資料)。7z、rar、xz、bzip2、zstd、lzip 一律拒絕並說「改用 zip」。
- `ZIP_MIMES` 也加了 tar 和 gzip(不只 OpenDocument 和 epub):`api/src/files/links.ts` 用它決定哪些型別要讀過全部才做連結,不加的話 tar / gz 的連結會沒檢查就發出去。`checkContent` 多回一個 `say`(她要照著說的那一句);`owner` 參數留著但不再用。
- `media.ts` 的 `SNIFF_BYTES` 從 64 改成 512(tar 的 `ustar` 在第 257 個位元組);原來在頭 64 個位元組裡找 `theora`、`webm` 的搜尋範圍不變。
- `workspace_attach` 不走 `WorkspaceApi.write`(只收文字):它要求 `workspace` 是 `PersistentWorkspace`,用 `subdir(people/<資料夾>)` 和 `subdir("inbox")` 拿到資料夾,下載串流寫進暫存檔再 `rename`;額度照那個人的資料夾(`PersonLimits`)。不是 `PersistentWorkspace` 時回「工作區現在不能收檔案」。
- 沒有放在 `selfhost` 的 `workCapLine`:到上限的那一句在 `packages/workspace/sandbox/src/work-line.ts`(`workCapLine`、`WORK_CUT_LINE`),因為用它的是 P3 的閘門和 client,沙箱套件不依賴 agent 套件。
- `QuotaStore` 多一個 `dayTotalsUnder(day, prefix)`(`PrefixedBook` 用),`forgetPerson` 連 `~cpu:` 的列一起刪(「忘了我」本來只刪 AI 額度的列)。
- `api/src/quota.ts` 的 `work.capped` 由數字算,不叫 `WorkQuota.capped`:那個會把這段時間標成「已經擋過」,管理頁一讀就會吃掉她要說的那一句。
- `MessageFilesBook` 記每一則非 bot 的輸入(沒附檔也記,當作回頭找的錨),不管 `[modules.agent.files]` 開不開。

### P5 第三批的工具

**交付**

- `packages/workspace/sandbox/src/workspace-edit.ts`(新):`workspaceEditCapabilities(o: WorkspaceGateOptions): Capability[]`,兩個能力:
  - `workspace.edit`(工具 `workspace_edit`,中風險、`work`):`{ path, old, new, replace_all? }`,完全相同的字串取代;`old` 找不到或找到不只一個(沒有 `replace_all`)時不改,回找到幾個。寫入走 `WorkspaceApi.write`(額度和路徑檢查照舊)。
  - `workspace.grep`(工具 `workspace_grep`,低風險、`readOnly`):`{ pattern, regex?, path?, glob?, max_results? }`。預設是一般字串;`regex: true` 時在 `node:worker_threads` 裡跑,2 秒沒跑完就終止並回「這個樣式太慢」(模型給的正規表示式可能是故意寫成會卡住的)。只看那個呼叫碰得到的範圍(`workspaceFor`),每檔最多 2 MiB 的文字、合計 64 MiB、結果最多 200 行,每行附檔名和行號,結果框成不可信資料。
- `packages/workspace/imagegen/src/tool.ts`(新)和 `module.ts`:`image.make`(工具 `image_make`,中風險、`work`、`followup`,節點 `work.image`):`{ prompt, model?, variant?, size? }` → `ImageGen.submit` → `wait` → `ingestImageOutput`(做給開口的人、在這次的地方)→ 結果附 `images`(給她看)和產物的編號(`share` 用)。imagegen 模組自己在 `actuatorsFor(ctx)` 註冊,ComfyUI 不在(`status().reachable` 是 false)時撤掉,和沙箱的做法一樣。
- 排程開工作:`packages/brain/selfhost/src/initiative-schema.ts`、`initiative-migrations.ts`(第 3 個 migration:`ALTER TABLE initiative_schedules ADD job text`,只加欄位;`source` 的 CHECK 不能改,所以用新欄位,`source` 照舊是 `schedule`)、`initiative-store.ts`、`schedule.ts`、`schedule-tools.ts`(`schedule` 工具多可省略的 `job: { kind: "worker" | "research", goal, budget? }`)、`initiative.ts`(`#dueSchedules` 遇到有 `job` 的列:用注入的 `ScheduledJobs.start`(§3.7)開工作,`from` 是 `for_account`,所以算那個人的資料夾、羈絆和額度;開不了時照舊叫醒她,附上原因)。

**擁有**:上面每個檔和它們的測試。

**只讀**:`workspace-gate.ts`、`people.ts`、`packages/types/src/imagegen.ts`、`packages/workspace/imagegen/src/artifact.ts`、`packages/brain/self/src/delegate.ts`(`Delegator.start`、`StartSpec`)。

**依賴**:P1 的 `WORK_IMAGE`;P3 的 `gate.ts` 留的註冊位置(P9 接上)。

**測試**:edit 的唯一性、取代全部、額度滿了;grep 的範圍(成員看不到別人的資料夾)、慢的正規表示式被終止;`image_make` 對假的 `ImageGen`;排程到了開工作、算到對的人、開不了時叫醒她;migration 3 只加欄位(store 的 drift 測試)。

**做成的樣子(與上面不同的地方)**

- `workspace_edit`、`workspace_grep` 都用 `sandbox.workspace` 這個節點(跟 `workspace_write` 一樣,羈絆到 `work_min_bond` 就算);`image_make` 用 `work.image`。grep 多一個可省略的 `ignore_case`。單檔上限用工作區自己的 `maxFileBytes`(edit 讀整個檔案、取代、再 `WorkspaceApi.write`)。正規表示式的 2 秒是所有檔案加起來、只算 worker 裡的時間(讀檔不算);超過就終止 worker,回已找到的和「太慢」。
- `image_make` 的 `meta.speed` 是 `instant`(跟 `workspace_run` 一樣,在呼叫裡等到畫好),最多等 3 分鐘,等不到就取消那張的工作並照實說;`size` 是 `square`、`portrait`、`landscape` 或 `寬x高`。工作的 `purpose` 是 `agent`(每日張數限制可用 `[modules.imagegen] daily_limits = { agent = N }`)。模組每 30 秒看一次 ComfyUI,`reachable` 才在 `actuatorsFor(ctx)` 註冊,不通就撤掉;呼叫時 ComfyUI 剛好斷了也回原因。
- 排程開工作:`Initiative` 多一個 `useJobs(jobs)`(測試和晚綁定用),選項 `jobs` 跟 §3.7 一樣。`schedule` 帶 `job` 時 `permissionFor` 對 `worker` 回 `work.delegate`(設的時候就過橋接的檢查);到時間開工作的那一刻不再查羈絆。開成功就不叫醒她(工作自己的結果會叫),開不成才叫醒並附原因。`MindReminder fired` 事件對有 `job` 的排程不再加 timer 項目(由 `tick` 決定)。`initiative-spaces.test.ts` 的 migration 期望改成 `[2, 3]`。

### P6 瀏覽器

**交付**

- `workers/sandbox/image/browser/Dockerfile`:`FROM mcr.microsoft.com/playwright:v<版本>-noble`(版本和 `package.json` 的 `playwright-core` 一樣,釘 digest),複製驅動,`npm ci --omit=dev`,`LABEL miyoria.sandbox.image="browser" miyoria.sandbox.contract="1"`,`CMD ["sleep", "infinity"]`。`workers/sandbox/image/browser/package.json`、`package-lock.json`、`driver.mjs`。
- 驅動(`driver.mjs`,在容器裡跑的 proc):stdin / stdout 上用 `Content-Length` 框的 JSON-RPC。方法:`browse.open { url, wait? }`、`browse.act { action: "click" | "type" | "press" | "select" | "scroll" | "back" | "wait", ref?, selector?, text?, value? }`、`browse.read { mode: "text" | "links" | "outline", max_chars? }`、`browse.shot { full_page? }`(PNG,寬最多 1280,最多 2 MiB,base64)。Chromium 用 `proxy: { server: "http://egress-proxy:3128" }` 啟動;下載存到 `/workspace/downloads/`。回應裡的頁面內容是不可信資料,由 Core 框起來。每個可以操作的元素給一個短的 `ref`(`e12`),`act` 用它。
- `packages/workspace/sandbox/src/browse/`(新):`sessions.ts`(每個人每個名字一個 `browser` 工作,閒置 15 分鐘關;用 `SandboxClient.open` 和 `job.proc`,上面用 sdk 的 `RpcPeer` + `StreamTransport`)、`capabilities.ts`(`browseCapabilities(o: BrowseOptions): Capability[]`:`browse.open`、`browse.read`、`browse.shot` 低風險,`browse.act` 中風險、`work`;`browse_shot` 的結果放在 `ActionResult.images`;關掉時把 `/workspace` 的改動收回來,用 P3 的 `receiveWorkspace`)、`config.ts`(`BrowseConfigSchema`:`[modules.sandbox.browser] enabled = true, idle_minutes = 15, lifetime_minutes = 120, memory_mb = 2048, cpus = 2`)、`index.ts`。

**擁有**:上面每個檔;`packages/workspace/sandbox/test/browse/**`。

**只讀**:沙箱文件 §3.7;P3 的 `remote/`。

**依賴**:P1 的 `SandboxClient`(§3.3);P2 的 `procs` 和 `browser` 映像檔角色;P3 的 `receiveWorkspace`(§3.4)。

**測試**:工具對假的 `SandboxClient`(proc 是一個在測試裡跑的假驅動);驅動本身的測試在真的 Docker 測試裡(要建瀏覽器映像檔:`MIYORIA_SANDBOX_IMAGE_TESTS=1`),開一個測試伺服器的頁面、點、讀、截圖,確認連不到 `172.17.0.1`。

### P7 插件和外部工具走閘門

**交付**

- `packages/gate/actions/src/external.ts`(新):`externalToolCapability(spec: ExternalToolSpec): Capability<JsonObject>`(§3.6)。`work.ts`:`isWorkNode` 把 `tools.ext.`、`tools.mcp.`、`tools.http.` 開頭的節點也當做事的節點(羈絆到 `work_min_bond` 就有)。`index.ts` 匯出。
- 插件的工具:`packages/plugin-host/ext-host/src/extension.ts` 的 `Session.registerTool` 改成把工具包成能力、註冊進 `ActuatorRegistry`(`actuatorsFor`),名字照舊是 `registryToolName(decl.name)`(舊的呼叫照樣可以),能力名 `ext.<id>.<wire name>`,節點 `decl.permission ?? "tools.ext.<id>"`,風險、`work`、次數、`followup` 照 `decl`(沒寫就是中風險);`game_<id>_*` 照舊進 `GatedToolsKey`。`config.ts`:`[extensions."<id>"]` 多 `run_in`(`"host" | "sandbox"`,預設見沙箱文件 §16 第 3 題)、`secrets`(字串陣列)、`tools."<name>".risk`(owner 改風險)。`manifest.ts`:讀新的欄位。`launch.ts`(新):`ChildLike`、`ExtensionLauncher`、`localLauncher()`(§3.8);`ExtensionModule.start` 改用 `services.get(ExtensionLauncherKey) ?? localLauncher()`。
- 插件的排程和背景工作:`packages/plugin-host/ext-host/src/schedules.ts`(新):`schedule.set { id, at | daily, payload }`、`schedule.cancel`、`schedule.list`,存在 `SettingsStore`(鍵 `ext:<id>:schedule:<sid>`,不用 migration),到了送 `schedule.fire` 通知給插件;每個插件最多 32 個。背景工作用現有的 `tasks.*`(`ext-host/src/tasks.ts`),範本示範。
- MCP:`packages/plugin-host/mcp/src/`:`McpTool` 改成能力(`mcp.<server>.<tool>`,節點照舊 `tools.mcp.<server>`,`readOnlyHint` 而且 `trust_read_only_hint` 時低風險,其他中風險;`[mcp.servers.<name>] risk` 可以改);插件附的 MCP 伺服器(`CatalogMcpServer`,`ext-host/src/host.ts`)真的接上:經 `ExtensionLauncher` 開 stdio 程序,`child-transport.ts`(新)把 `ChildLike` 包成 MCP SDK 的 `Transport`(一行一個 JSON)。
- 宣告式 HTTP 工具:`packages/workspace/web/src/http-tools/`(新:`schema.ts`、`load.ts`、`call.ts`、`module.ts`)和 `packages/workspace/web/src/index.ts` 的匯出。每個 `*.toml` 一個工具:`name`、`description`、`risk`、`method`、`url`(可以有 `{參數}`)、`[params.<name>]`(`type`、`description`、`required`、`enum`)、`[headers]`(值可以有 `{secret:NAME}`)、`[body]`(`format = "json" | "form"`)、`[response]`(`format = "json" | "text"`、`pick`、`max_chars`)、`[limits]`。從 `[modules.http_tools] dirs`(預設 `["tools/http"]`)和插件資料夾的 `http-tools/` 讀;密鑰只從 Core 的環境、只限 `[modules.http_tools] secrets` 列的名字,從不給模型看。請求用 `net.ts` 的 `checkUrl`、`resolvePublic`、`pinnedTransport`(擋內網),回應框成不可信資料。每個工具是 `externalToolCapability`,節點 `tools.http.<name>`。
- `ext new` 範本:`packages/plugin-host/ext-host/src/cli.ts` 的 `newExtension` 寫出一個十幾行的 `index.mjs`(一個工具、`risk: "low"`),`packages/sdk/src/extension.ts` 的 `ToolDefinition` 多 `risk`、`work`、`limits`,`toolDecl` 帶過去。

**擁有**:上面每個檔;`packages/plugin-host/ext-host/test/**`、`packages/plugin-host/mcp/test/**` 的新案例;`packages/workspace/web/src/http-tools/**` 和它的測試;`packages/sdk/src/extension.ts`。

**只讀**:`packages/gate/actions/src/registry.ts`、`capability.ts`(P3 改 `followup` 的說明,P7 只讀)、`packages/workspace/web/src/net.ts`。

**依賴**:P1 的 `ExtToolDeclSchema` 新欄位、`schedule.*` 形狀。

**測試**:插件工具經閘門(次數、稽核、`on_own`、成員到 `work_min_bond` 叫得到、不到時看到 `WORK_BELOW_BOND`);舊的插件(沒寫風險)照樣能用;MCP 工具同上;插件附的 MCP 伺服器經 `localLauncher` 接上;HTTP 工具:參數驗證、`{secret:}` 只換在標頭、私有位址被擋、`pick`;插件排程到了送 `schedule.fire`;`miyoria ext new` 產生的範本能跑起來(現有的 `ext-hello` 測試的做法)。

### P8 插件的程序進沙箱

**交付**

- `packages/plugin-host/ext-host/src/sandbox-launch.ts`(新):`sandboxLauncher(o: SandboxLauncherOptions): ExtensionLauncher`(§3.8)。`run_in = "sandbox"` 的插件:`client.open({ kind: "plugin", image: "default", for: "plugin", payer: null, network, env, lifetime_s: 0 })` → `job.upload("ext", { dir: spec.dir })` → `job.proc("main", { argv: [runtime, "/ext/<entry>"], cwd: "/ext" })` → 包成 `ChildLike`。`run_in = "host"` 或沒有能接插件的電腦(`available("plugin")` 不 ok):照 owner 的決定(§16 第 3 題),預設回到 `localLauncher()` 並寫一行警告。
  - 網路:插件宣告了 `network` 就是 `allowlist`(那些主機),沒宣告就是 `open`。
  - 環境:`extensionEnv`(`ext-host/src/env.ts`)給的那些,加上 `secrets` 裡 owner 同意的;其他什麼都不給。有 `secrets` 的插件只送到 `trusted_hosts`(§16 第 3 題)。
  - 工作不見了(那台斷線、租約):`exited` resolve,`ExtensionModule` 照現在的方式當成程序結束,kernel 的 Supervisor 重啟它,新的工作可能在別台。
- 插件附的 MCP 伺服器:插件在沙箱裡時,它的 MCP 伺服器在同一個工作裡用另一個 `proc` 跑(`job.proc("mcp-<name>", …)`),P7 的 `child-transport.ts` 照樣接得上。`SandboxLauncher` 多一個 `launchInSame(extension: string, spec: LaunchSpec)`(§3.8)。

**擁有**:`sandbox-launch.ts` 和它的測試 `packages/plugin-host/ext-host/test/sandbox-launch.test.ts`。

**只讀**:`extension.ts`、`env.ts`、`launch.ts`(P7 的)、沙箱文件 §3.7。

**依賴**:P1 的 `SandboxClient`、`SandboxProc`;P7 的 `launch.ts`(§3.8 的形狀);P2、P3 做端到端。

**測試**:對假的 `SandboxClient`:上傳插件資料夾、開 proc、經 `ChildLike` 跑完 `initialize` 握手(用 `ext-hello`)、工作不見了模組重啟、`secrets` 只到 `trusted_hosts`、沒有電腦時回到主機。真的 Docker 的一個案例(`ext-hello` 在沙箱裡註冊一個工具、被呼叫一次)。

### P9 整合

**交付**:§4 的每個熱點檔、§5 的清單、`miyoria.example.toml` 兩份(byte 完全一樣)、文件、全部的測試。見 §4、§5。

## 3. 介面

### 3.1 工作額度(P1 定義,P4 實作,P3 用)

```ts
// packages/types/src/work-quota.ts
import type { Principal } from "./actuator.js";
import { serviceKey } from "./service-key.js";

/** 付錢的人:人的鍵(person id,不認識的人是 platform:id),owner 記帳不受限。 */
export interface WorkPayer {
  person: string;
  exempt?: boolean;
}

export interface WorkCap {
  which: "hour" | "day";
  /** 她的時鐘上,不再超過的時間(epoch ms)。 */
  until: number;
  /** 這段時間第一次被擋(要說那一句)。 */
  first: boolean;
  limit: number;
  used: { hour: number; day: number };
}

/** 每人的沙箱 CPU 秒數(docs/design/v6-sandbox.md §8)。 */
export interface WorkQuota {
  /** 這次呼叫算誰的;她自己的(沒有 requester)是 null。 */
  payerOf(principal: Principal): WorkPayer | null;
  /** 到上限了嗎;null:沒有,或 exempt,或 payer 是 null。 */
  capped(payer: WorkPayer | null, now: number): WorkCap | null;
  /** 記上 cpuSeconds。payer 是 null 時不記。 */
  charge(payer: WorkPayer | null, now: number, cpuSeconds: number): void;
  /** 這段時間的那一句,第一次拿到 true。 */
  claimNotice(person: string): boolean;
  used(person: string, now: number): { hour: number; day: number };
  rules(): { cpuSecondsPerHour: number; cpuSecondsPerDay: number };
}

export const WorkQuotaKey = serviceKey<WorkQuota>("WorkQuota");
```

### 3.2 訊息的檔案(P1 定義,P4 實作和用)

```ts
// packages/types/src/files.ts(加在後面;MessageRef 從 ./platform.js import)
export interface MessageFiles {
  /**
   * `message` 附的檔案,和同一個人在同一個地方 `withinMs`(預設 10 分鐘)內的訊息附的,新的在前。
   * 只有 selfhost 看過的訊息。
   */
  filesOf(message: MessageRef, options?: { withinMs?: number }): FileRequest[];
}
export const MessageFilesKey = serviceKey<MessageFiles>("MessageFiles");
```

### 3.3 沙箱的 client(P1 定義,P3 實作,P6、P8 用)

```ts
// packages/types/src/sandbox-client.ts
import type { Readable, Writable } from "node:stream";
import { serviceKey } from "./service-key.js";
import type { WorkPayer } from "./work-quota.js";

export type SandboxFor = "self" | "owner" | "member" | "plugin";
export type SandboxJobKind = "run" | "session" | "browser" | "plugin";

export interface SandboxJobSpec {
  kind: SandboxJobKind;
  image: "default" | "browser";
  for: SandboxFor;
  payer: WorkPayer | null;
  /** 工作階段的名字、插件的 id;只給人看。 */
  label?: string | null;
  /** 沒寫的照 [modules.sandbox] 的預設。 */
  limits?: Partial<{ cpus: number; memory_mb: number; pids: number; tmp_mb: number;
                     file_mb: number; disk_mb: number; nofile: number }>;
  network?: { mode: "open" | "allowlist" | "none"; allow?: string[] };
  lifetime_s?: number;
  idle_s?: number;
  mounts?: { tools?: boolean; ext?: boolean };
  env?: Record<string, string>;
  /** 只送到這幾台(有密鑰的插件,§16 第 3 題);沒寫:哪台都可以。 */
  hosts?: readonly string[];
}

export interface SandboxExecStart {
  program?: { language: "python" | "node" | "shell"; code: string };
  argv?: string[];
  stdin?: string;
  files?: { path: string; content: string; encoding?: "utf8" | "base64" }[];
  cwd?: "/work" | "/workspace";
  timeout_ms: number;
  env?: Record<string, string>;
  collectFiles?: boolean;
}

export interface SandboxExecResult {
  exit_code: number | null;
  killed_reason: "timeout" | "aborted" | "output_limit" | "memory" | "quota" | "disk" | "lost" | null;
  duration_ms: number;
  cpu_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  files_out: { path: string; size: number; encoding: "utf8" | "base64"; content: string }[];
  files_out_truncated: boolean;
  /** 完整輸出(比 stdout / stderr 長時才有用)。 */
  log(): Promise<string>;
}

export interface SandboxProc {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): Promise<void>;
}

export interface SandboxJob {
  readonly id: string;
  /** 在哪台。 */
  readonly host: string;
  readonly kind: SandboxJobKind;
  /** 把 Core 這邊的一個資料夾送進去(tar,分段)。 */
  upload(
    target: "workspace" | "tools" | "ext" | "work",
    source: { dir: string; skip?: (relativePath: string) => boolean },
    options?: { replace?: boolean; signal?: AbortSignal },
  ): Promise<{ files: number; bytes: number; skipped: { path: string; why: string }[] }>;
  /** 一次執行;工作裡同時只有一個,其他的在 Core 排隊。 */
  exec(
    start: SandboxExecStart,
    options?: { signal?: AbortSignal; onOutput?: (stream: "stdout" | "stderr", text: string) => void },
  ): Promise<SandboxExecResult>;
  /** 一個背景程序(只在 browser、plugin 的工作裡)。 */
  proc(id: string, start: { argv: string[]; cwd?: "/work" | "/workspace" | "/ext"; env?: Record<string, string> }): Promise<SandboxProc>;
  usage(): Promise<{ cpu_ms: number; wall_ms: number; disk_bytes: number }>;
  close(): Promise<void>;
  /** 工作結束時 resolve(包括被關、不見了)。 */
  readonly ended: Promise<{ reason: string }>;
}

export interface SandboxClient {
  /** 現在有沒有電腦會接 `forWho` 的工作;沒有的話是哪一種、原因(她看得懂的一句)。 */
  available(forWho: SandboxFor): { ok: true } | { ok: false; code: "no_machine" | "not_accepting" | "busy"; reason: string };
  open(spec: SandboxJobSpec, options?: { signal?: AbortSignal }): Promise<SandboxJob>;
  /** 能用的電腦變了。 */
  watch(onChange: () => void): () => void;
}

export const SandboxClientKey = serviceKey<SandboxClient>("SandboxClient");
```

`open` 失敗時丟 `SandboxClientError`(P3 定義在 `remote/client.ts`,`code` 是 §3.3 的 `available` 的那幾種加 `too_large`、`quota`、`unavailable`)。

### 3.4 檔案進出(P1 的 tar-io;P3 的 transfer,P6 用)

```ts
// packages/workspace/sandbox/src/tar-io.ts(P1)
export interface PackedEntry { path: string; size: number; sha256: string; mtime_ms: number }
export interface PackOptions {
  /** 相對路徑,`/` 分隔;回 true 的不收(`people/` 之類呼叫者自己決定不送的;資料夾連裡面的都不收)。不收的不算 `skipped`。 */
  skip?: (relativePath: string) => boolean;
  gzip?: boolean;
  limits: { maxFiles: number; maxBytes: number; maxFileBytes: number };
}
/**
 * 走 `dir`,只收一般檔案和資料夾(逐段 lstat),打成 tar;邊打邊給位元組。路徑不合 `normalizeRelativePath`、大小寫以外相同的名字、超過 `maxFileBytes` 的單檔進 `skipped`;檔案數或總位元組超過 `maxFiles`、`maxBytes` 時在給出第一個位元組之前以 `TarError`(`too_many_files`、`too_large`)失敗(`done` 也 reject)。`mtime_ms` 是整秒(tar 只存整秒)。`SandboxJob.upload` 的 `skip` 同一個意思(true = 不送)。
 */
export function packTree(dir: string, options: PackOptions): {
  stream: AsyncIterable<Uint8Array>;
  /** stream 讀完後 resolve。 */
  done: Promise<{ entries: PackedEntry[]; skipped: { path: string; why: string }[]; bytes: number; sha256: string }>;
};
export interface ExtractOptions {
  gzip?: boolean;
  limits: { maxFiles: number; maxBytes: number; maxFileBytes: number; maxDepth: number };
  /** 已經存在的同名檔:取代(先刪再以 O_EXCL 寫),或改名留著(衝突)。 */
  onExisting?: (relativePath: string) => "replace" | "keep-as-conflict";
  /** 衝突名字用的時鐘(epoch ms);測試用,預設 `Date.now`。 */
  now?: () => number;
}
/**
 * 把 tar 解進 `dir`(要先存在):只收一般檔案和資料夾,路徑過 normalizeRelativePath(開頭的 `./` 接受),不照 tar 裡的權限,不穿過已經在那裡的連結,不收的進 `skipped`。超過 `maxFiles`、`maxBytes`、解壓後的總量,或 tar 讀不了,丟 `TarError`(`code`:`too_many_files` | `too_large` | `corrupt`)。`keep-as-conflict`:舊的搬到 `<檔名>.conflict-<時間>`,新的放在原來的路徑,`conflicts` 列搬過去的名字。
 */
export function extractTar(source: AsyncIterable<Uint8Array>, dir: string, options: ExtractOptions): Promise<{
  written: PackedEntry[]; skipped: { path: string; why: string }[]; conflicts: string[];
}>;
```

```ts
// packages/workspace/sandbox/src/remote/transfer.ts(P3)
import type { SandboxJob } from "@miyoria/types";
import type { WorkspaceScope } from "../people.js";
import type { CountedWorkspace } from "../workspace-totals.js";
import type { Removed, WorkspaceLimits } from "../workspace-store.js";
import type { PackedEntry } from "../tar-io.js";

/** 一個呼叫碰得到的工作區:整個(owner)、扣掉 people/(她自己)、一個人的資料夾。 */
export interface CallWorkspace {
  root: CountedWorkspace;
  scope: WorkspaceScope;
  /** scope 是 person 時的資料夾名。 */
  folder: string | null;
  limits: WorkspaceLimits;
}
export type Manifest = PackedEntry[];
/** 開工作後第一次:整個送進 /workspace(replace)。 */
export function sendWorkspace(job: SandboxJob, ws: CallWorkspace, signal?: AbortSignal): Promise<Manifest>;
/** exec 前:Core 這邊從 `last` 之後改的先送進去。 */
export function pushChanges(job: SandboxJob, ws: CallWorkspace, last: Manifest, signal?: AbortSignal): Promise<Manifest>;
/** exec 後:收回改動、enforce、replaceFolder(沙箱文件 §4.3、§4.4)。 */
export function receiveWorkspace(job: SandboxJob, ws: CallWorkspace, last: Manifest, signal?: AbortSignal): Promise<{
  manifest: Manifest; removed: Removed[]; conflicts: string[];
}>;
```

`receiveWorkspace` 需要 `SandboxJob` 上 P3 自己的擴充(`sync`):`remote/job.ts` 的實作類別有,型別上 P3 用 `RemoteJob extends SandboxJob`。

### 3.5 Core 這邊的能力工廠(P4、P5、P6 交出,P9 在 P3 的 `gate.ts` 註冊)

```ts
// P4 packages/workspace/sandbox/src/attach.ts
export interface WorkspaceAttachOptions {
  workspace: WorkspaceApi;
  people: PersonLimits;
  maxBytes: number;                 // [modules.sandbox.workspace] max_file_kb × 1024
  allowedHosts: readonly string[];  // [modules.sandbox.files] allowed_hosts
  downloadTimeoutMs: number;
  fetch?: FetchLike;                // files.ts 的
}
export function workspaceAttachCapability(o: WorkspaceAttachOptions): Capability;

// P5 packages/workspace/sandbox/src/workspace-edit.ts
export function workspaceEditCapabilities(o: WorkspaceGateOptions): Capability[];

// P6 packages/workspace/sandbox/src/browse/capabilities.ts
export interface BrowseOptions {
  client: SandboxClient;
  quota: WorkQuota | null;
  workspace: WorkspaceApi | null;
  people: PersonLimits;
  config: BrowseConfig;             // BrowseConfigSchema 的輸出
  resultChars: number;
}
export function browseCapabilities(o: BrowseOptions): { capabilities: Capability[]; close(): Promise<void> };

// P2 packages/workspace/sandbox/src/service/index.ts
export interface SandboxServiceOptions {
  host: string;                     // HOST
  port: number;                     // PORT
  hostToml: string;                 // SANDBOX_HOST_TOML
  state: string;                    // SANDBOX_STATE
  imageDir: string;                 // SANDBOX_IMAGE_DIR
  token: string | null;             // MIYORIA_SERVICE_TOKEN
  hostToken: string | null;         // MIYORIA_HOST_TOKEN
  docker?: string;                  // 預設 "docker"
  runner?: DockerRunner;            // 測試注入
  clock?: Clock;
}
export interface RunningSandboxService { readonly url: string; close(): Promise<void> }
export function startSandboxService(options: SandboxServiceOptions): Promise<RunningSandboxService>;
```

### 3.6 外部工具走閘門(P7)

```ts
// packages/gate/actions/src/external.ts
export interface ExternalToolSpec {
  /** "ext.<id>.<wire>"、"mcp.<server>.<tool>"、"http.<name>"。 */
  capability: string;
  /** 工具在 registry 裡的名字(舊的名字照舊)。 */
  tool: string;
  summary: string;
  description: string;
  /** JSON Schema 的 object(閘門另外加 why、on_own)。 */
  parameters: JsonObject;
  risk: Risk;
  permission: string;
  group: "extension" | "mcp" | "http";
  readOnly?: boolean;
  work?: boolean;
  followup?: boolean;
  limits?: Partial<Limit>;
  /** 高風險時審查看的。 */
  guidance?: string;
  call(args: JsonObject, ctx: ExecContext): Promise<{ text: string; data?: JsonValue; framed?: boolean }>;
}
export function externalToolCapability(spec: ExternalToolSpec): Capability<JsonObject>;
```

插件的排程(`contracts/ext` 的形狀,P1):

```ts
export interface ExtScheduleSetParams {
  id: string;                         // ^[a-z0-9][a-z0-9_-]{0,47}$
  at?: number;                        // epoch ms,一次
  daily?: string;                     // "HH:MM",她的當地時間
  payload?: JsonValue;                // 最多 4 KiB,原樣送回
}
export interface ExtScheduleFireParams { id: string; payload: JsonValue | null; due: number }
```

### 3.7 排程開工作(P5)

```ts
// packages/brain/selfhost/src/initiative.ts 收的選項
export interface ScheduledJobs {
  /** Delegator.start 的子集;P9 在 host.ts 傳 jobs.ts 的 delegator。 */
  start(spec: StartSpec): StartOutcome;
}
```

### 3.8 插件的程序(P7 定義,P8 實作沙箱的)

```ts
// packages/plugin-host/ext-host/src/launch.ts(P7)
import type { Readable, Writable } from "node:stream";

export interface ChildLike {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: NodeJS.Signals): void;
  readonly where: { kind: "host" } | { kind: "sandbox"; host: string; job: string };
}

export interface LaunchSpec {
  extension: string;                  // id
  dir: string;                        // Core 這邊的資料夾
  runtime: "node" | "deno" | "bun" | "binary";
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;        // extensionEnv 的結果
  network: readonly string[];         // granted.network
  secrets: Readonly<Record<string, string>>;
  runIn: "host" | "sandbox";
}

export interface ExtensionLauncher {
  launch(spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike>;
  /** 同一個插件的另一個程序(它附的 MCP 伺服器),跑在同一個地方。 */
  launchInSame?(extension: string, spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike>;
}

export const ExtensionLauncherKey = serviceKey<ExtensionLauncher>("ExtensionLauncher");

/** 今天的做法:spawn,shell: false,過濾過的環境。 */
export function localLauncher(): ExtensionLauncher;
```

```ts
// packages/plugin-host/ext-host/src/sandbox-launch.ts(P8)
export interface SandboxLauncherOptions {
  client: SandboxClient;
  /** 有 secrets 的插件只送到這幾台。 */
  trustedHosts: readonly string[];
  /** 沒有電腦接插件時:回到主機(預設)或讓插件啟動失敗。 */
  fallback: "host" | "fail";
  local?: ExtensionLauncher;
}
export function sandboxLauncher(o: SandboxLauncherOptions): ExtensionLauncher;
```

## 4. 熱點檔

每個熱點只有一個擁有者。沒有列的檔,看 §2 每一包的「擁有」。

| 檔 | 擁有 | 誰需要什麼 |
|---|---|---|
| `packages/brain/self/src/rules.ts` | P9(另一個工作結束後) | 一條:要在電腦上做的事(跑程式、shell、瀏覽器、改檔、搜尋檔案、畫圖)預設都能做,用 `find_tools` 找;要留下來的結果放 `/workspace`,做成檔案的用 `workspace_export` 再 `share`。不改既有的句子 |
| `packages/llm/tools/src/find.ts` | P9 | `GROUP_WORDS`:`code` 加「shell」「終端機」「指令」「安裝」;`workspace` 加「改檔」「搜尋檔案」;新的 `browse: ["瀏覽器", "網頁", "截圖", "點"]`、`image: ["畫圖", "生圖", "圖片", "插畫"]`、`http: ["外部服務", "API"]` |
| `packages/brain/self/src/subagents.ts` | P9 | `CODE_TOOLS` 加 `shell_run`;`WORKER_TOOLS` 加 `workspace_edit`、`workspace_grep`、`browse_open`、`browse_act`、`browse_read`、`browse_shot`、`image_make`;`WORKER_EXTRA_GROUPS` 加 `"http"` |
| `packages/brain/self/src/delegate-texts.ts` | P9 | worker 的說明:有一台 Linux 機器(shell、能上網、能裝套件)、真的瀏覽器、畫圖 |
| `packages/brain/selfhost/src/host.ts` | P9 | `provide(WorkQuotaKey, hostWorkQuota(agent, quiet))`(P4);`provide(MessageFilesKey, book)`(P4);`Initiative` 傳 `jobs: { start: (s) => this.jobs.delegator.start(s) }`(P5) |
| `packages/brain/selfhost/src/around.ts` | P9 | `#files` 裡呼叫 `recordRunFiles(book, run.inputs)`(P4),在挑檔之前 |
| `packages/workspace/sandbox/src/gate.ts` | P3 | P3 在 `offerWorkspace` 和 `setAvailable` 留好呼叫的位置;P9 加:`workspaceEditCapabilities`(P5,跟著 `offerWorkspace`)、`workspaceAttachCapability`(P4,跟著 `offerWorkspace`)、`browseCapabilities`(P6,跟著 `setAvailable`,只在叢集後端) |
| `packages/workspace/sandbox/src/index.ts` | P9 | 匯出 P3 的 `remote/index.ts`、P4 的 `attach.ts`、P5 的 `workspace-edit.ts`、P6 的 `browse/index.ts`、P1 的 `tar-io.ts` |
| `packages/workspace/sandbox/src/config.ts` | P3 | P6 的 `browser` 子表:P3 加 `browser: BrowseConfigSchema.prefault({})`(從 P6 的 `browse/config.ts` import) |
| `packages/gate/actions/src/tools.ts`、`capability.ts` | P3 | 中風險的 `followup` |
| `packages/gate/actions/src/share.ts`、`zip.ts`、`config.ts` | P4 | |
| `packages/gate/actions/src/work.ts`、`index.ts` | P7 | P4 若要匯出 `inspectTar`,寫在 P7 的 `index.ts`(告訴 P7) |
| `packages/gate/actions/src/registry.ts` | 沒有人(要改就交給 P9) | |
| `packages/contracts/**`、`schema/*.json` | P1 | 之後要改形狀的,交給 P9 |
| `packages/types/src/index.ts` | P1 | |
| `packages/commands/src/nodes.ts` | P1 | |
| 所有 `package.json` 的相依、`pnpm-lock.yaml` | P1 | |
| `packages/core/src/modules.ts` | P9 | `new SandboxModule(profileId, { baseDir, endpoints })`(P3);`HttpToolsModule`(P7);`ExtensionLauncherKey` 的提供:沙箱模組啟動後,`sandboxLauncher({ client, trustedHosts, fallback })`(P8);`extensionsCli` 不變 |
| `packages/core/src/config-schema.ts` | P9 | `[modules.http_tools]` 的 schema(P7 的 `HttpToolsConfigSchema`) |
| `packages/core/src/removed-config.ts` | P9 | 這幾批沒有拿掉鍵;有的話加在這裡 |
| `miyoria.example.toml`、`packages/cli/templates/miyoria.example.toml` | P9 | 兩份完全一樣。每一包在交付說明裡附它的段落;見 §5 |
| `packages/cli/src/cli.ts`、`i18n/` | P9 | `sandbox serve`、`sandbox build [--yes]`(P2 的 `commands/sandbox.ts`) |
| `packages/cli/src/commands/services.ts`(`add`)、`doctor.ts` | P9 | `add` 之後呼叫 `sandboxAfterAdd`;`doctor` 加 `sandboxDoctorChecks()`(P2) |
| `packages/cli/src/host-toml.ts` | P2 | |
| `packages/cli/scripts/build.mjs` | P9 | `copyCatalog` 把 `workers/sandbox/service.toml`、`routing.toml`、`image/**`(包括 `browser/`)複製進套件 |
| `packages/store/scripts/schema-sql.ts` | P3 | 只有 P3 新增 store 外掛;P5 的 migration 3 在已經登記的 `initiative` 裡 |
| `packages/plugin-host/ext-host/src/extension.ts`、`config.ts`、`manifest.ts`、`cli.ts` | P7 | P8 不改它們 |
| `packages/workspace/web/src/index.ts` | P7 | |
| `.github/workflows/ci.yml` | P9 | 新的 job `docker-sandbox`:buildx 建 `workers/sandbox/image` 和 `image/browser`(不推),像 `docker-core` |
| `docs/design/backlog.md`、`v6-agent.md` 的狀態、`docs/OPERATIONS.md` | P9 | 每一包把留下的事寫在交付說明裡 |
| `packages/workspace/sandbox/README.md` | P3 | P2 另外寫 `workers/sandbox/README.md` |

## 5. 整合要做的,照每一包

**P1 之後**:確認 `pnpm -r typecheck` 在 P1 的改動下沒壞(其他包的檔還沒來);把 `miyoria.example.toml` 的新段落先放骨架。

**P2**:CLI 命令表註冊 `sandbox serve`、`sandbox build`,i18n 的說明;`add`、`doctor` 的掛鉤;`build.mjs` 複製 `workers/sandbox/`;`miyoria.example.toml` 的「這台電腦跑什麼」那段提一句 `[sandbox]`(鍵本身在 `host.toml`,不在 `miyoria.toml`);CI 的 `docker-sandbox` job。

**P3**:`modules.ts` 傳 `endpoints`;`miyoria.example.toml` 的 `[modules.sandbox]` 整段換成沙箱文件 §12.2(註解照現在的風格,每個改過預設的鍵寫原本的值);`subagents.ts` 的 `CODE_TOOLS` 加 `shell_run`;`find.ts` 的 `code` 字;`rules.ts` 那一條;`delegate-texts.ts`。

**P4**:`host.ts` 提供 `WorkQuotaKey`、`MessageFilesKey`;`around.ts` 的 `recordRunFiles`;`gate.ts` 註冊 `workspace_attach`;`miyoria.example.toml` 的 `[modules.agent.quota]` 兩個鍵、`[modules.actions.share] max_bytes`。

**P5**:`gate.ts` 註冊 `workspace_edit`、`workspace_grep`;`host.ts` 傳 `jobs` 給 `Initiative`;`subagents.ts` 加 `workspace_edit`、`workspace_grep`、`image_make`;`find.ts` 的 `workspace`、`image` 字;`miyoria.example.toml` 的 `[modules.imagegen]` 提 `image_make`。

**P6**:`gate.ts` 註冊 `browseCapabilities`;`config.ts`(P3 的)的 `browser` 子表確認接上;`subagents.ts` 加四個 `browse_*`;`find.ts` 的 `browse`;`miyoria.example.toml` 的 `[modules.sandbox.browser]`;CI 建 `image/browser`。

**P7**:`modules.ts` 註冊 `HttpToolsModule`;`config-schema.ts` 登記 `[modules.http_tools]`;`subagents.ts` 的 `WORKER_EXTRA_GROUPS` 加 `"http"`;`find.ts` 的 `http`;`miyoria.example.toml` 的 `[modules.http_tools]`、`[extensions."<id>"] run_in / secrets / tools`、`[mcp.servers.*] risk`。

**P8**:`modules.ts` 在沙箱模組提供 `SandboxClientKey` 之後提供 `ExtensionLauncherKey`(`sandboxLauncher`);`[modules.sandbox] trusted_hosts` 的設定(放在 P3 的 `config.ts`:告訴 P3,或由 P9 在 P3 交付後加,擁有者照舊是 P3)。

**最後**:`pnpm -r typecheck`、`pnpm -r test`(CI 的 Linux 會跑 Docker 的測試);`miyoria.example.toml` 和範本 `cmp` 一樣;`backlog.md` 收各包留下的事;`v6-agent.md` 的第二到四批寫上「做成的樣子在 v6-sandbox.md」。

## 6. 風險

- **沒在真的電腦上跑過的路**:`--internal` 網路加代理(backlog 記著沒驗證過)、Docker Desktop 上 `docker exec cat /sys/fs/cgroup/cpu.stat`、朋友的 Windows 電腦上的 bind mount 權限。CI 只有 Linux。P2 的交付說明要寫在哪台 Windows 上試過什麼。
- **中繼的串流數**:每台 16 條。P3 的 client 每台只開一條事件長輪詢;上傳、下載一個工作一次一條。插件多、又同時有大檔案時還是可能碰到;碰到時 `request` 會馬上失敗,client 要排隊重試而不是當成那台壞了。
- **磁碟**:bind mount 沒有配額,一次 exec 裡可以先寫爆朋友的磁碟再被量到。每 5 秒量一次加 `fsize` 只是縮小窗口。
- **容器不是 VM**:Docker Desktop 的 VM 碰得到 Windows 的磁碟(sandbox README 的「剩餘風險」)。成員的程式在朋友的電腦上逃出容器,碰到的是那台主人的檔案。`[sandbox] runtime = "runsc"` 只在 Linux 上有。
- **開放的網路**:從朋友的 IP 掃描或打別人、大量下載。代理只擋內網和寄信,流量上限和每人的 CPU 額度是剩下的防線(owner 選的)。
- **熱點的合併**:`rules.ts`、`brain/agent/src/config.ts`、`selfhost/src/host.ts`、`miyoria.example.toml` 正在被另一個工作改;P4、P9 要等它結束再加,而且只加不改。P4 可以先把 `QuotaConfigSchema` 的兩個鍵寫好放在交付說明裡,等那個工作結束再貼進去。
- **映像檔**:2 GB、第一次建要幾分鐘到幾十分鐘;Dockerfile 改了之後朋友的電腦用舊的(stale)直到有人建新的(§16 第 1 題)。
- **正規表示式**:`workspace_grep` 的樣式來自模型,可能被訊息裡的內容引導成會卡住的;一定要在 worker thread 裡跑、有時間上限。
- **tar**:兩邊都要用同一個 `tar-io` 的檢查;任何一邊自己解 tar 都是漏洞。
