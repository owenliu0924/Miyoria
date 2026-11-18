# 線上唱 K:她當主持人

> 2026-11-17 規劃;2026-11-18 做了第一步(單人網頁唱 K,見「做了什麼(第一步)」)、第二步(歌詞核對、逐字對齊、讀音、升降調,見「做了什麼第二步」)和第三步(KTV 樣子的畫面、背景影片、用錄音算正式分數,見最後的「做了什麼第三步」)。依據是 owner 2026-11-17 的回答([v5-play.md](v5-play.md) §11.3),讀過舊的 `karaoke` 專案(SUMI,唯讀)和這個 repo 的唱歌 worker、派對遊戲、Stage、overlay、voice node、面板和經濟。模型和評分的資料是網路上查的,來源在 §15,沒查到的在 §16。數字標「草案」的都是設定。

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

麥克風的聲音在其他時候都不離開瀏覽器,沒有錄音功能。(第三步起改了:正式分數要一份這首歌的錄音,唱完送一次、算完就刪,見「做了什麼第三步」。)Core 存結果(四項分數、名次);音高軌留 7 天(查爭議、看作弊標記),之後刪掉。本人在會員頁看得到、刪得掉自己的結果;「請她忘記我」一起刪。

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

## owner 的決定(2026-11-17,看過這份設計之後)

| 題 | 決定 |
|---|---|
| 價格和獎勵 | 開房 20(沒人唱就退)、贏的人 15、唱完的人各 3、單人不給 |
| 海龜湯、猜歌開房 | 不收魚幣 |
| 歌的來源 | 沿用翻唱允許的網站清單,加上用歌名搜尋 |
| 單人時聲音播到 Discord | 她認識且沒被封鎖的人,每首歌自己勾同意;房主和 admin 可以切掉 |
| 原唱導唱 | 可以,預設關,音量 30% |
| 同時唱的人數 | 最多 8 個(直播畫面的軌道要排得下 8 條) |
| 授權沒寫明的模型(GAME、ROSVOT) | 可以試,不散布;之後由朋友那台(翻唱的那台)跑 |
| 她要不要在語音頻道裡才能開房 | 要 |
| 贏了算不算敬意的證據 | 算,比重她自己定 |
| 成績誰看得到 | 只有房間裡和直播上,沒有全站排行榜 |

改掉上面設計的三件事:

1. **音高偵測兩層**:畫面用快的(McLeod,即時畫音高線);算分用準的(同一段聲音在瀏覽器背景用神經網路模型再跑一次,慢零點幾秒沒關係),最後的分數以準的為準。做成可以換;先拿真人的清唱量 McLeod 和 RMVPE 差多少,夠準就省掉第二層。唱的人要戴耳機。
2. **算分不靠切好的音符**:分數是唱的音高曲線逐格對原唱的音高曲線。音符條只是畫面上的導引,切得不準不會扣分。
3. **切音符照歌詞的每個字,而且歌詞要自己聽過對過**。不沿用舊專案的切音符規則。owner:舊專案切得不準,(a) 音符條的起訖對不上聽到的字、(b) 一個字被切成好幾段或好幾個字黏成一條,兩種都有;音高抓錯應該是當時沒有先分出主唱。舊專案的紀錄:歌詞完全靠 WhisperX 辨識(那首日文歌 27 行有錯字);v3 照辨識出來的字切,字的時間錯了就出現 17 秒的音符;v4 起改成不看歌詞,音符和字不保證對得上。這一版的做法:
   - 查歌詞(現有的 lrclib、網易雲)和整首辨識(分離出來的主唱)都做,逐行比對。對得上的行用查到的文字;對不上的行標成不確定,不拿來切音符;整首都對不上就是查錯歌,不用。
   - 文字確定的行用強制對齊算每個字的起訖;一個字一條音符,高度取那段的主唱音高,字裡面轉音再依音高細分。
   - 對齊完再驗一次:字的那一段要真的有人聲和音高;對到無聲、或一個字拖得過長,那一行算對齊失敗。
   - 不確定或失敗的行退回只用音高切,歌詞照樣顯示但不逐字上色。
   - 辨識和對齊用哪個模型,拿幾首中文和日文歌實測,把每個字畫在聲音上給 owner 看了再定(候選:WhisperX、現在的 Qwen3-ASR、唱歌專用的對齊模型)。日文漢字要先轉讀音,特殊讀法會錯。
   - 面板上有編輯器可以修逐字時間和音符,修過的版本存起來以後都用它。

## 做了什麼(第一步)

2026-11-18,分支 `v5p5d`。§14 的第 1 步:單人網頁唱 K。照 owner 的三個改變做:分數只比音高曲線、不看音符;偵測做成兩層的介面(這一步兩層是同一條);音符這一步全部是「只用音高切」的退路。**沒有下載任何新模型**(owner 還沒同意下載,硬碟也快滿),需要新模型的部分都只做了介面和最簡單的退路,下面標「等模型」。

### 走一遍

1. 會員在面板 `/karaoke` 貼連結或打歌名(`POST /api/member/karaoke/songs`)。同一個連結或同一組字就是同一首,不再做一次;新的一首算進那個人當天的 `daily_songs`。
2. Core 經唱歌模組提供的 `KaraokeWorkerKey`(同一批唱歌 worker、同一套 failover,沒有第二個 worker 用戶端)送 `POST /jobs {purpose: "karaoke"}`,每 3 秒看一次進度,會員頁顯示階段、進度和排隊位置。
3. worker 下載、分離、分出主唱、RMVPE、查歌詞、編碼,不做轉換。做好後 Core 把 `reference.json` 和 `karaoke.m4a` 抓到自己的 `cache_dir`,品質不過、太長或失敗就寫一句原因。
4. 會員先做一次延遲校正(每台裝置一次),再開始唱(`POST .../songs/{id}/sessions`):拿到兩個 10 分鐘的簽名網址,瀏覽器用 Web Audio 播伴唱軌、AudioWorklet 跑 McLeod、畫跑道和歌詞。
5. 唱完瀏覽器把音高軌(50 Hz、一格一個位元組、base64)和延遲送一次(`POST .../sessions/{id}/result`)。Core 用同一個評分模組重算、存起來、標作弊、送她一則通知、記 `played_together`,回傳 Core 的結果;瀏覽器先顯示自己算的,收到後換成 Core 的。
6. 她在講評頻道照平常的方式回一句;那個頻道 3 分鐘內她的第一句當成講評,結果頁每 5 秒問一次,出現就顯示。

