# 幫 Miyoria 架翻唱(sing)worker:給主機提供者的說明

你要做的是在你的電腦上跑 **sing worker**(點歌翻唱的 GPU 服務),Owen 的 Core 透過 **Tailscale** 連到你。你**不需要**跑 Core、Discord bot、ASR、TTS 或任何其他服務。

```
Owen 的電腦:Core ──HTTP──▶ Tailscale ──▶ 你的電腦:sing worker(:8005)
                  ◀── 做好的歌(音訊 + 歌詞資訊)
```

Core 送一個工作(`POST /jobs`),worker 做完(yt-dlp 下載 → 人聲分離 → 切主唱 → RVC 轉成她的聲音 → 混音 → 找歌詞),Core 再用 HTTP 把音訊抓回去播。

**已經裝過舊版?** 看下一節「升級」。**第一次裝?** 跳到第 0 節。

## 升級:你已經裝過舊版 worker

指令都在 PowerShell,在你 clone 下來的資料夾(`Miyoria`)裡執行。

**什麼變了、什麼沒變**

| | |
|---|---|
| 變了 | `workers/sing/server.py` 的請求格式(`/jobs` 等的 JSON 欄位)改成從 `workers/contracts.py` 匯入。**欄位本身一樣**,HTTP 內容沒變。所以整個 `workers/` 資料夾都要更新到同一版,只換 `workers/sing` 會啟動失敗(找不到 `contracts`) |
| 沒變 | `workers/sing/requirements.txt`(Python 套件不用重裝)、所有環境變數的名字和預設值、埠(8005)、`GET /health` 等路徑、模型(`models/`)、參考音(`voices/`)、歌曲快取(`data/songs`)。這些都不在 git 裡,更新程式碼不會動到它們 |
| 注意 | `contracts.py` 要用 pydantic,它是 worker 原本就裝的 `fastapi` 帶進來的,不用另外裝。`requirements-contracts.txt` 只給開發者重新產生 `contracts.py` 用,你不用裝 |

**1. 記下目前的版本**

```powershell
git log -1 --format="%h %cd"
```

把輸出記下來(升級後如果有問題,Owen 要看)。再看有沒有新檔案(`False` = 舊版):

```powershell
Test-Path workers\contracts.py
```

**2. 停掉 worker**

在跑它的視窗按 Ctrl+C。找不到視窗,就用這個看 8005 埠是誰在聽:

```powershell
Get-NetTCPConnection -LocalPort 8005 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, OwningProcess
```

沒有任何輸出代表 worker 本來就沒在跑。有結果就停掉它(把 `12345` 換成上面 `OwningProcess` 的數字):

```powershell
Stop-Process -Id 12345
```

**3. 更新程式碼**

先確認你沒有改過程式碼(輸出應該是空的;有列出 ` M` 開頭的檔案就先告訴 Owen,不要硬蓋):

```powershell
git status --short
```

```powershell
git fetch origin
```

```powershell
git switch main
```

```powershell
git pull --ff-only
```

**4. Python 套件要不要重裝**

從 `v4-last-run` 這版到現在,`workers/sing/requirements.txt` 沒有改,所以**不用重裝**,原本的 `workers\.venv-sing` 直接用。要自己確認的話,把第 1 步記下的版本號放進去,沒有任何輸出就是沒改:

```powershell
git diff <第 1 步的版本號> HEAD --stat -- workers/sing/requirements.txt
```

如果有輸出(以後的版本改了套件),在 `workers` 資料夾重跑(已裝好的會略過):

```powershell
.\.venv-sing\Scripts\python.exe -m pip install -r sing/requirements.txt
```

**5. 啟動**

照第 5 節的指令(`$env:HOST` 一定要設成你的 Tailscale 位址),在 `workers\sing` 裡啟動。

**6. 確認有起來**

先在你自己的電腦測(worker 綁在 Tailscale 位址,所以要用那個位址,不是 `127.0.0.1`;輸出有 `"status":"ok"`):

```powershell
curl.exe http://100.x.y.z:8005/health
```

再請 Owen 從他的電腦試 `Test-NetConnection 100.x.y.z -Port 8005`,`TcpTestSucceeded` 要是 `True`。

**7. 告訴 Owen**

- 升級前和升級後的版本號(`git log -1 --format="%h %cd"`)。
- `Test-Path workers\contracts.py` 的結果(要是 `True`)。
- 第 6 步 `/health` 的輸出。
- 沒起來的話:啟動視窗裡的錯誤訊息,和下面「疑難排解」第 1 項的輸出。

## 0. 需求

