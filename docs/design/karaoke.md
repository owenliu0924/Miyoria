# 線上唱 K:她當主持人

> 2026-11-17 規劃,沒有實作。依據是 owner 2026-11-17 的回答([v5-play.md](v5-play.md) §11.3),讀過舊的 `karaoke` 專案(SUMI,唯讀)和這個 repo 的唱歌 worker、派對遊戲、Stage、overlay、voice node、面板和經濟。模型和評分的資料是網路上查的,來源在 §15,沒查到的在 §16。數字標「草案」的都是設定。

## 0. 結論

1. **在會員頁唱**。伴奏在每個唱的人自己的瀏覽器播,音高在瀏覽器裡算、分數在瀏覽器裡算,所以網路延遲不影響自己的畫面和分數。只有很小的音高軌(每秒 50 個位元組)送到 Core。
2. **Core 拿音高軌自己重算一次分數**,魚幣只看 Core 算的。前端的分數只是給人看的即時數字。
3. **她的直播比唱的人晚 1.5 秒**(草案):Core 在 Discord 語音播伴奏,overlay 畫每個人的音高線和分數,資料一定比畫面先到。單人時伴奏混進唱的人的聲音一起播;多人不播人聲。
4. **參考旋律**:唱歌 worker 已經有的「主唱分離 → RMVPE 音高」,加一個不用新模型的切音符步驟;原始音高曲線也留著,評分兩個都用。之後再試 GAME 或 ROSVOT。
5. **瀏覽器的音高**:AudioWorklet 加 McLeod 方法(`pitchy`,0BSD),10 ms 一次,畫面延遲約 30–60 ms 加上麥克風本身的延遲。不用神經網路。
6. **評分**參考 JOYSOUND / DAM 的結構,只做量得準的:音程、安定性、節奏、表現加分(顫音、長音、しゃくり、フォール)。こぶし和抑揚不做。
7. **她不在即時的路上**:唱的時候她只收到安靜的通知,表情由程式照規則送;唱完拿系統分數講評,一次模型呼叫。
8. **第一步**:單人網頁唱 K,本機評分,唱完她在 Discord 講評。沒有直播、沒有魚幣。

## 1. 舊專案(SUMI)看到的

SUMI 是 Tauri 2 + React 19 的單人桌面練歌室,分析在本機的 Python。

| 部分 | SUMI 怎麼做 | 這邊用不用 |
|---|---|---|
| 人聲分離 | Demucs htdemucs_ft 的人聲成員,伴奏 = 原曲 − 人聲 | 不用。唱歌 worker 已有 MelBand RoFormer,再加 becruily 的主唱 / 和聲分離,比 SUMI 多一層「只留主唱」 |
| 參考音符 | ROSVOT + RWBD + RMVPE(M4Singer 權重,從 Google Drive 下載、逐檔 SHA256);20 秒分段、前後 1 秒上下文;用 RMVPE 有聲判斷和相對 RMS 修掉無聲段,子音空隙最多跨 120 ms | 做法可以參考,第 5 步再試(§3.2)。修無聲段的規則直接搬進新的切音符步驟 |
| 歌詞 | faster-whisper 辨識,WhisperX 強制對齊校正過的文字 | 第一版不用:這邊已有 lrclib / 網易雲的同步歌詞、整體位移對齊和 ASR 抽查 |
| 即時音高 | YIN,`setInterval` 每 20 ms 從 AnalyserNode 拿一窗,丟給 Web Worker | 不用。改 AudioWorklet:每個樣本都有準確的時間,算法換成 McLeod |
| 評分 | 每格 `max(0, 1 − |差| / 2 半音)`,用時間加權;不做八度相容;麥克風沒開的段落不算 | 改成容許範圍和逐音符的八度相容(§5) |
| 延遲 | 設定頁手動填 0–1000 ms | 改成量一次(§6.3) |
| 畫面 | Canvas、`requestAnimationFrame` 讀媒體時鐘、整首固定音域 | 做法照用,在面板重寫 |

SUMI 的 VALIDATION.md 自己寫了:沒有實體麥克風測過、沒有人工標註,音符數量不代表準確。所以它的模型選擇只能當起點。程式是 owner 自己的,可以參考;ROSVOT 程式是 MIT,權重的授權沒寫。

## 2. 房間怎麼走

```
開房(付錢) → 點歌 → 準備中(worker) → 等人(加入、試麥) → 倒數 → 唱 → 結果(她講評) → 點下一首 / 關房
```