### `reference.json`(第 1 版)

定義只有一份:`packages/contracts/workers/src/karaoke.ts`(zod,`WorkersKaraokeReferenceSchema`;Python 端是 `workers/contracts.py` 的同名 pydantic 模型,worker 的測試用它驗證輸出)。時間都是從伴唱軌開頭算的秒數。標題、歌手、歌詞來自 YouTube 和 lrclib,不可信。

| 欄位 | 內容 | 這一步 | 之後 |
|---|---|---|---|
| `format`、`version` | `"miyoria.karaoke.reference"`、`1` | | 格式改了才升版 |
| `id`、`title`、`artist`、`duration_s` | worker 上的唱 K 歌 id(`k-<來源>`)和歌的資料 | | |
| `backing` | 伴唱軌的檔名,`karaoke.m4a` | 伴奏 + 和聲(有主唱分離時;沒有就只有伴奏),AAC 128 kbps、48 kHz 立體聲、響度照翻唱的 | `guide.m4a`(導唱)、`play_karaoke.pcm`(給 voice node)還沒做 |
| `pitch` | `{hz: 50, start: 0, midi: [MIDI 小數或 null]}`:主唱的音高,`null` 就是沒聲音(有聲旗標) | RMVPE(10 ms)→ 比主唱有聲格的中位響度低 30 dB 的算沒聲音 → `clean_f0` → 兩格併一格(有聲的平均)→ MIDI,兩位小數 | 換準的模型只改這裡 |
| `notes` | `[{start, end, midi, source, line, char}]`:畫面上的音符條,**只是導引,不影響分數** | 全部 `source: "pitch"`,`line`、`char` 是 `null`(切法見下) | 歌詞確定的行改成 `source: "lyric"`,一個字一條,`line` / `char` 指到那個字 |
| `lyrics` | `{provider, timing, lines: [{start, end, text, check, confidence, chars}]}` 或 `null` | 現有的查歌詞(lrclib / 網易雲 + 整體位移),`timing: "line"`;`end` 是下一行開始(最後一行到主唱最後有聲的格);`check: "unchecked"`、`confidence: null`、`chars: null` | 整首辨識逐行比對後填 `check`(`matched` / `uncertain` / `failed`)和 `confidence`;強制對齊後填 `chars` 和 `timing: "char"` |
| `quality` | `{ok, reason, voiced_ratio, notes, lead_split}` | 有聲少於 15% 或音符少於 30 個就 `ok: false`(worker 的環境變數 `SING_KARAOKE_MIN_VOICED`、`SING_KARAOKE_MIN_NOTES` 可改);工作照樣 `done`,Core 不開放這首 | |
| `made` | `{pitch: "rmvpe", notes: "pitch-runs-1", lyrics: "line" / "none"}` | 之後換方法時知道哪些要重做 | |

**只用音高切的音符(`workers/sing/melody.py`,退路)**:50 Hz 曲線、每段有聲裡先做 0.1 秒的中位數濾波;離目前這條音符的中心(到目前為止的中位數)超過 0.65 半音、持續 60 ms 就從離開的那一格開新的一條;同音高的空隙 120 ms 以內接起來(子音);短於 80 ms 的丟掉;長於 4 秒的平均切開;音高取那段原始曲線的中位數。這是 owner 說「不沿用」的那種切法,所以只當退路、只當導引。

### 評分(`packages/play/karaoke/src/score/`,`@miyoria/play/karaoke/score`)

純 TypeScript,不 import 資料夾外的東西、沒有 DOM 也沒有 Node,面板經窄的路徑對應拿它(和 `@miyoria/types/bond` 一樣),Core 也用它。同樣的輸入得到同樣的結果;瀏覽器最後顯示的分數就是拿要送出的那條軌算的,所以和 Core 一樣。瀏覽器 100 Hz 的原始軌和送出的 50 Hz 軌,測試釘住差不超過 1 分。

- **對齊**:唱的軌減掉裝置延遲(`latency_ms`),每一句(歌詞的行;沒有歌詞就用參考曲線的休止切句)取唱的人和原唱差的中位數,四捨五入到八度,那一句就在那個八度比。低八度唱和原調同分。
- **每一格**:參考有聲的格,差在容許範圍(`tolerance_cents`,50)內算滿分,到兩倍時降到 0;沒出聲的格算沒對。
- **音程 60**:有聲格的平均得分 `hit`,從 0.15(亂唱大約拿到的)到 0.9 線性對到 0–60。
- **安定 15**:參考曲線上停在同一個音 0.4 秒以上的段落(從曲線找,不用音符),唱的人和參考的差先做 9 格移動平均(把顫音平掉)再取標準差,12 cents 以下滿分、60 以上 0;唱不到一半的段落算 0。
- **節奏 15**:參考的每個起音(休止 60 ms 以上之後、長 0.15 秒以上),在 ±0.3 秒裡找唱的人最近的起音(音高差在一個半音內),取中位數(偏快 / 偏慢)和分散度:中位數 60 ms 內、分散 40 ms 內滿分。**只有做過校正才算**;沒校正就照音程的比例給,結果寫「沒有校正延遲」。
- **表現 10(加分)**:顫音(4.5–8 Hz、±15–100 cents,0.5 秒的窗用正弦擬合,而且那一段要跟著參考)每 1.5 秒 1 分最多 4;長音(參考停 1 秒以上、九成的格唱對)每個 0.6 最多 3;しゃくり(進音前 160 ms 內從低一個半音以上滑上來,原唱自己沒有滑)每個 0.3 最多 1.5;フォール(句尾原唱休止時往下掉一個半音半)每個 0.3 最多 1.5;再乘上 `min(1, hit / 0.6)`,音不準就拿不到。
- **每一句**:分數(0–100)、`hit`、有出聲的比例;最好和最弱的一句(有聲 0.5 秒以上的才算)。
- **給她的事實**:總分、四項、節奏偏快 / 偏慢多少、八度、整體偏高 / 偏低多少 cents、出聲的比例、最好和最弱的一句(和那一行的前 16 個字)、顫音秒數、長音個數、和自己之前最好的比。
- **太完美**:兩邊都有聲的格九成以上離參考不到 15 cents(而且唱了參考有聲的八成以上),或已經有七成五很接近、起音的分散小於 10 ms。送出的軌是四分之一半音一階(最多差 12.5 cents),所以門檻是 15。被標的結果照樣顯示、寫「沒有驗證」,不算最好成績,她不知道;原因在 owner 的 `GET /api/karaoke/results`。
- **即時分數**:`LiveScore` 只算音程那一項,隨著偵測更新,也給畫面用的八度。