| 項目 | 需求 |
|---|---|
| 系統 | Windows 10/11(專案是照 Windows 做的;Linux 也能跑 worker 本身,但 `miyoria start` 的分頁啟動只支援 Windows Terminal) |
| 顯示卡 | NVIDIA,建議 8 GB 以上 VRAM;轉換階段 PyTorch 峰值約 3.2 GB,分離更高(不夠會自動退到 CPU,但很慢)。要先裝好 NVIDIA 驅動 |
| 軟體 | Git、Python 3.11–3.13、Node.js(yt-dlp 解 YouTube 要用)、ffmpeg(要在 PATH)、Tailscale |
| 硬碟 | 模型約數 GB,歌曲快取預設最多 6 GB(`SING_CACHE_MAX_GB`) |
| 網路 | 能連 YouTube(下載用)、`lrclib.net`(歌詞) |

## 1. 加入 Tailscale

1. 兩台電腦都裝 Tailscale。Owen 邀請你進他的 tailnet,或是你把你的機器分享給他(Tailscale 管理頁 → 機器 → Share)。
2. 在你的電腦查 Tailscale 位址:
   ```powershell
   tailscale ip -4        # 100.x.y.z
   ```
3. worker **沒有任何認證**,所以:
   - 把 worker 綁在這個 Tailscale 位址(不要綁 `0.0.0.0`),只有 tailnet 裡的裝置連得到;
   - 在 Tailscale ACL 只允許 Owen 的機器連你的 `:8005`;
   - 不要對外開 Windows 防火牆的 8005,只放行 Tailscale 網卡(用系統管理員 PowerShell 加規則):
     ```powershell
     New-NetFirewallRule -DisplayName "miyoria-sing" -Direction Inbound -LocalPort 8005 -Protocol TCP -InterfaceAlias "Tailscale" -Action Allow
     ```

## 2. 取得程式碼

```powershell
git clone https://github.com/owenliu0924/Miyoria.git
```

```powershell
cd Miyoria
```

整個 `workers/` 資料夾都要用,不能只拿 `workers/sing`(它會匯入 `workers/contracts.py`)。手動裝 worker 不需要 `pnpm install`。

## 3. 安裝 sing worker(手動,最不容易出錯)

在 `workers` 底下:

```powershell
cd workers
```

```powershell
python -m venv .venv-sing
```

先裝 CUDA 版 torch,不然 pip 會抓到 CPU 版:

```powershell
.\.venv-sing\Scripts\python.exe -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
```

```powershell
.\.venv-sing\Scripts\python.exe -m pip install -r sing/requirements.txt
```

(原始碼資料夾裡也有 `miyoria init` / `install` / `doctor` / `start` 這組指令可以代勞,效果相同,細節見 `workers/README.md` 的「快速安裝」。現在是在原始碼資料夾裡用 `pnpm dev <指令>` 跑,需要 Node 24 以上和 pnpm,從 `node scripts/setup.mjs` 開始。手動裝不需要這些。)

## 4. 模型與資料(需要 Owen 提供的部分)

預設轉換鏈是 `SING_VOICE=rvc`,需要下列檔案(放在 `workers/` 底下):

| 路徑 | 內容 | 來源 |
|---|---|---|
| `models/applio/` | Applio 原始碼 + 它自己的 `venv/`(RVC 在子程序裡跑) + 她的 RVC 模型 `logs/miyoria-deepseek-48k/miyoria-deepseek-48k_40e_11000s.pth` | **Owen 提供**(她的聲音模型,不進 git;用別的路徑就設 `SING_APPLIO_DIR` / `SING_RVC_MODEL`) |
| `voices/deepseek-chan/ref.wav`(+ `ref.txt`) | 她的參考音;worker 啟動時會檢查這個檔在不在 | **Owen 提供**(不進 git;或設 `SING_REF`) |
| `models/lead-split/becruily-bs/` | 主唱 / 伴唱分離模型 | Hugging Face `becruily/bs-roformer-karaoke` |
| `models/vocal-split/MelBandRoformer.ckpt` + `.yaml` | 人聲分離 | Hugging Face `KimberleyJSN/melbandroformer`;缺的話退回 Demucs(第一次自動下載) |
| `models/seed-vc/` | Seed-VC 原始碼(要有 `models/seed-vc/modules/` 這個資料夾) | github.com/Plachtaa/seed-vc。**不能略過**:worker 啟動時就檢查它在不在,沒有就啟動失敗(`Seed-VC not found at ...`),即使預設轉換鏈 `rvc` 用不到它 |

第一首歌會自動下載約 2 GB 的模型。她的 RVC 模型和參考音是 Owen 的聲音資產,請只放在你的本機,不要上傳或再分享。

## 5. 設定與啟動

在 `workers\sing` 底下啟動,用環境變數設定(這些只在這個視窗有效,關掉視窗要重設):

