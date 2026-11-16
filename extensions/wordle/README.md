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

單字表是公開的 Wordle 清單:`words/answers.txt`(2314 個答案)和 `words/guesses.txt`(另外 10656 個可以猜的字)。

## 設定

1. 建置:先 `pnpm build` packages/sdk,再在這裡 `pnpm install && pnpm build`。
2. `miyoria.toml`:

```toml
[modules.extensions]
dirs = ["extensions"]

[extensions."miyoria.wordle"]
max_guesses = 6   # 可選,1 到 12
```

之後在對話裡跟她說「來玩 Wordle」,她會自己呼叫工具。