量過的(合成的歌、合成的唱的人,`packages/play/karaoke/test/score.test.ts`):像人的好歌手約 97,鬆一點的約 94,低八度同分,整首高一個半音約 31(音程 0),晚 150 ms 有校正約 97、沒扣延遲但有校正約 78 而且說「偏慢」、沒校正約 80,不出聲 0,亂數 0–1,照抄參考 97 而且被標。**沒有真的人聲量過。**

### 瀏覽器(`apps/panel/src/pages/public/karaoke/`)

- **偵測**:`PitchDetector` 介面(`name`、`size`、`detect(frame, sampleRate)`),現在是 pitchy 的 McLeod(2048 樣本的窗),跑在 AudioWorklet 裡(`pitch.worklet.ts?worker&url`),每 480 樣本一次,帶窗中點的音訊時鐘時間;清晰度 ≥ 0.9 而且 RMS 超過底噪兩倍才算有聲。分數用的軌從 `ScoreTrackSource` 來;這一步它就是畫面那一條(`liveTrackSource`),畫面不提分層。**等模型**:第二層(準的偵測,例如 SwiftF0 或 RMVPE 的 ONNX)接成另一個 `ScoreTrackSource`。
- **延遲校正**:先量 1.2 秒底噪,再放 8 聲嗶(每 0.75 秒),每聲拍手或唱「啦」,取起點差的中位數;超過 250 ms 提醒換有線耳機。結果存在瀏覽器(`localStorage`,鍵含麥克風的 deviceId),可以手動加減(−200 到 +800 ms)。沒量過時用瀏覽器給的 `baseLatency + outputLatency + 20 ms`,送出時 `calibrated: false`。
- **唱**:伴唱軌用 `fetch` 拿成 ArrayBuffer、`decodeAudioData`,不用 `<audio>`,沒有下載鍵;麥克風關掉回音消除、降噪、自動增益。跑道:現在的線在 25% 寬,桌面 8 秒、手機 5 秒,音域是整首加減 3 個半音(至少 14 個);參考曲線(細線)、音符條、唱的人的線(搬到參考的八度);歌詞一行加下一行;即時分數;暫停、從頭、唱完了、離開;頁面寫「麥克風的聲音只在這個瀏覽器裡處理,不會送出去」和戴耳機。
- **結果**:總分、四項各一行字、每一句(有歌詞的寫出那一行)、出聲比例、之前最好、「沒有驗證」、她的講評。
- **支援**:先做桌面 Chrome / Edge;沒有 AudioWorklet、麥克風、安全連線,或 AAC 解不開時,頁面說明為什麼不能唱。
- **示範**:開發伺服器開 `/karaoke?karaoke-demo`:假的 API、假的唱的人,不要 Core 和麥克風;正式建置不含它。

### Core(`packages/play/karaoke`,模組 `karaoke`)

- **表**:`karaoke_songs`(來源鍵唯一、worker 的工作和歌 id、狀態)、`karaoke_requests`(每天的上限)、`karaoke_sessions`、`karaoke_tracks`(音高軌,7 天後刪)、`karaoke_results`(四項、整份結果的 JSON、標記和原因、她的講評);migration 1 由 `schema:sql karaoke` 產生。事件 `karaoke.scored`(唱的人的 DM 範圍,留一年)。「忘記我」刪掉那個人的 session、軌、結果和請求,歌留著;合併時搬過去。
- **檔案**:準備好時抓到 `cache_dir/<歌>/`,一天沒人唱就刪,再唱時從 worker 再抓。簽名網址:HMAC(模組啟動時產生的金鑰)簽 session、檔名、帳號和到期時間,10 分鐘;還要會員的 cookie,帳號要對得上;錯的一律 404;`no-store`、沒有 `content-disposition`。
- **收軌的檢查**:session 是他的、還開著、沒過期;軌不比歌長 5 秒以上;從開始到送出的時間不少於軌的長度減 5 秒(事先做好的軌來得太快);一個 session 只收一次。
- **她**:一則通知(和卡片、市集一樣是 Observation,來源 `game.karaoke`,內容標成不可信),有講評頻道而且唱了一成五以上時可以開口,否則只讓她知道。她的模型呼叫就是她平常的那一個回合,唱的時候沒有任何模型呼叫。唱了三成以上記一筆 `played_together`。
- **沒有魚幣**(單人不給,owner 的決定)。
- **狀態卡**:會員頁開不開、準備好幾首、準備中幾首、worker 在不在、她講不講評;圖示 `mic-vocal`。

### 等模型、還沒做的

