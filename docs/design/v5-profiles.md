# Profile:一個獨立的角色

> 2026-11-22。owner 的決定:一個 profile 是一個獨立的角色,一次只跑一個,角色之間什麼都不共用(成員、錢包、記憶都不共用);沒有面板上的切換鈕,也不同時跑兩個,換角色就是停掉、用另一個 profile 啟動。世界觀的詞(魚幣、深海交易所、五檔獨家股票)是 profile 的一部分,預設值是今天的,Miyoria 的行為和用字一個字都不變。電腦(hostd、配對過的電腦、`host.toml`)是共用的,不屬於任何 profile,換角色不用重新配對。現有的資料原地變成 Miyoria 的 profile,不搬、不改名、不刪。這是階段 6 的第一步。

## 1. 一個 profile 是什麼、在哪

profile 就是 `profiles/<id>/` 這個資料夾。它本來就放人格(`profile.toml`、`persona/`、`voice.toml`、`avatar.toml`、`lorebook.toml`);現在它也可以有自己的設定和資料:

```
profiles/<id>/
  profile.toml  persona/  voice.toml  avatar.toml  lorebook.toml   # 人格、聲音、模型(本來就有)
  miyoria.toml   # 她自己的設定:Discord 帳號和伺服器、[character]、世界觀的詞、各模組
  .env           # 她自己的祕密:LLM 金鑰、Discord token
  data/          # 她自己的資料庫和檔案
```

- **有自己的 `miyoria.toml`**:這個角色完全用它。設定檔裡的相對路徑(資料庫、`data/...`)從這個資料夾算,所以資料就在 `profiles/<id>/data/`。
- **沒有自己的 `miyoria.toml`**:用安裝資料夾的 `miyoria.toml` 和 `data/`,和有 profile 之前一樣。今天的安裝就是這樣:`core.profile = "deepseek-chan"`,`profiles/deepseek-chan/` 沒有自己的設定,所以 Miyoria 照舊跑在原本的設定和資料上,什麼都沒動。

資料庫裡的 profile id 本來就是資料夾名稱(`deepseek-chan`),不用改。

## 2. 怎麼選

依序:

1. 環境變數 `MIYORIA_PROFILE=<id>`(只看真的環境變數,不讀 `.env`)。只能選有自己 `miyoria.toml` 的 profile,或安裝設定本來就跑的那個。
2. 安裝資料夾 `miyoria.toml` 的 `[core] profile`(本來就有的鍵)。
3. 都沒有:`deepseek-chan`(本來的預設)。

`miyoria profile use <id>` 改的就是第 2 項(保留註解),下次啟動 core 生效;hostd 每次啟動 core 都重新讀這個檔,所以換角色是 `profile use` 再 `miyoria restart core`,hostd 不用重開。不另加命令列旗標:`--profile` 已經是 `stage obs-setup` 的選項(OBS 的設定檔),共用會混淆。

選好之後,有自己設定的 profile 的 `miyoria.toml` 要寫 `core.profile = "<id>"`、`core.profiles_dir = ".."`(`profile new` 會寫好);寫成別的就拒絕啟動,免得人格和資料對不起來。

## 3. 哪些指令跟著 profile

- **跟著**(她的設定、`.env`、資料):`core`、`chat`、`stage`、`config`、`doctor`、`db`、`memory`、`module`、`decisions`、`events`、`persona`、`discord`、`ext`、`profile validate`。有自己設定的 profile,`--config` 換成它的 `miyoria.toml`。
- **不跟**(這台電腦):`init`、`update`、`hostd`、`up`、`down`、`restart`、`status`、`logs`、`add`、`remove`、`models`、`host ...`、`profile list/show/use/new`。永遠用安裝資料夾的 `miyoria.toml`、`.env` 和旁邊的 `host.toml`。`doctor` 的電腦部分也用安裝資料夾的 `host.toml`。