| 狀態 | 誰做什麼 | 結束條件 |
|---|---|---|
| 開房 | 會員在面板按「開房」,或在 Discord 跟她說(`karaoke_open`,和 `party_start` 同樣是 `user` principal,節點預設 `chat.talk`)。房間掛在一個 Discord 頻道(她在的語音頻道,或下指令的文字頻道);她在頻道發一張中性卡片,按鈕連到房間頁 | 有人點歌 |
| 點歌 | 房主或任何加入的人貼連結或打歌名。一次只準備一首 | 送出 |
| 準備中 | worker 做伴奏、參考旋律、歌詞(§3)。進度照現有 `sing.prepare` 顯示 | 好了 / 失敗(§11) |
| 等人 | 想唱的人按「我要唱」,做試麥(音量、是否戴耳機、延遲)。最多 4 人(草案,§7)。其他人在 Discord 聽和看 | 房主按開始,或全部人都準備好 |
| 倒數 | Core 定開始時刻 = 現在 + 6 秒,所有瀏覽器排好伴奏 | 到點 |
| 唱 | 各自的瀏覽器播、算、畫;音高軌每 250 ms 一批上傳 | 歌完 / 全部人斷線超過 20 秒 / 房主停 |
| 結果 | Core 重算、比名次、發魚幣(多人)、通知她講評 | 回到「點歌」 |
| 關房 | 房主關、閒置 10 分鐘、所有人離開 | |

房間狀態在 Core 記憶體,像歌單一樣存一份快照到設定庫;Core 重啟時正在唱的那首作廢(不發錢),房間回到「點歌」。

## 3. 準備一首歌(workers/sing)

### 3.1 新的工作種類

`POST /jobs` 多一個 `purpose: "karaoke"`。跟翻唱共用前半段,不做轉換(翻唱裡最久的那 40%):

| 階段 | 內容 | 已經有嗎 |
|---|---|---|
| resolve / download | 連結(只限 `SING_URL_HOSTS`)或搜尋;最長 `SING_MAX_SECONDS` | 有 |
| separate | MelBand RoFormer:人聲 + 伴奏;同一個來源分過就用快取 | 有 |
| lead | becruily BS-RoFormer:主唱 + 和聲 | 有 |
| reference | 主唱的 RMVPE 音高(10 ms)→ `clean_f0` → 切音符(§3.2) | RMVPE 和 `clean_f0` 有,切音符是新的 |
| lyrics | 同步歌詞、整體位移、ASR 抽查 | 有 |
| encode | 伴唱軌 = 伴奏 + 和聲(像 KTV 的伴唱帶,和聲留著),AAC 128 kbps `karaoke.m4a`;48 kHz 單聲道 `play_karaoke.pcm` 給 voice node;主唱 `guide.m4a`(導唱,預設不播) | 新的 |

輸出 `reference.json`:音符 `[開始, 結束, MIDI(小數)]`、音高曲線(10 ms,四分之一半音一個位元組)、歌詞的行(和有的話字)、節拍、品質檢查的數字。檔名加進 `SONG_FILES`。

估計時間:翻唱一首 3:28 的歌約 62 秒,其中轉換 42 秒(autonomy.md 的實測);少了轉換,加上切音符幾秒,估 20–60 秒,**沒量過**。工作排在同一個 worker 的佇列,朋友那台優先、這台備援(現有的 failover)。唱 K 的工作不算「現在就要」,不會叫語音讓出顯示卡。

### 3.2 參考旋律的模型

| 選項 | 輸出 | 授權(程式 / 權重) | 判斷 |
|---|---|---|---|
| RMVPE | 音高曲線 | Apache-2.0 / 沒寫 | **用**。worker 已經在跑(轉換時的 F0),pitch-benchmark 上和 SwiftF0 並列最好的一群 |
| FCPE(torchfcpe) | 音高曲線 | MIT / 沒寫 | 備選,要換掉 RMVPE 時 |
| SwiftF0 | 音高曲線 | MIT | 很快,但它是給即時用的;離線沒有理由換 |
| 自己切(新的) | 音符 | 自己寫 | **第一版用**:半音值中位數濾波、遲滯切換、最短 80 ms、跨 120 ms 子音空隙(SUMI 的規則) |
| GAME(openvpi) | 音符(起點、終點、小數音高),可吃字的邊界 | MIT / 沒寫 | 第 5 步試。SOME 的後繼,技術報告寫音符 F1 約 0.80,有 ONNX 匯出 |
| ROSVOT | 音符 | MIT / 沒寫(Google Drive) | 第 5 步試。論文的 MIR-ST500(領域外)只有 47.4,SUMI 已整合過 |
| SOME | 音符 | MIT / **CC BY-NC-SA** | 不用(非商業權重),而且已被 GAME 取代 |
| basic-pitch | 多聲部 MIDI | Apache-2.0 | 不用,為樂器調的 |

為什麼兩個都留:音符條是畫面和「音程」那一項要的;原始曲線才看得出原唱哪裡有顫音、しゃくり,也能原諒切錯的音符(§5)。領域外的音符準確度只有五成上下,所以評分不能只靠音符條。

**品質檢查**:主唱有聲的時間少於歌長 15%,或音符少於 30 個,就回「這首抓不到主旋律」,不開唱。

### 3.3 歌詞