| 什麼 | 現在 | 等什麼 |
|---|---|---|
| 歌詞要先對過聽到的(owner 決定 3) | 查到什麼用什麼,每行 `check: "unchecked"` | 整首辨識(候選 WhisperX、現在的 Qwen3-ASR 拿主唱跑)和逐行比對;owner 看過實測再定模型 |
| 每個字的時間、照字切音符 | 沒有,`chars: null`,不逐字上色 | 強制對齊(WhisperX 的 wav2vec2、MFA、SOFA 實測);日文漢字先轉讀音 |
| 準的音符(GAME / ROSVOT) | 只用音高切 | owner 同意下載後在朋友那台試 |
| 第二層偵測(瀏覽器背景的神經網路) | 介面在,兩層同一條 | 先拿真人清唱比 McLeod 和 RMVPE 差多少;夠準就不做 |
| 修逐字時間和音符的編輯器 | 沒有 | 字級時間做出來之後 |
| 導唱、`play_karaoke.pcm` | 沒做 | 第 3 步(直播) |
| 房間、多人、直播、播聲音、魚幣 | 沒做 | 第 2–4 步 |
| 試麥時偵測「沒戴耳機」 | 只有提醒 | 第 2 步的試麥 |

### 測試

- worker:`workers/tests/test_sing_karaoke.py`(切音符、50 Hz、響度門檻、品質、歌詞的行、格式,和 mock 後端跑完整個工作、m4a 用 ffprobe 驗、`/songs` 不列、第二次是快取)和 `test_sing_gpu.py` 的四個(唱 K 不叫語音下線)。都不用 GPU、不連網。
- 評分:`packages/play/karaoke/test/score.test.ts`(好歌手、低八度、差一個半音、晚 150 ms 有沒有校正、不出聲、亂數、照抄參考、最弱的一句、沒有歌詞時切句、唱一半、和 100 Hz 的差、顫音、しゃくり、長音、即時分數)。
- Core:`packages/play/karaoke/test/service.test.ts`(準備、上限、失敗的原因、簽名網址、重算和通知和講評、只收一次、太快、標記、清理、忘記我)。
- **不用人的整條路**:`packages/api/test/karaoke.test.ts`:記憶體裡的 worker 準備一首合成的歌,經會員路由和簽名網址拿檔案,把參考曲線本身、晚 150 ms 的好歌手(有校正 / 沒扣延遲 / 沒校正)、高一個半音、亂數、低八度的「唱的人」照瀏覽器的方式記錄、編碼、送進路由,Core 重算,分數都合理。
- 面板:`karaoke-logic.test.ts`(時鐘、跑道的座標、校正的數學和儲存、階段的字、結果的字、軌的編解碼)和 `karaoke.test.tsx`(歌單、點歌、拒絕、準備中、失敗、結果的講評和「沒有驗證」)。

真的人聲、真的麥克風、藍牙耳機和手機都還沒試過;第一步做完請 owner 唱一首。

## 對齊實驗(2026-11-18)

實驗在 `.tmp-test/align-lab/`(不進 git;第二輪的報告是那裡的 `ROUND2.txt`)。歌詞查自 lrclib,主唱用 worker 的 becruily 分離;驗證是「一行的(正規化後)字有多少照順序出現在辨識結果裡」,matched ≥ 0.75、uncertain 0.5–0.75、failed < 0.5;「錯的歌詞」是拿另一首同語言的歌詞來比。對齊的「整行都過」:一行每個字都有時間、每個字的條裡有人聲、不超過 6 秒、順序對,而且第一個字離那一行的時間不到 1 秒。

### 第一輪(CPU;Qwen3-ASR-0.6B 和 Whisper large-v3-turbo;五首)

| 歌 | 行 | 0.6B matched / uncertain / failed | Whisper | 對齊整行都過:Qwen-FA / w2v / MMS |
|---|---|---|---|---|
| 又三郎(日) | 42 | 31 / 3 / 8 | 30 / 1 / 11 | 10% / 36% / 64% |
| キス(日) | 46 | 29 / 15 / 2 | 34 / 5 / 7 | 13% / 52% / 67% |
| 海百合(日,初音) | 80 | 19 / 24 / 37 | 39 / 22 / 19 | 13% / 48% / 59% |
| 英文歌 | 82 | 55 / 14 / 13 | 56 / 12 / 14 | 49% / 98% / 89% |
| 中文歌(68 秒) | 12 | 10 / 1 / 1 | — | 8% / 75% / 83% |

錯的歌詞:兩個辨識都是 0 行 matched(Whisper 一首有 1 行 uncertain)。MMS 的條有人聲的比例 92–98%,Qwen-FA 只有 58–82%。

### 第二輪(GPU;櫻ノ詩完整版 237 秒,難的歌;又三郎再一次)

| | 櫻ノ詩(23 行) | 又三郎(42 行) |
|---|---|---|
| 驗證 matched / uncertain / failed:0.6B | 13 / 9 / 1 | 31 / 3 / 8 |
| 1.7B | **17 / 5 / 1** | 30 / 4 / 8 |
| Whisper(7 行捏造「ご視聴ありがとうございました」之類) | 12 / 1 / 10 | 32 / 1 / 9 |
| 錯的歌詞 matched | 三個都 0 | 三個都 0 |
| 沒有歌詞時整首辨識的 CER(假名):0.6B / 1.7B / Whisper | 43% / **28%** / 80% | 20% / **18%** / 42% |
| 能回收的行(≥ 0.75):0.6B / 1.7B / Whisper | 7 / **15** / 4(共 23) | 29 / **30** / 16(共 42) |
| 對齊整行都過:Qwen-FA / w2v / MMS | 0% / 13% / **95.7%** | 11.9% / 35.7% / **64.3%** |
| 對齊有人聲的條:Qwen-FA / w2v / MMS | 52.8% / 61.7% / 99.7% | 70.0% / 83.5% / 92.8% |
| 短於 60 ms 的條:Qwen-FA / w2v / MMS | 46.9% / 40.8% / 0.3% | 29.1% / 16.1% / 9.7% |

GPU(4070 SUPER,fp16):1.7B 驗證 17 秒、整首辨識 45 秒,VRAM 4.8 GB;MMS 一首 1.3 秒,1.8 GB(30 秒的窗 2.9 GB);w2v(只能 fp32)18 秒,2.8–3.9 GB。特殊讀法(即興劇=エチュード、詩=うた)會讓那幾行掉到 uncertain,把讀音寫進去對 MMS 幾乎沒差(95.7% → 95.7%)。