```powershell
cd sing
```

```powershell
$env:HOST = "100.x.y.z"          # 你的 Tailscale 位址(只聽 tailnet)
$env:PORT = "8005"
$env:SING_LYRICS_URL = "http://<Owen 的 Tailscale IP>:8007"   # 歌詞交給 Owen 那邊的歌詞服務(見第 6 節)
```

```powershell
..\.venv-sing\Scripts\python.exe server.py
```

重點環境變數(完整清單在 `workers/sing/server.py` 開頭的註解,說明在 `workers/README.md` 第 9 節):

| 變數 | 說明 |
|---|---|
| `HOST` / `PORT` | 綁定位址 / 埠,預設 `127.0.0.1` / `8005`。**一定要改成 Tailscale 位址**,否則 Owen 連不到 |
| `SING_OFFLOAD_URLS` | **留空**(預設就是空)。這是做歌時叫 TTS / ASR 讓出顯卡用的,你的電腦上沒有它們 |
| `SING_LYRICS_URL` | Owen 那邊的歌詞服務網址。找歌詞(含問 LLM、ASR 抽查)都在 Owen 那邊做,你不需要金鑰,也不用連 ASR。沒設的話你的 worker 會自己找,但找不到時沒有 LLM 可問 |
| `SING_LYRICS_ASR` | 設 `0` = 不做 ASR 抽查,也不會把主唱音軌傳給歌詞服務 |
| `SING_CACHE_MAX_GB` / `SING_CACHE_MAX_DAYS` | 歌曲快取上限,預設 6 GB / 14 天 |
| `SING_DATA_DIR` | 快取位置,預設 `<repo>/data/songs` |

啟動成功後,**在你的電腦上**先測(輸出有 `"status":"ok"` 就對了):

```powershell
curl.exe http://100.x.y.z:8005/health
```

## 6. Owen 這邊怎麼接上 Core

Owen 編輯 `miyoria.toml`:

```toml
[modules.sing]
url = "http://100.x.y.z:8005"     # 你的 Tailscale 位址
fallback_urls = ["http://127.0.0.1:8005"]   # 連不上你的時候,改用 Owen 自己電腦上的 worker
timeout_secs = 20                  # 跨網路建議放寬(抓歌的音訊自動乘 10 倍)
```

**連不上時退回 Owen 自己的 worker**(`fallback_urls`,可省略):新點的歌先送到 `url`,連不上(你的電腦關了、不在 tailnet 上)就依序送 `fallback_urls`。點歌的請求如果已經連上、只是回應逾時,就不換台(那台可能已經收下,換台會兩張顯卡各做一次),照單一 worker 的方式回報錯誤。一首歌在哪台做,之後查進度、抓音軌和影片都找同一台(檔案在那台);那台連不上超過 `fallback_retry_secs`(預設 30 秒)還是不回,這首歌就在下一台重做,原本那台回來時會取消留在它那邊的工作。連不上的那台這段時間內不再問,之後會再試,回來了新點的歌就又送回去。只有「連不上」才換台,worker 有回應的錯誤(例如連結的網域不允許)照常回報。同一個位址在 `url` 和 `fallback_urls` 重複寫只算一次。Owen 的電腦上要有在跑的 sing worker(`pnpm dev start` / `up` 的 inference 角色會啟動它;平常不佔顯卡)。

然後重啟 Core。在 Owen 的電腦測:

```powershell
curl.exe http://100.x.y.z:8005/health
```

```powershell
curl.exe -X POST http://100.x.y.z:8005/jobs -H "content-type: application/json" -d "{\"query\":\"Cartoon On & On NCS\"}"
```

```powershell
curl.exe http://100.x.y.z:8005/jobs/<id>     # state / stage / progress
```

**歌詞服務(Owen 這邊也要啟動)**:找歌詞要用 Owen 的 LLM 設定和 ASR,所以跑在 Owen 的電腦上,對方的 worker 透過 `SING_LYRICS_URL` 呼叫它。啟動(Owen 的電腦,在 `workers/` 底下):

```powershell
python -m venv .venv-lyrics
.\.venv-lyrics\Scripts\python.exe -m pip install -r lyrics/requirements.txt
$env:HOST = "100.a.b.c"     # Owen 自己的 Tailscale 位址
$env:PORT = "8007"
cd lyrics; ..\.venv-lyrics\Scripts\python.exe server.py
```

它沒有認證,一樣只綁 Tailscale 位址並用 ACL 只放行對方的機器。ASR 抽查預設連 `127.0.0.1:8003`(Owen 本機的 ASR),不用另外設定。對方傳過來的只有 16 kHz 單聲道的主唱音軌(每分鐘約 2 MB)。

