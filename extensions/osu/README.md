# osu! 擴充(AI 玩家)

觀眾在 Discord 貼譜面連結點譜,直播機上的 osu! AI 照順序在遊戲視窗裡打;她(或管理員)也能叫 AI 進 lazer 多人房跟大家一起打、離開、單獨打一張譜。

AI 本體是 [osu_rl](https://github.com/SQL1024-sql/osu_RL) 的 vision 學生:一個只看遊戲畫面、自己決定每一步移動和按鍵的模型,不讀譜面。它坐在直播機上一個 osu_rl 自己 build 的 lazer(fork)前面,連 osu! 私人伺服器(例如 Illyaverse),登入 AI 自己的帳號。這個擴充只把指令轉成 osu_rl 那邊的 HTTP 呼叫,不碰遊戲本身。

```
觀眾 --/queue osu request--> miyoria.osu --HTTP--> osu_rl live.requests(live.stream)--bridge--> fork 視窗 <-- OBS
她 / 觀眾 --/queue osu status|join|leave、osu_ai_*--> miyoria.osu --HTTP--> osu_rl live.room_play(多人房、手動開的譜)
```

全部的打歌都是 vision 學生看畫面打:點播在背景擷取 fork 視窗、經 bridge 送動作;多人房擷取螢幕、用虛擬繪圖板打。

## 工具

| 工具 | 做什麼 | 權限節點 |
|---|---|---|
| `osu_ai_status` | AI 在不在多人房(哪一間)、正在打哪張、上一首打多少 | 無 |
| `osu_ai_list_rooms` | 列出開著的多人房 | 無 |
| `osu_ai_join_room` | 進房(`room_id`、可選 `password`),譜下載好就自己按準備,之後每一輪都一起打 | `tools.osu.play` |
| `osu_ai_leave_room` | 離開房間 | `tools.osu.play` |
| `osu_ai_play_map` | 打一張譜(`beatmap_id`):排進點播佇列,回排第幾首;成績之後用 `/queue osu list` 看 | `tools.osu.play` |

前四個要設 `seat_url`,`osu_ai_play_map` 要設 `queue_url`。`tools.osu.play` 在內建角色裡是 `trusted` 以上才有(`tools.*`)。服務出錯或連不上時,工具回 `失敗:<原因>`,不會讓回合當掉。

## 指令

| 指令 | 做什麼 | 權限節點(預設) |
|---|---|---|
| `/queue osu request <map>` | 點一張譜:`map` 是 osu.ppy.sh 上某個難度的連結(`…/beatmapsets/1#osu/2`、`…/beatmaps/2`、`…/b/2`)或譜面 id | `queue.request` |
| `/queue osu list` | 正在打的、排隊中的、剛打完的三首(準度和 miss) | `queue.list` |
| `/queue osu skip` | 跳過正在打的點播 | `queue.osu.skip` |
| `/queue osu clear [all]` | 清掉排隊中的點播;`all` 連正在打的也停 | `queue.osu.clear` |
| `/queue osu status` | AI 正在打哪張、在不在多人房、上一首打多少 | `queue.list` |
| `/queue osu join <room> [password]` | 讓 AI 進房間 `room`(房間連結最後的數字),譜下載好就自己按準備 | `queue.osu.room` |
| `/queue osu leave` | 讓 AI 離開房間 | `queue.osu.room` |

`queue.request`、`queue.list` 一般成員就有;`skip`、`clear`、`queue.osu.room` 是管理員才有(`queue.*`)。要換節點就設 `queue_permissions`。

整組譜的連結(沒有選難度)、其他模式的譜會直接回說為什麼不行,不會送到佇列。每個人同時最多點 2 首、整個佇列最多 30 首、同一張譜不能重複排,這些由 osu_rl 那邊判斷。AI 在多人房時點播照樣收,但先排著,離開房間後才打(`/queue osu list` 第一行會說)。

進房也可以由開台的人直接在直播機那個 lazer 裡操作;房主開打,或有人在那個 lazer 的選歌畫面按開始,AI 就看著畫面用虛擬繪圖板打。

## 只用 vision 打(0.2.0)

2026-11-17 起 osu_rl 只用 vision 學生上場。0.1.0 的工具和 join / leave 走的是 osu_rl 的 `live.service`(用讀譜面的 state 模型,沒有畫面),那個服務停用了,所以改成:

- 進房、離開、列房間、狀態改走 `live.room_play`:AI 坐在直播機的 lazer 前面,用 fork 的 bridge 進出房間、自己按準備。
- `osu_ai_play_map` 改成排進點播佇列,不再直接回準度、評級和 replay 連結。
- 拿掉強度(`level`、`osu_ai_set_level`)和手感(`feel`、`/queue osu feel`):vision 學生沒有這兩樣。
- 設定的 `url`、`public_url`、`account`、`blocked_accounts` 不再使用:AI 用哪個帳號改由 osu_rl 在每次進房和每打一首前自己檢查(只能是 AI 的帳號、連的是私人伺服器)。舊設定留著不會出錯。

## 設定

1. 照 osu_rl 的 [live/README.md](https://github.com/SQL1024-sql/osu_RL/blob/master/live/README.md) 在直播機開好 fork 和 `live.stream --requests 8766`(或 `live.requests`)、`live.room_play`,記下 `OSU_RL_CONTROL_TOKEN`。
2. 建置:先 `pnpm build` packages/sdk,再在這裡 `pnpm install && pnpm build`。
3. `miyoria.toml`:

```toml
[modules.extensions]
dirs = ["extensions"]
# 點一張沒抓過的譜要先下載整組譜;預設 30 秒可能不夠
call_timeout_ms = 120000

[extensions."miyoria.osu"]
queue_url = "http://127.0.0.1:8766"      # live.stream --requests / live.requests
seat_url = "http://127.0.0.1:8767"       # live.room_play
env = { MIYORIA_OSU_TOKEN = "<OSU_RL_CONTROL_TOKEN>" }
```

| 設定 | 環境變數 | 預設 |
|---|---|---|
| `token` | `MIYORIA_OSU_TOKEN` | 無(沒設會在 log 警告,每次呼叫都被拒絕) |
| `request_timeout_ms` | | `120000` |
| `queue_url` | `MIYORIA_OSU_QUEUE_URL` | 無(沒設就沒有點播指令) |
| `queue_permissions` | | `{ request = "queue.request", list = "queue.list", skip = "queue.osu.skip", clear = "queue.osu.clear", room = "queue.osu.room" }` |
| `seat_url` | `MIYORIA_OSU_SEAT_URL` | 無(沒設就沒有 `/queue osu status`、`join`、`leave` 和進房的工具) |

直播機不在同一台時,osu_rl 那邊加 `--requests-host 0.0.0.0`(`live.room_play` 用 `--host 0.0.0.0`),兩台之間走 Tailscale,manifest 的 `network` 也要改成那個位址。

## 測試

```bash
pnpm --filter @miyoria/ext-osu test
```

單元測試用一個假的點譜佇列和一個假的 `live.room_play` 跑完整的 SDK 流程(點播、清單、跳過、清除、狀態、進房、離開、五個工具、連結解析)。進房、自動準備、離開在真的房間裡還沒測過。2026-11-17 在直播機上用 HTTP 實際點過一張譜(DISCO★PRINCE Normal):osu_rl 從鏡像站下載整組譜、匯入 fork、vision 學生打完(r005 81.6%、r033 82.7%)。