**結論(owner 的決定)**:辨識只用 Qwen3-ASR-1.7B(驗證和聽寫同一個);對齊在 owner 的實例用 MMS_FA(非商業),repo 的預設是授權乾淨的 w2v;門檻照上面;Whisper 不用(幻聽)、Qwen3-ForcedAligner 不用。

## 做了什麼第二步

2026-11-18,分支 `v5p5h`。owner 的三個改變裡「切音符照歌詞的每個字,而且歌詞要自己聽過對過」的大半,加上讀音和升降調。**沒有下載、沒有跑任何模型**;模型的部分全用假的測,真的模型和真的人聲都還沒試。

### 唱歌 worker

唱 K 的工作在 `reference`、`encode`、等歌詞之後多兩個 GPU 階段(`lyrics_asr`、`lyrics_align`),之後才把顯示卡還回去:

1. **核對**(`lyrics_asr`):每一行查到的歌詞,取「開始前 0.5 秒到下一行開始後 0.3 秒、最長 12 秒」那一段主唱給 Qwen3-ASR-1.7B 聽,比對(中文轉簡體、日文轉平假名讀音、英文字母)得到相似度和 `matched` / `uncertain` / `failed`。整首 matched ≥ 50%:用查到的歌詞(`kept`);20–50%:照樣用,每行留著自己的狀態(`doubtful`,這一段 owner 沒說,是我的假設);< 20%:查錯歌,丟掉,改聽寫。
2. **聽寫**(同一個階段,模型不重新載入):沒有查到歌詞、或查錯歌時,整首主唱切成 20–30 秒、切在最安靜的 0.1 秒,每塊給 1.7B 聽。
3. **對齊**(`lyrics_align`):只對 matched 的行(聽寫的話是每一塊)。字切成「片」:中文一個字、日文一個假名(一拍)或一個漢字詞、英文一個字;對齊的單位是拍(日文)/ 字。`w2v`:每個語言一個 wav2vec2 CTC 模型(日文、中文 jonatasgrosman XLSR-53,英文 facebook base-960h,都是 Apache-2.0);`mms`:torchaudio MMS_FA 的權重(轉成 transformers 格式的那份),羅馬拼音,頭尾加 star。CTC 的 Viterbi 自己寫(`lyricsync.ctc_align`,numpy),不依賴 torchaudio 的版本。
4. **整行檢查**(實驗的那一套):每個字都要有時間、條裡有人聲(50 Hz 參考曲線有聲的格至少兩格且四分之一)、不超過 6 秒、順序對、短於 60 ms 的條不超過四分之一、第一個字離那一行的時間不到 1 秒。不過就那一行不逐字(`aligned: false`)。
5. **音符**:對齊過的行一個拍 / 字一條,高度是那段主唱曲線的中位數;一個字裡唱出幾個各 0.15 秒以上的音(轉音)就照音高再細分(用第一步的切法)。其他行留著第一步只用音高切的音符。**不會比第一步差**:任何一步失敗都退回第一步的樣子。
6. **聽寫的行**:對齊後在停頓 ≥ 0.4 秒處切行,超過 10 秒的行在最長的停頓再切;一行裡有人聲的條不到一半的丟掉(開頭和間奏的「はい」「このようにして」這類)。聽寫的行狀態都是 `uncertain`、`source: "heard"`。

兩個模型各用一個子程序跑(`workers/sing/align/run.py`),跑完程序結束,顯存就還了;一次只有一個模型。因為 qwen-asr 要 transformers 4.57.6、Seed-VC 要 4.46.3,它們有自己的環境 `workers/sing/align`(`uv sync --frozen`;`SING_ALIGN_PYTHON` 可指定)。沒有這個環境、或沒有模型檔時,歌詞照第一步不核對(`status: "unchecked"`)。模型檔在 `service.toml` 的 `[[install.files]]`(都 `optional`,放在模型資料夾的 `karaoke/`)。

**換調**:`POST /karaoke/{id}/keys {semitones: -6..6}`,worker 用 Rubber Band(ffmpeg 的 `rubberband` 濾鏡,和翻唱換調同一個;R2 引擎、`pitchq=quality`、長度不變,所以參考的時間不用動)把伴唱帶做一份 `karaoke.k+3.m4a`,同一首同一個調只做一次,歌重做時一起刪。ffmpeg 沒有 Rubber Band 時退回 `asetrate` + `atempo`(音色會跟著變)。選 Rubber Band 是因為它在鼓和和弦上比相位聲碼器乾淨很多,worker 本來就用它。

### `reference.json` 第 2 版

定義還是 `packages/contracts/workers/src/karaoke.ts`(`WorkersKaraokeReferenceV2Schema`;讀的人用 `WorkersKaraokeReferenceSchema`,第 1、2 版都收,`karaokeReferenceV2` 轉成第 2 版的樣子)。和第 1 版不同的:

| 欄位 | 內容 |
|---|---|
| `lyrics.source` / 每行 `source` | `found`(查到的)或 `heard`(聽寫) |
| `lyrics.language` | `ja` / `zh` / `en` / `null` |
| `lyrics.check` | `{matched, uncertain, failed, verdict: kept / doubtful / wrong_song / unchecked}`,沒有查到歌詞時 `null` |
| 每行 `status` | `matched` / `uncertain` / `failed` / `unchecked`(取代第 1 版的 `check`) |
| 每行 `similarity`、`heard` | 相似度、那一段聽到的字(給之後的編輯器) |
| 每行 `aligned` | 有逐字時間而且過了整行檢查 |
| 每行 `pieces` | `[{text, sung, start, end, reading, roman}]`:合起來就是那一行;日文漢字詞的 `reading` 是假名(unidic),`roman` 是羅馬字(pykakasi);中文 `reading` 是帶聲調的拼音(pypinyin) |
| 每行 `edited` | 之後的編輯器用;worker 寫 `false` |
| 音符 `source: "lyric"` | `line` 是行,`char` 是 `pieces` 的索引 |
| `made.asr`、`made.aligner` | `qwen3-asr-1.7b`、`w2v` / `mms` |

### Core