第一版用現有的行級同步歌詞。行內的上色不照時間平均推,而是照**那一行裡主唱有聲的時間**推:唱到長音時字停住,和 KTV 的感覺接近。找不到歌詞就只有音符,畫面寫「沒有找到歌詞」。

字級的時間之後再做:網易雲有逐字歌詞的歌(沒驗證有多少),或強制對齊。對齊的候選:WhisperX 的 wav2vec2 模型(日文那個 Apache-2.0,中文那個沒查到)、Montreal Forced Aligner(模型 CC BY 4.0)、SOFA(MIT,為唱歌做的,預設中文)。MMS 的對齊權重是 CC-BY-NC,不用。

## 4. 瀏覽器的音高

| 選項 | 延遲 | 授權 | 判斷 |
|---|---|---|---|
| McLeod(`pitchy`) | 窗 2048 樣本 @48 kHz(43 ms,低音 80 Hz 也有兩個週期),每 10 ms 一次 | 0BSD | **用**。純 JS,跑在 AudioWorklet 裡,一次不到 1 ms |
| YIN(SUMI 自己寫的) | 同上 | owner 的 | 可以,但 McLeod 對歌聲的八度錯誤少一點(沒自己量) |
| pitchfinder | | 沒看到授權檔 | 不用 |
| aubio.js / essentia.js | | GPL / AGPL | 不用 |
| SwiftF0(ONNX) | 串流時有 176 ms 的前瞻 | MIT | 畫面不能等,不用;之後可以只拿來替評分複查 |
| CREPE tiny、SPICE | | MIT / 沒查到 | 準確度比 SwiftF0、RMVPE 低,不用 |

- `getUserMedia` 關掉 `echoCancellation`、`noiseSuppression`、`autoGainControl`;`AudioContext({ latencyHint: 0 })`。
- AudioWorklet 收 128 樣本的區塊,存環形緩衝,每 480 樣本跑一次 McLeod,結果帶「這一窗中點的樣本時間」送到主執行緒。主執行緒畫 100 Hz 的音高線、算分數。
- 有聲判斷:McLeod 的清晰度 ≥ 0.9 而且 RMS 高過試麥時量的底噪 6 dB。
- 要戴耳機。用喇叭時伴奏會被收進麥克風,音高會跟著伴奏跑。試麥時放 3 秒伴奏、請人不要出聲,收到的音高和參考對得上就提醒「請戴耳機」。

自己的音高線延遲 = 麥克風輸入延遲 + 半個窗(21 ms)+ 最多一個 hop(10 ms)+ 一格畫面(16 ms)。輸入延遲在 Chrome 上量到過 19–41 ms(macOS、關掉處理)到約 100 ms(Windows,2017 年的資料),Android 更多。

## 5. 評分

### 5.1 商用機的結構

- **DAM 精密採点**:音程、安定性、表現力(抑揚、しゃくり、こぶし、フォール)、ビブラート&ロングトーン、リズム(タメ到ハシリ七段)。開發者說 100 分的條件是音程 95% 以上、表現力 90% 以上、安定性滿分。粉絲對三千多次的回歸:音程斜率 0.62,安定性 0.27,表現力 0.18,顫音長音 0.18,節奏 0.14(不是官方權重)。
- **JOYSOUND 分析採点マスター / AI+**:音程(整首的命中率)、安定感、抑揚、ロングトーン、テクニック(こぶし、しゃくり、ビブラート,顫音分九型)。AI+ 多一個 AI 加分。有部落格寫配分 40 / 30 / 15 / 10 / 5,非官方。

兩家的共同點:**音程占大半**,其次是安定和技巧;節奏的比重小。

### 5.2 我們的分數(100 分,草案)

| 項目 | 分 | 怎麼算 | 可靠嗎 |
|---|---|---|---|
| 音程 | 60 | 每個參考音符:有聲而且和音符條或參考曲線差在 ±50 cents 內的格數比例(八度相容,§5.3);時間加權 | 可靠 |
| 安定性 | 15 | 400 ms 以上的音符,去掉顫音(低通)後的音高標準差,對照到 0–15 | 可靠 |
| 節奏 | 15 | 每個音符起點:唱的人第一個有聲且音對的格,減掉校正過的延遲,和參考起點的差。用中位數(偏快 / 偏慢)和分散度給分;±60 ms 內滿分 | 要有校正(§6.3) |
| 表現加分 | 10 | 顫音(5–7 Hz、深度 20–100 cents、持續 0.5 秒以上,算秒數)、長音(1 秒以上的音符唱滿九成)、しゃくり(進音符前 150 ms 內從低一個半音以上滑上)、フォール(音符結尾往下掉) | 中等 |

- 沒出聲的參考音符照算(SUMI 不算麥克風沒開的段落,這裡要算,不然不唱就不扣分)。
- 結果頁除了總分,每一項有一行文字(「節奏:整體偏慢約 80 ms」「顫音 6.2 秒」),也把這些給她講評。
- 不做:こぶし(很短的上下抖,和音高偵測的雜訊分不開)、抑揚(音量跟麥克風和距離有關)、AI 感性加分(她的講評就是這個位置)。
- 不說「和 JOYSOUND 一樣」。畫面寫「系統分數」。