注意:**不要**用 `miyoria init` 的 `[machine.hosts] inference` 去指到你的機器。那個欄位是「asr / tts / sing 同一台」的單一位址,會連 `ASR_URL` / `TTS_URL` 也一起改過去,但你這台沒有 ASR / TTS。直接手動改 `[modules.sing] url` 就好。

## 7. 已知限制(程式目前沒處理)

1. **歌曲影片**:Core 播歌前會從 worker 的 `/songs/{id}/files/video.mp4` 把影片下載到自己的 `data/songs/<id>/`,所以 worker 在別台也能放影片。前提是 Core 和 Stage 在同一台(Stage 讀的是 Core 這台的本機路徑)。
2. **歌詞對齊仍在對方的 worker**:歌詞服務只負責找歌詞和驗證,拿到歌詞後的時間對齊要讀音訊,在 worker 做。歌詞服務沒開時,這首歌沒有字幕,不會放錯的詞。
3. **做歌時不會再讓 TTS / ASR 讓出顯卡**:因為 worker 不在同一台,她說話和做歌不會互相搶 VRAM(反而更好),但也沒有「她先說一句我去準備歌」的流程;若 Core 端還是有這句提示,可以把 `[modules.sing] prepare_notice = false`。
4. **沒有認證**:全靠 Tailscale 隔離,請照第 1 節設 ACL / 綁定位址。
5. 這個 worker 一次只做一首歌(佇列),你那邊 GPU 被別的程式(遊戲)占住時會變慢。

## 8. 疑難排解

### Tailscale 能 ping 通,但 8005 埠連不上(逾時)

ping 通代表 Tailscale 本身沒問題。問題在 worker 沒在跑、綁錯位址、或被防火牆擋。**在你的電腦上**依序檢查:

**1. worker 有沒有在聽 8005?**

```powershell
Get-NetTCPConnection -LocalPort 8005 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, OwningProcess
```

- 沒有任何輸出:worker 沒啟動,或啟動時就出錯關掉了。回第 5 節啟動,並看視窗裡的錯誤訊息(例如 `No module named 'contracts'` 代表 `workers/` 沒更新完整,見「升級」第 3 步)。
- `LocalAddress` 是 `127.0.0.1`:忘了設 `HOST`,只有你自己這台連得到。關掉 worker,設好 `$env:HOST` 再啟動。
- `LocalAddress` 是你的 Tailscale 位址(和 `tailscale ip -4` 一樣):綁定正確,看下一步。(`0.0.0.0` 連得到但違反第 1 節,請改成 Tailscale 位址。)

**2. 從你自己的電腦用 Tailscale 位址連**

```powershell
Test-NetConnection 100.x.y.z -Port 8005
```

`TcpTestSucceeded : False`:worker 沒在聽那個位址,回上一步。`True` 但 Owen 還是連不上,看下一步。

**3. Windows 防火牆有沒有放行**

```powershell
Get-NetFirewallRule -DisplayName "miyoria-sing" -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Direction, Action
```

沒有結果就用第 1 節的 `New-NetFirewallRule` 加上(需要系統管理員)。規則裡的 `-InterfaceAlias "Tailscale"` 要和你的 Tailscale 網卡名稱一樣,用這個查:

```powershell
Get-NetAdapter | Select-Object Name, Status
```

**4. Tailscale ACL**

規則還是沒問題的話,是 Tailscale ACL 沒放行 Owen 的機器到你的 `:8005`(在 Tailscale 管理頁的 Access controls 看)。從 Owen 的電腦測:

```powershell
Test-NetConnection 100.x.y.z -Port 8005
```

### 其他症狀

| 症狀 | 檢查 |
|---|---|
| 啟動時說 reference voice not found | 缺 `voices/deepseek-chan/ref.wav` 或 `SING_REF` |
| 啟動時說 `cannot import name 'ConfigDict' from 'pydantic'` | venv 裡的 pydantic 是 1.x,`workers/contracts.py` 要 2.x。在 `workers` 底下跑 `.\.venv-sing\Scripts\python.exe -m pip install -U "pydantic>=2"` |
| 啟動時說 Seed-VC not found | 缺 `models/seed-vc/modules/`(或 `SING_SEEDVC_DIR` 指錯),見第 4 節 |
| 「RVC model or Applio not found」警告 | `models/applio/`(`core.py`、`venv/`、`.pth`)不完整,會退成別的轉換鏈 |
| 找歌卡住 | ffmpeg 不在 PATH、Node 沒裝、`SING_YTDLP_CACHE` 寫不進去 |
| 轉換很慢 | VRAM 不夠退到 CPU,或 GPU 被別的程式占住 |
