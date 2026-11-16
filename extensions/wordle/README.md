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

畫面跟一般的 Wordle 一樣:上面標題、中間 6×5 的格子、下面鍵盤,只是打字的是她。

- 她猜的每個字都一個字母一個字母打進去(鍵盤上那顆鍵會亮),再按 Enter;
- 格子一格一格翻開,翻到一半才露出顏色:綠 = 位置對、黃 = 有但位置不對、灰 = 沒有;鍵盤跟著變色;
- 被退回的字(不在單字表、不到 5 個字母、已經猜過)那一列會抖,上面跳出原因,字母再一個一個刪掉;
- 猜中時那一列會跳一下,跳出「天才!」到「好險!」(看猜了幾次);沒猜到或放棄就跳出答案;
- 結束後停 15 秒再淡出。OBS 來源晚開或重新整理,會直接畫出正在玩的那一局。

運作方式:開局、每次輸入、放棄時,擴充都會發出 `ext.miyoria.wordle.board` 事件。Core 的 stage link 轉給 Stage,Stage 轉給 Wordle 頁面(`http://127.0.0.1:7884/overlay/?layer=wordle`,在 `apps/overlay`)。

### 場景

Wordle 頁面是全螢幕的,遊戲在左邊,右邊留給她的模型。給它一個場景:

1. `miyoria.toml` 的 `[modules."stage.link".scenes]` 加上 `roles = { …, wordle = "Wordle" }`;
2. 跑 `miyoria stage obs-setup`:會建好「Wordle」場景(背景、Wordle 頁面、她的模型站在右邊、overlay 在最上面)。

之後她一開局,導演就切到 Wordle 場景;結束 15 秒後切回原本該在的場景(聊天、遊戲…)。沒設 `wordle` 這個用途就不會切,頁面還是可以自己放進任何場景。

她邊猜邊講話,字幕照常出現,觀眾聽得到她怎麼想。好幾個頻道同時在玩時,畫面上是最後有動靜的那一局。不想上畫面就設 `show_on_stream = false`。

要看效果不用開直播:在 `apps/overlay` 跑 `pnpm dev`,打開 `http://localhost:5173/?layer=wordle&demo=1`,demo 會輪流玩一局猜中的和一局沒猜到的。

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