**`.env`**:跟著 profile 的指令,在有自己設定的 profile 只載入它自己的 `.env`,不載入安裝資料夾的(別的角色的 Discord token 不能漏過來)。hostd 是用安裝資料夾的 `.env` 啟動的,它把整個環境傳給 core;所以環境裡和安裝資料夾 `.env` 一樣的值當成是從那裡繼承來的:profile 自己有就換成自己的,沒有就拿掉。其他真的設在環境裡的值照舊優先。

## 4. `[character]`:她是誰

在 profile 的 `miyoria.toml`(沒有自己設定的就是安裝資料夾那份):

```toml
[character]
name = "Miyoria"               # 她的本名
short_name = "Miyo"            # 大部分人怎麼叫她;"" = 沒有
other_names = ["米優", "みよ"]  # 簡稱的其他寫法
pronoun = "她"
exchange_name = "深海交易所"
```

每個欄位的預設值就是今天寫死的字,所以不寫這段的安裝一個字都不變(有測試逐字比對)。寫錯(例如 `name = ""`)Core 不啟動:不然她會用別人的名字起來。

- Core 開機時讀它,放進 `Profile.character`,並提供 `CharacterKey` 服務;模組從服務拿,沒有服務(單元測試)就用 `DEFAULT_CHARACTER`。
- **幣名**本來就是 `[modules.economy] currency`,在 profile 自己的設定裡,不再重複一份。
- 角色名字和人格的名字不同:`[character] name` 是她的本名,`profile.toml` 的 `display_name` 是人格的名字(Miyoria 演 DeepSeek-chan)。新角色兩個通常一樣。

## 5. 顯示

- CLI:`miyoria profile show`(名字、選擇的來源、設定檔、資料夾、人格)、`miyoria profile list`(● 是會跑的那個);`miyoria core` 啟動時記一行跑的是哪個。
- 面板:側欄的「她」那一塊顯示 Core 回報的名字;一行小字 `profile <id> · 自己的資料` 或 `安裝資料夾的資料`(`GET /api/profile`)。沒有切換鈕。

## 6. 開一個新角色

`miyoria profile new <id> --name <名字>`:建立 `profiles/<id>/`,從範本放人格(`profile.toml`、`persona/identity.md`、`style.md`)、從範例設定放 `miyoria.toml`(寫好 `[core]`、`[character] name`、`database_url = "sqlite:data/miyoria.db"`,不引用 `${DATABASE_URL}`,免得繼承來的變數指到別人的資料;擴充資料夾指回安裝資料夾的 `extensions/`)、`.env` 範本和空的 `data/`。資料夾已經存在就拒絕,不會寫進任何現有的 profile。寫好人格和 token 之後 `profile use <id>`。

`profiles/*/miyoria.toml` 和 `profiles/*/data/` 加進 `.gitignore`。

## 7. 這一步沒做的

| 項目 | 現況 | 之後 |
|---|---|---|
| **配對存在 Core 的資料庫** | `cluster_hosts` 等表在 Core 的資料庫,新角色有自己的資料庫,所以**新角色的 Core 一開始沒有任何配對過的電腦**。Miyoria 不受影響 | 把 `cluster_*` 搬到安裝資料夾的一個電腦資料庫(`data/machines.db` 之類),Core 開兩個 store;要改 `packages/cluster` |
| 獨家股票的名字和代號 | `RICE` `WHLE` `NAPS` `CUBE` `DPSK` 和它們的公司名在 `play/exchange` 的程式裡,跟訊號邏輯綁在一起 | 名字和代號移進 `[modules.exchange]`,邏輯用固定的內部 id |
| 還寫死的字 | 見本次的回報清單:面板公開頁的一部分、卡面圖、OBS 場景名、extensions 的預設值 | 一個套件一個套件換成 `CharacterKey` |
| `pronoun` | 只在換過的幾句用;大部分文字還是直接寫「她」 | 需要第二個代名詞的角色出現時再全面換 |
| 面板上建角色 | 不做(owner 決定沒有切換鈕) | — |