- 設定(系統頁「歌詞」組):`aligner`(`w2v` / `mms`,說明寫了 CC-BY-NC-4.0)、`lyrics_matched`、`lyrics_uncertain`、`lyrics_keep_share`、`lyrics_wrong_share`。每首點歌時一起送給 worker(`karaoke_lyrics`);已經準備好的歌不重做。
- migration 2:`karaoke_sessions.shift`、`karaoke_songs.lyrics_source`。歌單的 `lyrics_source` 讓會員頁標「聽寫的歌詞」。
- 換調:`POST .../sessions` 可以帶 `{shift}`;Core 叫做那首歌的 worker 做那個調的伴唱帶、抓回來、簽名網址指到它(只有那個 session 拿得到);重算分數時參考曲線也移同樣的半音(`shiftKaraokeReference`)。

### 會員頁

- 歌詞:對齊過的行一片一片從暗變亮(不加新顏色);沒對齊的行整行顯示,和第一步一樣。聽寫的歌詞旁邊有「聽寫」標籤(歌單上寫「聽寫的歌詞」);查到但對不上的行加點狀底線,滑過寫「這一行和聽到的不太一樣」。
- 讀音:「不顯示 / 假名 / 羅馬字」(日文)或「不顯示 / 拼音」(中文),用 `<ruby>` 放在字上面;預設不顯示,選的記在瀏覽器。讀音是 worker 給的(和對齊用的是同一份),瀏覽器不用另外裝字典。考慮過瀏覽器端的 kuroshiro + kuromoji(字典十幾 MB,讀音可能和對齊的不同)、pinyin-pro、wanakana,都沒用。
- 換調:開始前「− 原調 +」,每按一次就重新開一次 session、載入那個調的伴唱帶;記在瀏覽器,每首歌各自的。

### 還沒做、要真的跑過才知道的

| 什麼 | 狀況 |
|---|---|
| 真的模型 | 1.7B、w2v、MMS 都沒在 worker 裡跑過;align 環境 `uv lock` 過、沒 `uv sync` 過。MMS 用的是 MahmoudAshraf 轉的 transformers 版,和實驗用的 torchaudio 原版應該一樣,沒驗證 |
| 日文 w2v 的輸入 | 實驗給的是平假名讀音,這裡也是;模型的字表沒有小的母音、ぢ、ぷ等幾個假名,換成最近的(ぷ→ぶ);還是沒有的單位和前一個平分時間 |
| 特殊讀法 | 還是 unidic 的讀法;實驗建議「對不上的行如果聽到的讀音長度合理,拿聽到的讀音去對齊」,沒做 |
| hostd 的 GPU 租約 | 兩個新階段的 VRAM 預估(5.2 / 4 GB)只在 worker 自己決定時用;hostd 那邊用它自己的預設 |
| 第二步結束前 worker 一直握著 GPU 的租約 | 包括等歌詞查詢的時間;karaoke 只用 share,不會讓語音離線 |
| 編輯器 | 資料的樣子準備好了(`edited`、`heard`),畫面沒做 |
| 會員頁沒在瀏覽器裡實際看過 | 元件測試有,示範模式(`?karaoke-demo`)有對齊、拼音、不確定的一行和換調 |

## 做了什麼第三步

2026-11-18,分支 `v5p5i`。三件事:唱的畫面重做成 KTV 的樣子、背景影片、用錄音在伺服器算正式分數(owner 決定裡「音高偵測兩層」的第二層,改成在唱歌 worker 上跑,不在瀏覽器)。**沒有下載、沒有跑任何模型**;真的人聲、真的麥克風、真的影片都還沒試。

### 唱的畫面

owner 說原本的畫面完全不能用(一行字 15 px 在左下角,讀音 6.3 px),整個重做。參考 owner 自己的舊專案(SUMI 的 `Stage.tsx`、`KaraokeLyrics.tsx`、`PitchGraph.tsx` 和截圖)和 JOYSOUND;兩邊不同時照舊專案。顏色、字、圓角、玻璃照 `apps/panel/DESIGN.md`,沒有新的視覺語言。

| 從哪裡來 | 做法 |
|---|---|
| 舊專案 | 影片鋪滿整個舞台當背景;音高跑道橫在上面、不加框;兩行歌詞置中、偏下;現在這行最大 52 px、下一行 38 px(手機 24 px),白字黑邊,唱到的地方換顏色 |
| 舊專案 | 跑道:桌面 10 秒寬、手機 6 秒,「現在」的線在 28%;整首一個固定的音域,至少 18 個半音、上下各留 4 個;每個半音一條淡線、每個 C 一條深一點的 |
| 舊專案 | 音符條唱過就變暗、正在唱的最亮;唱的人的線對音時和不對音時兩個顏色,斷 0.12 秒以上就斷開;休止後的那一行前面有四個倒數點 |
| JOYSOUND | 下一行先擺在位置上、沒亮;讀音在字的上面(桌面至少 12 px) |
| 刻意不同 | 顏色只用面板的兩個強調色(上色和對音用主色,不對音用第二色);控制列放在舞台下面,不浮在上面(手機上才不會蓋到歌詞);手機上影片 `contain`、`sm` 以上 `cover`(直的螢幕不會被裁太多);沒有影片時的靜態背景是看的人在面板選的背景,調暗;拿掉暫停(owner 的清單沒有,而且會打斷錄音的時間軸),空白鍵只開始 |

- 控制列:開始、從頭、唱完了、升降調、讀音、延遲校正、離開;安靜,不和歌詞搶。即時分數標「預估」,錄音中標「錄音中」。
- 「聽寫」標籤和不確定那一行的點狀底線照留;逐片上色用第二步算好的時間。
- 減少動態(`prefers-reduced-motion`):影片不播,只有靜態背景;上色一片一片跳,不滑。
- 手機 375 px:左右 16 px、沒有橫向捲動,歌詞 24 px、讀音 12 px。

### 背景影片

