# @miyoria/overlay

直播用的 **OBS 瀏覽器來源**:字幕(邊講邊出)、情緒指示、小型狀態 / 請求佇列面板、左下角的活動膠囊(她現在在做什麼,附進度條)。背景透明、深色極簡,每個有字的區塊都自帶半透明深色底板,所以疊在亮的遊戲畫面上也看得清楚。Vite + TypeScript,沒有框架,build 後約 32 KB(gzip 約 12 KB)。

## 它怎麼拿到資料

連到 Stage 的 overlay 推送(`packages/stage/src/overlay.ts`):

| 訊息 | 用途 |
|---|---|
| `{"type":"subtitle","turn","text","final"}` | 字幕。同一個 `turn` 的 `text` 是越來越長的完整字串(partial),`final: true` 表示這句講完。新的 `turn` 取代舊的。 |
| `{"type":"emotion","name","intensity"}` | 情緒指示(顏色依情緒名稱,`intensity` 調點的深淺)。 |
| `{"type":"speaking","state":"started"\|"stopped"}` | 她在不在說話:說話中字幕不會消失,停下來後才開始倒數。 |
| `{"type":"status","core","vts","obs","scene","streaming"}` | 狀態面板:直播中 / 場景名 / Core、VTS、OBS 連線點。 |
| `{"type":"queue","items":[…]}` | 請求佇列(「接下來」)。`items` 可以是字串,或帶 `title`(也認 `text` / `name` / `song` / `request`…)與 `by`(也認 `user` / `requester`…)的物件;最多顯示 5 筆,多的寫「還有 N 項」。 |

| `{"type":"activity","kind","label","detail","progress","elapsed_ms","duration_ms"}` | 活動膠囊(見下面)。`kind`:`thinking`(思考中…)、`synthesizing`(產生語音…)、`song_prepare`(下載中 / 讓出顯示卡中 / 分離人聲 / 轉換歌聲 / 混音 / 找歌詞,`detail` 是歌名,`progress` 是 worker 的進度)、`singing`(正在唱,`elapsed_ms` + `duration_ms` 由 overlay 自己的時鐘推進度);`kind: null` 隱藏。不認得的 `kind` 當成沒有進度的狀態顯示。 |
| `{"type":"gift","text"}` | 禮物那一行(上方中間的小膠囊,例如「Owen 餵了她一碗白飯」)。Stage 把 60 秒內同一種禮物合併成一行(「Owen 和另外 3 人餵了她 5 碗白飯」),送出最新的一行,`text: ""` 表示淡出(最後一份禮物後約 8 秒)。 |
| `{"type":"touch","x","y","part"}` | 觀眾在網站上摸了直播畫面(Core 的 `live.touch`,Stage 每秒最多轉 8 個)。`x`、`y` 是 0..1(左上為原點),`part` 是 `head` / `face` / `body` / `screen`。overlay 在畫面的 (x·寬, y·高) 畫一圈小小的波紋和一顆往上飄的愛心,約 1.3 秒淡出,同時最多 12 個(超過時最舊的立刻拿掉);`prefers-reduced-motion` 時不動、只淡入淡出。範圍外或型別不對的整則略過。`?demo=1` 會隨機在她的頭、臉、身體和空白處摸。她本人的反應由 Stage 驅動(`[stage.touch]`),不在 overlay。 |
| `{"type":"danmaku","id","name","text","max_on_screen","queue_max","max_wait_ms"}` | 彈幕:觀眾付幾枚硬幣送出的一行字,從右邊進來橫越畫面(見下面「彈幕」)。`name` 是 `null` 表示名字隱藏。三個上限是實況主的設定,每一行都附上,以最新收到的為準。overlay 要回覆每一行的下場。 |
| `{"type":"danmaku_clear"}` | 彈幕一次全部拿掉:畫面上的淡出(已經算顯示過,不再回覆),還在排隊的回 `cleared`。 |
| `{"type":"notice","text"}` | 舊版 Core 的一行狀態(「準備歌曲中…」,`""` 清掉)。沒有 `activity` 時顯示在活動膠囊裡(沒有進度)。 |
| `{"type":"levels","rms","bands"?}` | 她的聲音音量(0..1,和嘴型同一份、同樣延遲),每個 avatar frame 一次(約 60/s),停下時送一次 `rms: 0`。畫成左側邊緣從上到下一整排固定不動的橫條(貼齊畫面左緣、前端圓角、半透明):每條只改長度和透明度,中間的跟低頻、上下兩端的跟高頻,顏色跟著情緒點;她開口時淡入、停下時淡出。唱歌時跟著她的人聲。 |