### 5.3 八度和容許範圍

男生唱女生的歌會低一個八度。每個參考音符取 `min_k |唱的 − 參考 − 12k|`,所以低八度也算對;畫面上唱的人的線照他自己整首的中位數搬到參考那個八度畫,看起來是貼在音符條上。容許範圍 ±50 cents 是一個設定;和「參考曲線」比較的那一條也算對,用來原諒音符切錯。

### 5.4 評分程式只有一份

評分寫成一個不依賴 Node 的 TypeScript 模組(`packages/play/karaoke/src/score/`,面板和 Core 都 import)。瀏覽器拿 100 Hz 的音高算即時分數;Core 拿 50 Hz 的音高軌重算(§9)。兩邊的差在測試裡釘住(差不超過 1 分)。

## 6. 時間

### 6.1 對時

- Core 的時鐘是標準。房間的 WebSocket 每 10 秒做一輪 8 次 ping:瀏覽器記 `t0`、Core 回它的時間 `ts`、瀏覽器記 `t1`,`offset = ts − (t0 + t1) / 2`,取往返最短的那一次。誤差大約是往返的一半,一般 10–40 ms。
- 開始時刻 `start_at` 是 Core 的時間。瀏覽器用 `AudioContext.getOutputTimestamp()` 把它換成音訊時鐘,再減掉 `outputLatency`,讓聲音**從耳機出來**的時候剛好是 `start_at`。
- 歌裡的時間 = 音訊時鐘換算回來的「現在」− `start_at`。音訊時鐘和系統時鐘的漂移每 30 秒看一次;超過 40 ms 只調評分用的時間,不動正在播的聲音。
- 中途斷線再連:`source.start(when, 已經過的秒數)` 從現在的位置接上。

### 6.2 差多少可以接受

| 誰和誰 | 目標 | 為什麼 |
|---|---|---|
| 唱的人自己的伴奏和自己的分數 | ±30 ms(校正後) | 都在同一台機器,只看校正 |
| 唱的人之間 | ±100 ms | 彼此聽不到,只影響 overlay 上幾條線是不是一起動 |
| 唱的人和她的直播 | 直播晚 `stream_delay_ms`(預設 1,500) | 刻意的:上傳一批 250 ms、網路來回,資料要比畫面先到 |
| overlay 的畫面和觀眾聽到的伴奏 | ±150 ms | 用現有的 `[stage.lipsync] latency_ms` 對齊,和唱歌時的 MV 同一套 |

### 6.3 每台裝置的延遲校正

要補的是「伴奏從耳機出來的延遲 + 麥克風收進來的延遲」。

1. 先用瀏覽器給的估計(`baseLatency + outputLatency`,再加 20 ms 的輸入)當預設。
2. 試麥時可以做一次「跟著拍子唱」:八聲嗶,每聲跟著唱一個「啦」,取起點差的中位數。藍牙耳機會多出 150–300 ms,量出來超過 250 ms 就提醒換有線的。
3. 結果存在瀏覽器的 localStorage,以麥克風和輸出裝置的組合為鍵;Core 只拿到數字。
4. 節奏分要有做過第 2 步才算;沒做過的人節奏那 15 分按音程的比例給,結果頁寫「沒有校正延遲」。

不用「拿整首的音高去對齊參考」自動求延遲:那會把唱得慢的人也一起校正掉,節奏就量不到了。

## 7. 她的直播畫面

### 7.1 Go Live 的版面(overlay `?layout=karaoke`)

1920×1080,沿用唱歌場景的灰黑玻璃和邊距,她的模型照舊站右下角。

| 區塊 | 位置 | 內容 |
|---|---|---|
| 上方 | 48,40 起,1,400 寬 | 歌名、進度條、倒數 |
| 跑道 | 48,120 到 1,440,760 | 每個唱的人一條:灰色音符條從右往左捲,「現在」的線在 25% 寬;唱的人的音高線用他的顏色;左邊是名字、即時分數、連續命中數 |
| 計分板 | 右側 1,470 起 | 名次、分數,換名次時有一下動畫 |
| 歌詞 | 820 到 980 | 兩行:這一行照 §3.3 上色,下一行預告 |
| 背景 | | 原曲 MV(有的話)調暗,或公開頁那張背景圖 |

一個人時一條大跑道;2–4 人各一條(每條約 150 px 高);5–8 人改成一張共用的圖、每人一條顏色的線(這一版先不做,上限 4)。

### 7.2 資料怎麼到 overlay