- **worker**:唱 K 的工作(請求的 `karaoke_video`,預設是)用翻唱那一套抓來源的影片(`VideoFetch`,和翻唱共用來源資料夾的那一份),和聲音的階段並行;最後多一個進度權重 0 的階段 `video` 等它(最多 `SING_VIDEO_WAIT_S`)。再做唱 K 自己的 `video.mp4`:沒有聲音、最高 `SING_KARAOKE_VIDEO_HEIGHT`(720)、最多 `SING_KARAOKE_VIDEO_KBPS`(1,500 kbps)、H.264 yuv420p、`+faststart`(瀏覽器邊讀邊播)、剪到伴唱軌的長度。來源已經是夠小的 H.264 就直接複製,不然用 libx264 重編。拿不到、轉不了都只是沒有影片(`video_error`),歌照樣好。之前做好的歌沒有影片,不為了它重做。
- **時間軸**:查過聲音那一路只剪尾巴不剪頭(下載轉 WAV 的 `-t`、`min(lengths)`;歌詞的 `offset_s` 只動歌詞),所以伴唱軌的 0 秒就是下載的聲音的第一個樣本。影片檔自己的開始時間用 ffprobe 看:第一格晚 0.1 秒以上就用第一格補,早就剪掉,0.1 秒內當成編碼器的延遲不動。`-avoid_negative_ts make_zero` 試過會讓畫面晚約 66 ms,沒用。做了什麼記在那首歌 meta 的 `video`(`method`、`width`、`height`、`kbps`、`offset_s`、`start_s`)。
- **Core**:歌準備好之後再抓影片(唱不需要它,抓失敗只是沒有);簽名網址和伴唱軌一樣綁 session、帳號和會員的 cookie,`no-store`、沒有 `content-disposition`,只是有效期是整個 session(影片邊播邊用 Range 讀;最多是最長的歌三倍加半小時);檔案路由回應一個 byte range(206,`accept-ranges`),範圍解析是自己寫的十幾行(`range-parser` 只是間接依賴、不能裝新的;`@hono/node-server` 的 `serveStatic` 是照資料夾給檔,不合簽名查檔)。設定:`video`(關掉就不要、也不放已有的)、`video_keep_hours`(影片在 Core 留多久,預設 24,和其他檔案一樣)。
- **面板**:`<video>` 靜音、`playsInline`、沒有控制列、不能子母畫面,**跟著伴唱軌的音訊時鐘走**:差 0.25 秒以上就跳過去,小的差用 `playbackRate` 微調;歌沒在播就停;從頭、跳轉跟著音訊,反過來永遠不會。影片出錯或卡住就換回靜態背景,不擋唱歌。

### 正式分數(用錄音)

1. 開始唱時 session 帶 `recording`(上限 8 MiB、歌長加 30 秒);設定 `voice_score` 關掉或沒有唱歌 worker 時是 `null`,只有預估。
2. 唱的時候瀏覽器用 `MediaRecorder` 錄麥克風(單聲道,從和音高偵測同一個 Web Audio 時鐘的單聲道輸出錄;Opus `audio/webm`,再來 `audio/ogg`、`audio/mp4`;約 32 kbps,一首 4 分鐘約 1 MB),記下錄音第一個樣本在歌裡的時間(`offset_ms`)。從頭唱就丟掉重錄;超過上限就停錄、這一首只有預估。
3. 唱完先照舊送音高軌(`recording: true`),Core 存成**預估**(`source: "estimate"`、`voice_state: "waiting"`),先不告訴她;再送一次錄音(`POST /api/member/karaoke/sessions/{id}/voice?offset_ms=`,body 是錄音本身)。
4. Core 檢查(是這個人的、結果已經在、還在等錄音、格式、大小,一個 session 只收一次),回 202,在背景交給任何一台回應的唱歌 worker(`POST /karaoke/voice`;逾時的那台不換下一台再送,錄音不送兩次)。
5. worker 存在自己的資料夾(`<資料夾>/_voice`,不在快取裡),ffmpeg 轉 16 kHz 單聲道,RMVPE(和參考旋律同一個),再做和參考一樣的響度門檻、`clean_f0`、50 Hz MIDI,回音高、長度、有聲格的中位響度(`level_db`)和整段第 10 百分位(`floor_db`)。回答前刪掉兩個檔;開機和每次請求都清掉 10 分鐘以上的殘檔;不記錄錄音的內容。
6. Core 把錄音放進歌的時間(下面),用**同一個評分模組**、同樣的升降調和延遲算分,換成**正式分數**(`source: "voice"`、`voice_state: "scored"`,預估分數留在 `estimate_total`),錄音的音高(不是聲音)存在音高軌旁邊、一樣 7 天後刪;事件多一筆 `karaoke.scored`,`source: "voice"`(舊的事件讀成 `estimate`)。之後要發魚幣的功能只認 `voice`。
7. 她的講評:有要送錄音時等正式分數,最多 `voice_wait_secs`(預設 90 秒);等不到就用預估告訴她(之後正式分數照樣換上結果頁,但不再告訴她一次)。
8. 結果頁:「預估」→「正在算正式分數」→「正式分數」(旁邊小字寫預估是多少);失敗就留在預估,寫一句原因。

**錄音的規則**

| | |
|---|---|
| 誰能送 | 那個 session 的會員(cookie、CSRF 標頭),結果已經交了、而且交的時候說了要送 |
| 幾次 | 一個 session 一次;交結果後 3 分鐘內沒送到就不收了(`failed`,留預估) |
| 多大 | 8 MiB(Core 讀的時候就數,超過就停);worker 那邊同樣 8 MiB、長度最多 `SING_MAX_SECONDS` + 30 秒 |
| 格式 | `audio/webm`、`audio/ogg`、`audio/mp4`(worker 測試另收 `audio/wav`) |
| 在 Core | 只在記憶體,交給 worker 後清成 0;不寫檔、不記錄 |
| 在 worker | 讀完音高就刪;殘檔 10 分鐘內刪;不記錄 |
| 留下什麼 | 錄音的音高(50 Hz、四分之一半音)和響度兩個數字,7 天;聲音本身不留 |

