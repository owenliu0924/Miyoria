# Wordle 實測

讓一個真的模型(DeepSeek,或任何 OpenAI 相容的 API)透過 Wordle 擴充的工具玩一局,同時在 Wordle 頁面上看她打字、翻格子。不用開 Core、Discord 或 OBS,有 API key 就能跑。

## 跑法

在 repo 根目錄:

```bash
pnpm install && pnpm build
```

```bash
pnpm exec tsx --conditions=@miyoria/source tools/wordle-live/play.mts
```

第一行只要跑一次(建好 overlay 頁面和各個套件)。第二行跑起來會印出 Wordle 頁面的網址,例如:

```
Open the Wordle page: http://127.0.0.1:7999/?layer=wordle&ws=ws://127.0.0.1:7999/
```

用瀏覽器打開(或加進 OBS 當瀏覽器來源),10 秒後她開始玩。頁面由這個腳本自己提供,不用另外開 `pnpm dev`。

## API key

腳本依序找:

1. 環境變數 `LLM_API_KEY`;
2. repo 根目錄 `.env` 裡的 `LLM_API_KEY=`(`.env` 不會進 git,格式見 `.env.example`);
3. 都沒有就在終端機問,輸入的字不會顯示。

key 只用來呼叫 `LLM_BASE_URL` 的 `/chat/completions`,不會印出來,也不會寫到任何檔案。

## 選項

用環境變數設定:

| 變數 | 預設 | 做什麼 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 相容 API 的位址 |
| `MODEL` | `deepseek-chat` | 模型 id |
| `GAMES` | `1` | 連續玩幾局(局與局之間停 18 秒,讓上一局淡出) |
| `MAX_GUESSES` | `6` | 一局最多猜幾次(1 到 12) |
| `PORT` | `7999` | 頁面和盤面推送用的埠 |

例如用 bash 玩兩局、每局 8 次:

```bash
GAMES=2 MAX_GUESSES=8 pnpm exec tsx --conditions=@miyoria/source tools/wordle-live/play.mts
```

## 會看到什麼

終端機:

- `[她] …`:她每次猜之前說的想法;
- `→ wordle.guess {"word":"slate"}`:她呼叫的工具和參數,下面是擴充回給她的結果(🟩🟨⬛、剩幾次);
- 最後一段:每局猜中還是沒猜到、呼叫了幾次工具、Stage 丟掉了幾個盤面(應該是 0),以及 Wordle 場景的開關順序(每局應該是先 `true`,結束 15 秒後 `false`)。

頁面:跟擴充 README 的「直播畫面」一樣。逐字打字、翻格子、鍵盤變色、被退回的字會抖、猜中時那一列跳一下,結束 15 秒後淡出。

## 測到哪裡

| 有測到 | 沒測到 |
|---|---|
| 擴充在真的 SDK runtime 裡跑,用 JSON-RPC 的 `initialize` / `tools.call`,跟 extension host 呼叫它一樣 | Core 本身(對話、提示詞、她的人設) |
| 模型看到的工具跟 Core 給的一樣(`wordle.guess` 變成 `wordle_guess`) | Discord、語音 |
| 盤面經過 Stage 的 `Forwarder`、link schema 驗證、`OverlayHub`,再用 WebSocket 送到頁面 | OBS 和換場景的導演(只記錄 `WordleOnStream` 的開關) |

提示詞是腳本裡的簡化版,所以她說話的樣子跟正式直播不一樣;要看的是她會不會用工具、頁面跟不跟得上。
