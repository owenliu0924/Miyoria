# Wordle 擴充

讓她玩 Wordle:電腦想一個五個字母的英文單字,她一次猜一個,看提示再猜。全部在本機算,不連網路;答案只存在這個擴充的行程裡,到猜中、次數用完或放棄才會說出來。

## 工具

| 工具 | 做什麼 |
|---|---|
| `wordle.start` | 開一局(這個頻道已經有一局在玩就不重開) |
| `wordle.guess` | 猜一個字(`word`),回傳 🟩 位置對、🟨 有但位置不對、⬛ 沒有,和剩下的次數 |
| `wordle.status` | 看目前這局:猜過的字、剩幾次、字母表上哪些確定有、哪些確定沒有 |
| `wordle.give_up` | 放棄並公布答案 |

每個頻道各自一局。不是單字、長度不對、已經猜過的字會被退回,不算次數。重複字母照 Wordle 的規則算:綠色先算,黃色只標到答案還剩的次數。

## 直播畫面

開局、每猜一個字、放棄時,擴充都會發出 `ext.miyoria.wordle.board` 事件。Core 的 stage link 把它轉給 Stage,overlay(`apps/overlay`)就在畫面左邊畫出盤面:

- 六列五格(`max_guesses` 是幾就幾列,超過 6 列時格子會縮小);
- 新猜的字一格一格翻開,翻到一半才露出顏色:綠 = 位置對、黃 = 有但位置不對、灰 = 沒有;
- 結束後下面多一行「第 N 次就猜中了!」或「答案是 …」,停 15 秒再淡出;
- OBS 的來源晚開或重新整理,也會補上正在玩的那一局(已經結束的不補)。

她邊猜邊講話,字幕照常出現在下面,觀眾看得到她怎麼想。好幾個頻道同時在玩時,畫面上是最後有動靜的那一局。不想上畫面就設 `show_on_stream = false`;overlay 那邊也可以用 `?show=` 拿掉 `wordle`。

要看效果不用開直播:在 `apps/overlay` 跑 `pnpm dev`,打開 `http://localhost:5173/?demo=1`,demo 每輪會玩一局。

單字表是公開的 Wordle 清單:`words/answers.txt`(2314 個答案)和 `words/guesses.txt`(另外 10656 個可以猜的字)。

## 設定

1. 建置:先 `pnpm build` packages/sdk,再在這裡 `pnpm install && pnpm build`。
2. `miyoria.toml`:

```toml
[modules.extensions]
dirs = ["extensions"]

[extensions."miyoria.wordle"]
max_guesses = 6          # 可選,1 到 12
show_on_stream = true    # 可選,把盤面送到直播 overlay
```

之後在對話裡跟她說「來玩 Wordle」,她會自己呼叫工具。