**顯示卡**:很短,不能讓正在做的翻唱等。worker 的工作迴圈在每個工作外面拿 `voice_lock`;錄音的請求不等鎖:拿得到(沒有工作在跑)就經現有的 GPU 仲裁(自己判斷或 hostd 的租約都可以)當一個看不見的工作、用 `reference` 階段的 VRAM 估計、只用 share 模式(不叫語音下線),`SING_KARAOKE_VOICE_WAIT_S`(5 秒)內排不上顯示卡就改用 CPU;拿不到(有工作在跑)就直接用 CPU,不經仲裁,正在跑的工作一點都不停。

**時間對齊**:瀏覽器說的 `offset_ms` 是錄音器 `start` 事件時歌的時間,錄音器自己的啟動延遲不知道。Core 在它前後 0.5 秒內滑動錄音的音高,找和瀏覽器自己那條音高軌(同一支麥克風)最多格對上的位置(差 50 cents 內,八度摺疊);對上的格少於 2 秒就照瀏覽器說的。對齊後錄音和瀏覽器的軌在同一條時間軸上,所以裝置延遲(`latency_ms`)照樣扣。合成的測試裡晚 0.3 秒、瀏覽器說 0.25 秒,找回來差不到一格(20 ms)。

**八度錯誤**:RMVPE 的八度跳動由 `clean_f0` 修(和參考同一套);整句唱低八度由評分本來就有的「每一句取八度」處理;對齊時也摺疊八度。

**用喇叭時伴奏被收進去**:瀏覽器關掉回音消除,所以喇叭的伴奏(含和聲)會進麥克風,RMVPE 也會把它讀成音高。做了的:
- `bleed`:參考裡 2 秒以上沒有人聲的地方(前奏、間奏、結尾,合計至少 5 秒),錄音有四成以上的格有音高,就說「間奏也收到了音高,可能是喇叭的伴奏,請戴耳機」。
- `quiet`:有聲格的中位響度低於 −48 dBFS,或只比底噪高不到 8 dB,說「收到的聲音很小,分數可能不準」。
- 太完美(第一步的檢查)照樣用在正式分數上:直接對著麥克風放原唱會被標。
- 這三種都**照樣顯示分數、但不算最好成績**(`unranked`),原因在 owner 的結果列表。

沒解決的:唱的時候伴奏和人聲混在一起分不開(沒有回音消除、沒有參考訊號相減),所以用喇叭又沒被上面抓到的,分數可能偏高或偏低;門檻都是猜的,沒拿真的錄音量過。導唱(原唱的主唱)沒有做,所以不會從喇叭漏出原唱的旋律本身;以後做導唱時要重看。

**不給錄音的人**:瀏覽器不支援 `MediaRecorder`、沒給麥克風錄音、超過上限,或 owner 關掉 `voice_score`:照舊只有預估,`voice_state: "none"`,結果和講評都正常。

### 欄位和設定

- 契約:`KaraokeSongView.video`;`KaraokeSession.video_url`、`recording`;`KaraokeSubmit.recording`;`KaraokeResult.source`、`voice {state, estimate_total, checks}`;owner 的結果列表多 `source`、`voice_state`、`estimate_total`。worker 的 `WorkersKaraokeSong.video`、`WorkersSingJobRequest.karaoke_video`、`WorkersKaraokeVoicePitch`、`KARAOKE_VIDEO_FILE`、`KARAOKE_VOICE_MAX_BYTES`。事件 `karaoke.scored` 多 `source`。`workers/contracts.py` 是照產生器的寫法手改的(這台沒有裝 `datamodel-code-generator`,沒跑 `gen_contracts.py --check`)。
- migration 3:`karaoke_results.source`、`voice_state`、`estimate_total`、`checks`;`karaoke_songs.video`;`karaoke_tracks.voice_frames`。
- 設定:`voice_score`(評分組)、`voice_wait_secs`(講評組)、`video`、`video_keep_hours`(新的「背景影片」組)。

### 還沒做、要真的試過才知道的

| 什麼 | 狀況 |
|---|---|
| 真的 RMVPE 讀錄音 | 沒跑過;CPU 上和工作的 GPU 同時跑、hostd 接不接受同一台 worker 的第二個短租約,都沒在真的機器上看過;hostd 卡住時要約 10 秒才退回 CPU |
| 錄音 | `MediaRecorder` 實際的格式和位元率、Safari 的 MP4、`offset_ms` 和 Core 對齊的結果,都要真的麥克風 |
| 背景影片 | 真的影片的同步(跳轉、微調速度)、重編要多久、亮的影片上歌詞看不看得清楚 |
| 漏音的門檻 | `bleed`、`quiet` 的數字是猜的 |
| 示範模式的影片 | 沒有(做一個要即時錄整首的 canvas),示範裡那首的影片網址故意是壞的,看得到退回靜態背景 |

### 測試

- worker:`workers/tests/test_sing_karaoke.py`(影片做出來、沒有影片、請求不要影片、轉檔失敗歌照樣好、`video` 旗標)和新的 `test_sing_karaoke_voice.py`(回答合格式、50 Hz、檔案刪掉、太大 413、格式 415、壞的 400、有工作在跑時用 CPU、閒著時經仲裁、殘檔清理)。
- 評分:`score.test.ts` 多「錄音」一組(在瀏覽器的軌附近找到位置、八度摺疊、沒得對時照瀏覽器說的、對齊後和直接算的差不到 1 分、`bleed` 和 `quiet`)。
- Core:`service.test.ts` 多兩組(正式分數換掉預估、講評只講一次而且用正式分數、只收一次和格式大小、worker 不在時留預估、等不到時的上限、設定關掉、聲音太小;影片抓來、連結撐整個 session、關掉時不要也不放、自己的保留時間)。
- 路由:`packages/api/test/karaoke.test.ts`(錄音經路由、202、413、415、409、別人的 404;影片的 Range 206 和 416;範圍解析)。
- 面板:79 個唱 K 的測試(影片同步的判斷、錄音格式和上限、開始時間、預估和正式的結果、`bleed`、歌詞字級和讀音、聽寫和不確定的標記)。