Core 每 250 ms 把每個人這段時間的音高點和分數用 Stage Link 的新訊息 `karaoke` 送給 Stage,Stage 轉給 overlay 的 WebSocket。overlay 自己用時鐘推進,畫的時間 = 現在 − `start_at` − `stream_delay_ms`。點是 50 Hz,畫的時候內插。場景用一個新的用途 `karaoke`(沒有設就用 `sing`)。

### 7.3 Discord 語音裡播什麼

| 模式 | 語音頻道 | 什麼時候開始 |
|---|---|---|
| 多人 | 伴唱軌 | `start_at + stream_delay_ms`,Core 照現有的方式把 `play_karaoke.pcm` 串給 voice node |
| 單人、沒同意播聲音 | 伴唱軌 | 同上 |
| 單人、同意播聲音 | 伴唱軌 + 唱的人的聲音,Core 混好 | 同上 |
| 她不在語音 | 不播 | 房間照樣能玩,結果和講評在文字頻道 |

voice node 一次只播一段,唱的時候她的 TTS 會排在後面,所以她在歌中間不講話(§10)。

## 8. 單人時把聲音播到 Discord

- **路**:瀏覽器用 WebCodecs 的 `AudioEncoder` 編 Opus(48 kHz 單聲道、20 ms 一包、64 kbps),每包標上歌裡的時間(已經扣掉輸入延遲),從房間的 WebSocket 用二進位送。Core 用 `opusscript` 解(voice node 已經在用,改成 Core 也依賴它),放進以歌裡時間為鍵的緩衝,和伴唱軌在同一個時間點相加,過一個簡單的限幅,當成一段播放送給 voice node。
- **延遲**:觀眾聽到的比唱的人晚 `stream_delay_ms` 加上 voice node 的緩衝,約 2 秒。晚到超過 `stream_delay_ms` 的包丟掉,那一段是靜音,伴奏不斷。
- **為什麼不用 WebRTC**:只有一個方向、2 秒的延遲可以接受,WebSocket 就夠了,不用 STUN / TURN,也不用在 Core 跑 WebRTC 的堆疊。
- **沒有 `AudioEncoder` 的瀏覽器**不能播聲音,只能照常唱。(Firefox 什麼版本開始有,沒查證。)
- **同意**:每一首開始前勾一次「把我的聲音播到 Discord」,預設不勾。唱的時候頁面一直顯示「正在播到 Discord」和一個停止鍵。
- **管理**:房主、有管理權限的人在房間頁和面板有「切掉聲音」;被封鎖的人、她不認識的人不能播。聲音不存檔、不送 ASR、不給她的模型。
- **唱的人不要同時開著 Discord 的語音聽**:會聽到自己晚 2 秒的聲音。頁面提醒。

**多人為什麼不播**:owner 的決定。技術上也不好:每個人只聽到自己的伴奏,校正後彼此還差到 100 ms,混在一起會亂;幾個開著的麥克風同時進公開頻道,管理和同意都難。

## 9. 防作弊

分數是在瀏覽器算的,改得到。能做的:

| 做法 | 擋什麼 |
|---|---|
| Core 只信自己從音高軌重算的分數 | 直接改分數 |
| 音高軌:50 Hz,一格一個位元組(0 = 沒聲音,其餘 = MIDI 24 起每四分之一半音),一首 4 分鐘約 12 KB;每 250 ms 一批,帶序號 | 事後一次丟整首 |
| 歌裡時間 t 的資料不能早於 `start_at + t` 減 1 秒到;晚於 10 秒的不收 | 事先算好的軌 |
| 太完美:九成以上的格在音符條中心 ±10 cents、格與格之間幾乎沒有抖動、起點和參考差的標準差小於 10 ms | 程式產生的軌(拿到參考就做得出來) |
| 一個房間每人一條連線,每秒最多 8 則 | 灌訊息 |
| 魚幣只在多人、至少 2 個不同的人(連結的帳號算同一人)、每人有聲的時間過參考音符的五成 | 自己一個人刷 |
| 每天的上限(§12) | 刷多次 |

被標記的結果照樣顯示分數,但不發錢,結果寫「沒有驗證」;她不會被告知「有人作弊」,面板上 owner 看得到標記和原因。用音源產生器對著麥克風放音高是擋不掉的,獎勵小、有上限,就接受。

## 10. 她當主持人

| 時候 | 她拿到什麼 | 她做什麼 |
|---|---|---|
| 開房、歌準備好、開始 | 可以回應的通知(和派對遊戲同一種 Observation,來源 `game.karaoke`) | 照平常的規則開口:介紹歌、叫人準備 |
| 唱的時候 | 安靜的通知(誰連續命中、誰反超、誰拉了 5 秒長音),她知道但不開口 | 程式照規則送 Stage 的情緒和表情:反超時 `happy`、長音 `surprised`。沒有模型呼叫 |
| 唱完 | 一則可以回應的通知,帶系統分數:每人總分、四項、名次、和自己上次比 | 照平常的語氣講評,一次模型呼叫 |
| 平常 | 提示詞多一個 `karaoke` 區塊:房間在哪、唱什麼、誰在唱 | |