不認得的訊息、壞掉的 JSON 一律略過,不會中斷。WebSocket 斷線會自動重連(0.5 s 起、最長 5 s),Stage 重開不用重新整理 OBS 的來源。

## 用法

```bash
pnpm install        # 在 repo 根目錄(pnpm workspace)
cd apps/overlay
pnpm build          # → apps/overlay/dist(Stage 預設就從這裡服務 /overlay/)
pnpm test           # vitest:訊息解析、reducer、打字機、設定
pnpm dev            # 開發:http://localhost:5173/?demo=1
```

OBS:新增「瀏覽器」來源,網址 `http://127.0.0.1:7884/overlay/`,寬 1920、高 1080。背景本來就是透明的,不需要在 OBS 裡加自訂 CSS。

### Query string

| 參數 | 預設 | 說明 |
|---|---|---|
| `ws` | 跟頁面同一個主機的 `…/overlay/ws`(file:// 開啟時 `ws://127.0.0.1:7884/overlay/ws`) | 推送位址,只接受 `ws://` / `wss://`。 |
| `show` | `subtitles,emotion,status,queue,wave,activity,gifts,screen,touches,danmaku` | 要顯示哪些部分,逗號分隔。例如 `?show=subtitles,queue`。沒有任何有效名稱時視為預設。沒有 `danmaku` 的頁面不送 `danmaku_ready`、也不回覆任何彈幕(Stage 不等它)。 |
| `danmaku_band` | 依版面 | 彈幕跑道的上下緣,畫面高度的比例,`上-下`,例如 `?danmaku_band=0.04-0.30`。畫面不一樣(例如她站的位置不同)時用;左右範圍照版面不變。格式不對、上緣不在下緣之上、或不到 2% 高時不採用。 |
| `cps` | `14` | 打字機基本速度(每秒字數,2~200)。字幕來得比顯示快時會自動加速追上;`200` = 不做打字效果。 |
| `scale` | `1` | 整體縮放(0.4~3)。1 是以 1080p 為準,版面隨畫面寬高等比,720p / 4K 看起來一樣。 |
| `demo` | 關 | `?demo=1` 播一段內建的假資料,不用連 Stage,設計和預覽用。 |
| `debug` | 關 | 推送斷線時在左下角顯示 "feed offline"(預設不顯示,避免上了直播畫面)。 |
| `layer` | `overlay` | `backdrop`:這頁變成整個場景最底下的背景層(見下面),不連推送。 |
| `layout` | `default` | `sing`:唱歌場景的版面。影片在左上(1080p 時 48,48 起、1504×846),她的模型站在右下角、蓋住影片一角;字幕移到影片下緣、活動膠囊在影片正下方、聲音條改成橫的貼在畫面底部、側邊面板對齊同樣的邊距。 |

### 背景層與唱歌場景

`?layer=backdrop` 畫 Stage 的 `/overlay/backdrop`(`[stage] overlay_backdrop` 指定的圖),上面一層中性的暗色;沒有圖就是近黑色。加上 `&layout=sing` 時多一塊影片的位置:沒有歌在播時是一片灰黑的半透明玻璃,影片蓋上去後只剩貼著影片外緣的 1px 半透明白邊和柔和的陰影,圓角 14px。位置在 `style.css` 的 `--pad`、`--video-*`,OBS 裡影片的位置要跟它一樣。所有底板(字幕、面板、膠囊)是同一種灰黑玻璃:`rgb(24 24 27)`、1px `rgb(255 255 255 / 0.15)` 邊、圓角 14px。

這些不用手動建:在直播機上執行

```bash
pnpm dlx miyoria stage obs-setup --dry-run   # 先看會做什麼,不改 OBS
pnpm dlx miyoria stage obs-setup             # 建好場景和來源
```

它建在 OBS 裡 Miyoria 自己的場景集合和設定檔(預設都叫 `Miyoria`,沒有就建立、有就切過去;你原本的不會被改),OBS 在推流、錄影、虛擬攝影機或重播緩衝開著時不切換。新的設定檔是空白的,從 OBS 推流的話串流金鑰和編碼器要在裡面重新設。`--here` 直接建在目前的場景集合、`--no-profile` 不換設定檔;細節見 [docs/OPERATIONS.md](../../docs/OPERATIONS.md)「Stage 與管理面板」。

它照 `[stage.obs]` 連上 OBS,依 `[modules."stage.link".scenes] roles` 的 `sing` / `chat` / `game` 場景(沒設時是「唱歌」「聊天」,沒有 `game` 就不動遊戲場景)建好下面的版面,並把圓角遮罩寫到 `[stage] data_dir`。只會新增和更新 Miyoria 自己的來源;已經有的項目不會被搬動(要重新擺回預設位置用 `--relayout`),場景裡其他擷取 VTube Studio 的來源只會被隱藏、不會刪掉。版面依 OBS 的基礎解析度等比縮放。

OBS 場景由下到上:

- **唱歌**:`…/overlay/?layer=backdrop&layout=sing` → 影片框場景(影片 1920×1080,縮成 1504/1920 放在 48,48,加「影像遮罩」濾鏡,用 1920×1080、圓角 18px 的 alpha 遮罩)→ VTube Studio(遊戲擷取、勾「允許透明」,縮 0.6 放在右下)→ `…/overlay/?layout=sing`。
- **其他場景**:`…/overlay/?layer=backdrop` → 透明的 VTube Studio → `…/overlay/`。

VTube Studio 要用透明背景(背景選純色、勾透明),OBS 用「遊戲擷取」並勾「允許透明」,模型周圍才會透出背景。VTube Studio 這一步沒辦法用程式設定,要自己按一次。

## 彈幕

觀眾付幾枚硬幣送一行短字(預設最多 30 字),Core 先扣款,Stage 轉給這一頁,這一頁顯示並**回報這一行的下場**,Core 才知道要留下這筆錢(顯示了)還是退回去(沒顯示)。回覆跟推送走同一條 WebSocket(契約是 `@miyoria/contracts/overlay` 的 `OverlayReply`):

| 回覆 | 什麼時候 |
|---|---|
| `{"type":"danmaku_ready"}` | 每次連上(含重連)後送一次,而且只有彈幕層開著的頁面才送。Stage 只等送過這個的頁面回覆。 |
| `{"type":"danmaku_shown","id"}` | 這一行真的放進畫面、開始橫越的那一刻,送一次。 |
| `{"type":"danmaku_dropped","id","reason"}` | 不會顯示了:`queue_full`(來的時候已經有 `queue_max` 行在排隊;`queue_max` 是 0 時,不能馬上出發的一律丟掉)、`too_late`(排了 `max_wait_ms` 還沒有空的跑道)、`cleared`(排隊時被 `danmaku_clear` 清掉)。 |

連線還在時,收到的每一行剛好回一次(`shown` 或 `dropped`);同一個 `id` 重複收到不會再回。斷線時還在排隊的直接忘掉、不回(Stage 會把沒回的當成遺失),正在橫越的照樣跑完;重連後不補送舊的回覆。`?demo=1` 沒有人可以回,回覆只寫到 `console.debug`。

**跑道**(`src/danmaku.ts`,純函式,有測試):每一行都用同一個慢慢的速度往左走(`10rem/s`,1080p 是 160 px/s,長的不會比較快)。寬 w 的一行從跑道右緣 x = W 進來,x + w < 0 時結束、移出 DOM。同一條跑道上,前一行的尾巴離開右緣 `2.5rem` 之後才放下一行;速度一樣,所以同一條跑道的兩行永遠不會疊在一起。新的一行放在最上面那條空的跑道;畫面上最多 `max_on_screen` 行,其他的照順序排隊。每行到的時候先在畫面外量出真正的寬度,再決定跑道;移動用 rAF 時鐘算出的 `transform`,不用 CSS 動畫。

**位置**:每條跑道 `2.75rem` 高,條數 = 範圍高度 ÷ 跑道高度(至少一條)。預設版面在畫面上方三分之一(上緣往下 `1.5rem` 起,到 33.333%,1080p 是 7 條);`layout=sing` 只在歌曲影片的範圍裡、影片上方三分之一(1080p 是 6 條),在影片左右兩邊被切掉,不會經過右下角的她。`danmaku_band` 可以改上下範圍。彈幕在所有底板(側邊面板、禮物那一行、付費留言)下面,經過時從底板後面穿過去,底板上的字一直看得清楚。

**樣子**:一行不換行。送的人名字小一點、淡一點放在前面(名字隱藏時沒有);字是 `--ink`,外面一圈多層的深色陰影當描邊,底下一顆很淡的灰黑膠囊,疊在很亮的畫面上也讀得到。`danmaku_clear` 時畫面上的行原地淡出。

## 行為細節

- **打字機**:整行文字從第一個 frame 就排好版(還沒打到的字是透明的),所以字不會在打的過程中跳行。以 code point 計算,不會把 emoji 拆開。字幕修正(同 turn 的文字前綴改變)時,只重打有變的部分。
- **字幕消失**:`final` 之後,等打完、她停止說話,再停留 `2.2 秒 + 每字 55 ms`(上限 9 秒)後淡出。沒有 `final` 又 8 秒沒更新、也不在說話,視為殘留,淡出。
- **字型**:用系統字型(Segoe UI Variable / 微軟正黑體 / Noto Sans TC)。中文字型檔太大,不內嵌;OBS 所在的 Windows 都有。
- **活動膠囊**:左下角、她的聲音條右邊(`left: 10rem`,比字幕底板低,不會重疊)。一個情緒色的點、短短的狀態文字、歌名(太長會省略),底部膠囊裡面一條進度條:有進度時平順地長到新的值;唱歌時從唱到的地方線性跑到歌的結尾(CSS 動畫,不用一直收訊息);沒有進度時是一道慢慢移動的微光。換狀態時文字交叉淡化、膠囊寬度緩動到新的長度;沒事做時淡出。
- **動態**:全部用同一套:出現時淡入 + 輕微位移(或高度展開),`--t-enter` 260 ms、`--ease-out`;消失 `--t-exit` 200 ms;文字改變交叉淡化 `--t-change` 240 ms;排序、寬度 `--t-move` 280 ms;進度 `--t-progress` 700 ms(都在 `style.css` 的 `:root`)。元素要等消失的動畫跑完才移出版面(`hidden`)。側邊面板的區塊(情緒、狀態、佇列)和裡面的「直播中」、場景名稱、「還有 N 項」用 0fr → 1fr 的 grid 列展開 / 收起,面板高度跟著平順變化;佇列每一項有自己的 key,新的展開進來、移除的收起後才刪掉、換位置的滑過去(FLIP);情緒名稱、場景名稱交叉淡化;連線點換色。`prefers-reduced-motion` 時所有時間變成 1 ms,微光、呼吸都停掉(唱歌的進度條照常走,那是資訊)。

## 結構

```
src/feed.ts        訊息型別、parseMessage、reduce、shownActivity(純函式,有測試)
src/typewriter.ts  打字機步進、code point 工具、停留時間(純函式,有測試)
src/config.ts      query string(有測試)
src/emotion.ts     情緒名稱 → 顏色(同亮度同彩度,只轉色相)
src/connection.ts  WebSocket 重連、送回覆(只在連線開著時)
src/view.ts        DOM、rAF 迴圈、字幕計時、面板與佇列(FLIP)
src/danmaku.ts     彈幕跑道、上限、排隊、每行的回覆(純函式,有測試)
src/danmaku-view.ts 彈幕層的 DOM:量寬度、擺進跑道、移動、送回覆
src/activity.ts    活動膠囊(文字、寬度、進度條)
src/backdrop.ts    背景層(?layer=backdrop):背景圖、壓暗、唱歌版面的影片位置
src/motion.ts      共用動態:is-out 進出、交叉淡化、讀 CSS 的時間
src/demo.ts        ?demo=1 的假資料(說話、思考、做歌的每個階段、唱歌、佇列變動輪流來,彈幕偶爾一行、定時一大波超過跑道和排隊上限)
src/style.css      版面與視覺
```