- 分數是程式算的,她沒有工具能改分數,講評時用的數字只能從通知來。歌名、歌詞來自 YouTube 和 lrclib,是不可信的資料。
- 工具:`karaoke_open`(開房)、`karaoke_host`(下一首、關房)。不加新的頂層指令,放在現有的 `/game` 群組(`/game karaoke`)和 `/miyo` 的派對遊戲頁。
- 一起唱過的人記成 `played_together`,和派對遊戲一樣;贏的人要不要多一筆「敬意」的證據見 §14。
- 評測:之後在 `play` 那組加 `karaoke-comment`:講評提到的名次和分數跟通知一致、沒有編數字、像她。

## 11. 出錯的時候

| 情況 | 怎麼辦 |
|---|---|
| 歌準備失敗(下載、太長、分不出主唱、品質檢查不過) | 房間回到「點歌」,告訴大家原因;這間房一首都還沒唱過就退房費 |
| 沒有歌詞 | 照唱,只有音符 |
| 朋友的 worker 不在 | 現有的 failover 換到這台;這台的佇列在唱歌時排後面 |
| 兩台都不在 | 房間頁寫「現在不能準備歌」,退房費 |
| 唱到一半有人斷線 | 他的跑道停住、寫「斷線」;20 秒內回來就從現在的位置接著唱,沒唱到的照算沒唱 |
| 全部人斷線 20 秒 | 這首結束,不發錢 |
| 她沒在直播 / 不在語音 | 只玩網頁,結果和講評在房間掛的文字頻道 |
| Core 重啟 | 正在唱的那首作廢,房間回到「點歌」 |
| 對時的往返超過 500 ms | 提醒「網路不穩,直播上的線可能不準」;自己的分數不受影響 |
| 沒有麥克風權限、沒有 AudioWorklet | 不能唱,頁面說明原因 |
| 試麥發現收到伴奏 | 要求戴耳機才能按「準備好」 |

## 12. 魚幣

現有的規則:錢只能賺不能買,買不到羈絆;所有「玩」的收入每天合計 `play_cap` 40;派對遊戲 `max_coins` 20、至少 2 人。唱 K 照這些:

| 項目 | 草案 | 理由 |
|---|---|---|
| 開房 | 20,燒掉 | 回收;也讓人不會隨手開房佔朋友的顯示卡 |
| 退房費 | 一首都沒唱到(準備失敗、worker 不在、15 分鐘沒開始)全退 | 不是玩的人的錯 |
| 每間房最多幾首 | 5 首,之後要再開一間 | 房費才有意義 |
| 每人每天準備幾首 | 10 | 保護 worker |
| 多人的第一名 | 15 | 和派對遊戲同一個量級 |
| 唱完的每個人(過五成) | 3 | 一起玩的理由 |
| 第一名一天最多算幾次 | 2 次 | 防同一群人一直開 |
| 單人 | 不給魚幣,只記個人最佳 | 一個人刷不到 |

全部走經濟的 `play` 收入(帳本原因 `play`,冪等鍵是房間和歌的編號),算進 `play_cap`。房費走 `Economy.purchase`,價格和每日次數是 `[modules.economy]` 的設定。

## 13. 什麼東西在哪裡

### 13.1 哪台機器做什麼

| 機器 | 做什麼 |
|---|---|
| 唱的人的瀏覽器 | 播伴唱軌、偵測音高、評分、畫自己的畫面、(單人同意時)編 Opus |
| 朋友的電腦(優先)/ 這台 | `workers/sing` 準備歌:分離、主唱、參考旋律、歌詞、編碼 |
| 這台(4070 SUPER,直播機) | Core(房間、對時、重算、混音、魚幣)、API(經 Cloudflare tunnel 給瀏覽器)、voice node(語音裡的伴奏、Go Live)、Stage + OBS + overlay |

伴唱軌的檔案在做它的 worker 上,Core 經現有的 worker 用戶端拿,轉存一份在 Core,給瀏覽器的網址由 Core 發。

### 13.2 給什麼、留什麼(隱私)

離開唱的人裝置的只有:

1. 音高軌(50 Hz、有沒有聲、四分之一半音),和瀏覽器算的即時分數。
2. 延遲校正的數字(毫秒)、瀏覽器的種類。不送裝置名稱和裝置 id。
3. 單人、而且這一首勾了同意:麥克風的 Opus 聲音,只為了即時播出,不存。

麥克風的聲音在其他時候都不離開瀏覽器,沒有錄音功能。Core 存結果(四項分數、名次);音高軌留 7 天(查爭議、看作弊標記),之後刪掉。本人在會員頁看得到、刪得掉自己的結果;「請她忘記我」一起刪。

### 13.3 版權

owner 接受在 Discord 裡的風險。能做的範圍:

- 伴唱軌、導唱和歌詞只從會員的路由拿,而且要是這間房的人;網址 10 分鐘有效、綁登入的 session。
- `Cache-Control: private, no-store`,沒有下載鍵,AAC 128 kbps。
- 公開頁、SSE、連結預覽圖都不出現伴唱軌和歌詞。
- Core 上轉存的檔案在房間最後一次用到後 24 小時刪掉。
- 擋不住有心錄音的人;這只是不讓它變成公開的下載站。

### 13.4 要做的東西

| 地方 | 內容 | 約多大 |
|---|---|---|
| `workers/sing` | `purpose: karaoke`、`melody.py`(RMVPE → 切音符 → 品質檢查)、編碼三個檔、`reference.json`;mock backend 也要會 | 500 行 + 測試 |
| `packages/contracts` | worker 的請求欄位和 `KaraokeReference`;事件 `karaoke.room`、`karaoke.result`;Stage Link 的 `karaoke` 訊息;房間 WebSocket 的訊息 | 300 行 |
| `packages/play/karaoke`(新外掛,模組 `karaoke`) | 房間的狀態機(像 `table.ts`:時鐘、計時器都注入)、評分和音高軌的編解碼(`src/score/`,不依賴 Node)、重算和作弊標記、通知和提示詞區塊、工具、`/game karaoke`、魚幣;第 4 步的混音 | 1,500 行 + 測試 1,000 |
| `packages/api` | `karaoke-routes.ts`:房間列表、開房、加入、點歌、簽過名的檔案網址、結果;房間的 WebSocket(用已經在用的 `ws` 掛在 HTTP server 的 upgrade 上,或 `@hono/node-ws`,它也是包 `ws`) | 500 行 |
| `apps/panel` | 會員頁 `/karaoke`(房間列表)、`/karaoke/<房間>`(等人、試麥和校正、唱、結果);AudioWorklet 和 `pitchy` | 1,800 行 |
| `apps/overlay` | `layout=karaoke`:跑道、計分板、歌詞 | 600 行 |
| `packages/stage` | 轉送 `karaoke`、場景用途 `karaoke` | 150 行 |
| `packages/sing` | worker 用戶端的唱 K 工作和檔案、把伴唱軌串給 voice node | 200 行 |

外掛跟 `cards` 一樣:服務由外掛提供(`KaraokeKey`),路由在 api。

## 14. 分階段

| 步 | 內容 | 好不好玩 | 大小 |
|---|---|---|---|
| 1 | **單人網頁**:worker 的唱 K 工作(RMVPE + 自己切音符、行級歌詞)、會員頁點歌和唱、本機評分和畫面、延遲校正、結果送 Core 重算、她在房間掛的頻道講評。房間只有一個人、沒有 WebSocket(結果用一次 POST)、不收房費、不給魚幣 | 可以自己唱一首、看到音符條和分數、被她講評 | 中大,約 3,500 行含測試 |
| 2 | **多人房**:房間 WebSocket、對時、倒數同時開始、網頁上看得到別人的分數、重算和作弊標記、房費和魚幣、Discord 的加入卡片 | 朋友一起比分 | 約 2,500 行 |
| 3 | **直播**:overlay 版面、Stage 轉送、語音裡播伴唱軌、她開場和唱完講評、照規則的表情 | Discord 裡的人看得到在比什麼 | 約 1,500 行 |
| 4 | **單人播聲音**:Opus 上傳、Core 的緩衝和混音、同意和切掉 | Discord 裡聽得到唱的人 | 約 800 行 |
| 5 | **品質**:試 GAME / ROSVOT、字級歌詞、表現加分的細項、單人升降調、網頁旁觀 | | 看第 1–4 步的回饋 |

**不用找人就能測的**:

- worker:用 mock backend 跑完整流程;拿幾首歌的主唱看品質檢查和音符條(實驗放 `.tmp-test/karaoke/`,不進 git)。這次沒跑任何實驗。
- 評分:用歌自己的 `lead.wav` 當「唱的人」離線跑同一個評分模組,分數要很高;整首升一個半音要很低;延後 200 ms 節奏要說「偏慢」;低八度要和原調同分;加噪音、加伴奏漏音看有聲判斷。
- 整條網頁路:Playwright 開無頭 Chrome,`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<lead.wav>` 當麥克風;開幾個就是多人房。
- 對時:注入時鐘的單元測試,加上兩個無頭瀏覽器比較開始時刻。
- overlay:`?demo=1` 的假資料。
- 混音:Core 把混好的那段寫成 WAV 聽。
- 真的人聲、藍牙耳機、手機只能找人試;第 1 步做完請 owner 唱一首。

## 15. 來源

- 舊專案:`karaoke/README.md`、`docs/VALIDATION.md`、`engine/worker.py`、`engine/rosvot_engine.py`、`src/lib/music.ts`、`src/hooks/usePlayer.ts`(唯讀)。
- 音高和音符:[RMVPE](https://github.com/Dream-High/RMVPE)、[FCPE](https://github.com/CNChTu/FCPE)、[SwiftF0](https://github.com/lars76/swift-f0)、[pitch-benchmark](https://github.com/lars76/pitch-benchmark)、[ROSVOT](https://github.com/RickyL-2000/ROSVOT) 和[論文](https://arxiv.org/html/2405.09940v2)、[SOME](https://github.com/openvpi/SOME)、[GAME](https://github.com/openvpi/GAME)([技術報告](https://github.com/openvpi/GAME/blob/main/ALGORITHMS.md))、[basic-pitch](https://github.com/spotify/basic-pitch)、[PESTO](https://github.com/SonyCSLParis/pesto)。
- 瀏覽器:[pitchy](https://github.com/ianprime0509/pitchy)、[pitchfinder](https://github.com/peterkhayes/pitchfinder)、[aubio](https://aubio.org/)、[AudioWorklet 延遲的量測](https://jefftk.com/p/audioworklet-latency-firefox-vs-chrome)、[output latency](https://web.dev/articles/audio-output-latency)、[Mozilla 的 Windows 延遲回報](https://bugzilla.mozilla.org/show_bug.cgi?id=1375466)、[AllKaraoke](https://github.com/Asvarox/allkaraoke)(不看八度)、[Rhythm Quest 的校正](https://ddrkirby.com/rhythm-quest/devlog/10.html)。
- 歌詞:[WhisperX alignment](https://github.com/m-bain/whisperX)、[MMS_FA](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html)、[MFA 模型](https://mfa-models.readthedocs.io/en/latest/acoustic/index.html)、[SOFA](https://github.com/qiuqiao/SOFA)、[stable-ts](https://github.com/jianfch/stable-ts)(2026-05 封存)、[LRCLIB API](https://lrclib.net/docs.md)。
- 評分:[精密採点(ja.wikipedia)](https://ja.wikipedia.org/wiki/精密採点)、[DAM 開發者訪談](https://nlab.itmedia.co.jp/cont/articles/3272332/)、[粉絲的回歸分析](https://trs-ch.blog/post-9960/)、[JOYSOUND 分析採点](https://www.joysound.com/web/s/function/bunseki)、[非官方配分](https://cmkara.com/joy-bunsekisaitenmaster/1041/)。

## 16. 沒查證的

- RMVPE、FCPE、GAME、ROSVOT 權重的授權都沒寫;becruily 主唱模型也沒寫(backlog 已列)。只在 owner 和朋友的顯示卡上跑、不散布,權重不進 repo。
- GAME 的 F1 只來自它自己的技術報告;ROSVOT 領域外的數字論文沒寫是不是 F1。
- pitchfinder 的授權、aubio.js 實際上是不是 GPL。
- 2024 年後 Windows Chrome 的輸入延遲沒有新的量測;Firefox 和 Safari 的 `AudioEncoder`(Opus)支援程度沒查。
- 網易雲逐字歌詞的涵蓋率。
- DAM 的八度處理、容許範圍和顫音門檻;JOYSOUND 的真正配分。日文維基沒有「分析採点」的條目;一篇 JOYSOUND AI+ 的部落格打不開。
- 唱 K 工作要多久(§3.1 是估的);瀏覽器裡 McLeod 每次不到 1 ms 是推估,沒量。
- 沒有用真的人聲測過任何一段。

## 17. 要 owner 決定的

| # | 問題 | 建議的預設 |
|---|---|---|
| K1 | 房費、獎勵的數字(§12) | 開房 20、第一名 15、唱完 3、單人不給、都算進 `play_cap` |
| K2 | 海龜湯和猜歌要不要也收開房費 | 先不要:六天零次,收錢會更沒人開 |
| K3 | 「任何連結」:要不要放寬 worker 的網站白名單 | 不放寬(任意網址給 yt-dlp 是安全風險),白名單加歌名搜尋;要哪個網站再加 |
| K4 | 單人播聲音:誰可以 | 每首自己勾同意;她認識、沒被封鎖的人;房主和管理員可以切 |
| K5 | 導唱(原唱的主唱)可以開嗎 | 可以,只在自己的瀏覽器,預設關、音量 30% |
| K6 | 最多幾個人同時唱 | 4 |
| K7 | 授權沒寫的權重(GAME、ROSVOT)可以在自己的顯示卡上試嗎 | 可以試,不散布;CC BY-NC 的(SOME、MMS)不用 |
| K8 | 一定要她在語音裡才能開房嗎 | 不用;不在時只有網頁,結果和講評在文字頻道 |
| K9 | 贏了要不要給她一筆「敬意」的證據 | 要,和「一起玩過」一樣交給她每晚的反思決定份量 |
| K10 | 唱 K 的結果要不要讓別人看到(例如房間裡的排行) | 只在房間裡和直播上;會員頁只有自己的,沒有全站排行榜(和經濟的「不公開別人的數字」一致) |
