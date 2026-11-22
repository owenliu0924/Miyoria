# 很多地方:Space、Room 和每個地方的設定

> 2026-11-22。階段 6「很多地方」的第一步(P1 基礎):她在幾個伺服器裡、哪個是原本的那個、誰是哪裡的成員,以及一個模組的設定怎麼在每個伺服器、每個頻道不同。這一步只做介面、資料和兩條路由;模組、設定頁和 Discord 的多伺服器是後面的步驟(§8)。單一伺服器的安裝升級後行為不變。v5-architecture §6 是為什麼,這份是做成什麼樣。

## 1. 模型

| 東西 | 在哪 | 說明 |
|---|---|---|
| **Space** | identity 的 `spaces` | 一個 Discord 伺服器。`id` 是 ULID,表和路由都存它;`external_id` 是 guild id。`left_at` 有值表示她已經離開(列都留著) |
| **主要的 Space** | `spaces.is_primary` | 安裝原本的那個伺服器:沒指定伺服器時的預設(管理頁、階段 6 之前的資料)。最多一個;不會自己移動,她離開了也一樣 |
| **Room** | `rooms` | 頻道、討論串(`parent_id` 是它的頻道)、語音房、私訊(沒有 Space) |
| **成員** | `space_members` | 在那裡說過話的帳號。說話就是成員,`platform.member` 的離開把 `left_at` 寫上,再說話就清掉 |
| **地方的設定** | `place_settings(scope, scope_id, plugin, key)` | `scope` 是 `space` 或 `room`,`plugin` 是模組 id,`key` 是欄位路徑。沒有另外一張每個 Space 的設定表 |

兩個服務,Core 提供,介面在 `packages/types/src/places.ts`:

- **`Places`(`PlacesKey`)**:`primary()`、`spaces()`(她還在的,主要的排第一)、`space(id)`、`room(id)`、`at(ctx)`(一個 `ContextKey` 在哪個 Space、Room、session,只讀不寫)、`ofGuild(platform, guild)`、`channelSpace(platform, channel)`、`members(space)`、`spacesOf(person)`、`isMember(person, space)`、`seen` / `left`(她加入、離開一個伺服器)、`memberLeft`、`onChange`。實作是 `store/src/identity/places.ts` 的 `SpacePlaces`。
- **`PlaceConfig<T>`(`PlaceConfigKey`,模組用 kernel 的 `placeConfig(ctx, Schema)` 拿)**:`base()`(cluster 的值)、`for(where)`(某個地方的值)、`onChange`。實作是 `core/src/place-config.ts`。

`ContextKey` 這一階段還是線上和程式裡的型別,`Places.at` 是它到 Space / Room 的橋。分享的「這個 Space 的成員」(`artifacts/membership.ts`)就是 `Places.isMember`,規則沒變。

## 2. 每個功能的範圍(定案)

| 功能 | 範圍 |
|---|---|
| 錢包、簽到、運勢、餵食、任務、禮物、卡片、羈絆、人物筆記 | 每個人,全域 |
| 交易所(市場、價格) | 全域。富豪榜、成交量榜:全域,也有每個 Space 的(那個 Space 的成員) |
| 贊助榜 | 全域,也有每個 Space 的 |
| 拍賣、樂透 | 每個 Space |
| 點歌優先券 | 價格和每天上限全域;用在那個 Space 的佇列 |
| 預測 | 每個 Space(成員看得到、能下注);錢還是全域的。懸賞:每個 Space |
| 卡拉 OK | 歌、參考、分數是每個人全域;KTV 房和留言頻道每個 Space |
| 貼圖、表情和它們的說明 | 每個 Space |
| 問題回報 | 全域;記下發生的地方當脈絡 |
| 她的房間基金、彈幕、螢幕留言、摸頭 | 全域(一個舞台、一個直播) |
| 卡片掉落 | 每個 Room 自己開;每人每天上限全域 |

設定也照這張表標:每個 Space 的是 `market.*`、`karaoke.comment_channel`、`cards.drops` / `drop_channels`、Discord 的 `ambient_text`、表情和貼圖、`queue.*`;每個 Room 的是話多話少、語音的模式和活躍度、新的 `language`、`actions.forbidden`(union)、Discord 的跟隨頻道。她自己的時鐘(`arbiter.day_start_hour`、`llm.budget.timezone_offset_hours`)和每個人的日界(`utc_offset_minutes` 那幾個)留在全域。

## 3. 設定怎麼解析

欄位在 zod 上用 `setting({...})` 標(v5-settings §2),多兩個 meta:

- `scope`:`cluster`(預設,一個值)、`space`(每個伺服器可以不同)、`room`(每個頻道可以不同,沒設的頻道跟它的 Space)。
- `merge`:`replace`(預設,最近的贏)或 `union`(只對清單有意義:每一層的項目都算)。

只有 `scope` 是 `space` 或 `room` 的欄位會疊。一個欄位的值,依序取第一個有的:

1. 這個 Room 的(`place_settings` scope `room`)
2. 這個 Room 的上層頻道的(討論串的頻道)
3. 這個 Space 的(scope `space`)
4. cluster 的值:模組啟動時的段落(`miyoria.toml` 加面板的那一層)
5. schema 的預設值

`space` 欄位跳過 1、2。之後 agent 自己再套 profile 的預設(值是 `null` 時)。

**兩條規則**:

- **頻道要在那個 Space 裡**:`channel` 種類的欄位,解析給 Space S 的值如果指到不在 S 的頻道,就不算:單一頻道退回 schema 的預設值(通常是空的 = 關),清單拿掉那幾個。不然 cluster 層的拍賣頻道會讓第二個伺服器發到第一個伺服器去。怎麼知道頻道在哪:context key(`discord:<guild>:<channel>`)自己寫著伺服器;裸的頻道 id 先查 identity 的 `rooms`,沒看過的再問 Discord 的即時清單(`PlaceDirectoryKey`)。**都不知道的頻道**:主要的 Space 照用(今天的單一伺服器就是這樣),其他 Space 只有在值是它自己設的(Room 或 Space 那一層)時才用。
- **union 合併**:`merge: "union"` 的清單是 cluster ∪ Space ∪ 上層頻道 ∪ Room(去重,照這個順序),所以禁止清單這種東西,一個頻道沒辦法解開 cluster 禁止的。

**不用重啟**:結果照地方快取;模組的 `place_settings` 一寫(`PlaceSettings.onChange`)或有新的 Space、Room(`Places.onChange`)快取就丟掉,下一次 `for()` 就是新的值,`onChange` 的監聽者會收到是哪裡變了。所以模組要在用到值的地方讀 `cfg.for(...)`,不要在 `start` 讀一次存起來。cluster 層的值(面板的模組設定)照舊是存了就重啟那個模組(v5-settings §5.1)。地方的值不合 schema 時,那一個欄位略過並記一次警告,其他照用。

## 4. 模組怎麼找到自己的 Space

| 從哪裡 | 怎麼做 |
|---|---|
| 指令、一輪對話 | `places.at(inv.context)`;設定直接 `cfg.for(inv.context)` |
| 匯流排的事件 | 信封的 `space_id` |
| 會員路由 | `memberSpace(state, person, input.query.space)`(`api/src/space-param.ts`) |
| 管理路由 | `adminSpace(state, input.query.space)` |
| 每個 Space 一份的排程 | `places.spaces()` 逐一跑,`cfg.for({ space_id })` 有開的才做 |

`home` 不屬於任何 Space(§8 的 P3)。

## 5. Migration

`identity` v2(`store/src/identity/migrations.ts`,在所有外掛之前跑):

```sql
ALTER TABLE spaces ADD is_primary integer DEFAULT false NOT NULL;
UPDATE spaces SET is_primary = 1 WHERE id = (她還在的 Space 裡成員最多的,同數取最早加入的,再取 id 最小的);
CREATE INDEX space_members_account_idx ON space_members (account_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX spaces_primary_idx ON spaces (is_primary) WHERE is_primary = 1;
```

- 原地升級:不搬檔案、不刪任何列、已經跑過的 migration 不改(有 checksum)。今天的安裝只有一個伺服器,它就是主要的。
- 一個 Space 都沒有的資料庫沒有主要的;`Identity` 之後看到的第一個 Space 變成主要的。
- 已經在兩個以上伺服器的資料庫:選成員最多的那個。之後要換是 owner 的事(還沒有指令,§8)。
- 測試:`store/test/migrate.test.ts` 在一個只跑到 v1 的資料庫上放好每張表的列,升級後每張表的列數一樣,零個、一個、兩個 Space 各一個案例。
- 計畫裡選用的 `core` v8(`events (space_id, type, at)` 索引)這一步沒做:P1 沒有查詢用到它,等 P4/P5 真的有按 Space 查事件的查詢再加。

## 6. API 和面板

| 路由 | 誰 | 回什麼 |
|---|---|---|
| `GET /api/places/spaces` | 管理 | 她在的每個 Space(主要的在前)、每個的成員數、`default`(主要的,沒有就第一個) |
| `GET /api/member/spaces` | 會員 | 登入的人自己是成員的 Space、`default`(主要的如果他在裡面,不然他的第一個;哪裡都不是成員的人拿到主要的) |

- `SpaceQuery`(`contracts/api/src/shared.ts`)是 `?space=<id>`,每條要分 Space 的路由把它放進 query。
- `memberSpace`:問了一個 Space:她不在那裡(或不存在)是 404「找不到這個伺服器」,這個人不是成員是 403「你不在這個伺服器裡」。沒問:他的主要的、不然他唯一(第一個)的;哪裡都不是成員的人拿到主要的,`member: false`,只給成員用的路由自己拒絕。她一個 Space 都沒有是 404。
- `adminSpace`:問了不存在的是 404;沒問是主要的,沒有就第一個,一個都沒有是 `null`。
- 面板:`app/space.ts` 的 `useAdminSpace()` 讀網址的 `?space=`(可以分享、重新整理還在),沒有就用 Core 的預設;`setSpace` 改網址。`pages/public/member-space.tsx` 的 `useMemberSpace()` 和 `SpacePicker`:公開頁沒有 router,選的伺服器記在這個瀏覽器。`SpacePicker` 只有一個伺服器(或沒有)時什麼都不畫,所以單一伺服器的安裝看起來一樣;四個以內是 `Segmented`,更多用 `Select`。這一步沒有接到任何頁面上。

## 7. 用法

標一個欄位(模組的 `config.ts`):

```ts
auction_channel: channel().meta(
  setting({ kind: "channel", ref: "id", scope: "space", label: "拍賣頻道" }),
),
forbidden: z.array(z.string()).default([]).meta(
  setting({ kind: "multi", scope: "room", merge: "union", label: "不能用的功能" }),
),
```

模組裡(和其他核心服務一樣從 `ctx.services` 拿;`placeConfig` 在沒有 Core 的服務時,例如單元測試,每個地方都給 cluster 的值):

```ts
import { placeConfig } from "@miyoria/runtime/kernel";
import { PlacesKey } from "@miyoria/types";

async start(ctx: ModuleContext) {
  const cfg = placeConfig(ctx, MarketConfigSchema);  // 在 start 裡;段落不合會丟 ConfigError
  const places = ctx.services.get(PlacesKey);        // 沒有 Core 時是 undefined

  // 指令或一輪對話:那個地方的值,每次用的時候讀
  const channel = cfg.for(inv.context).auction_channel;
  const where = places?.at(inv.context);             // { space_id, room_id, parent_room_id, session } | null

  // 每個 Space 一份的排程
  for (const space of places?.spaces() ?? []) {
    if (cfg.for({ space_id: space.id }).auction) schedule(space.id);
  }
  // 某個地方的設定改了、或有 Space 加入或離開(room_id 是 null);模組停了自動取消
  cfg.onChange(({ space_id }) => reschedule(space_id));
}
```

寫一個地方的設定(P2 的面板和指令會這樣寫;經 store 的那一個 `PlaceSettings`,寫了就生效):

```ts
store.config.places.set("space", spaceId, "market", "auction_channel", "123456789012345678", "panel:discord:1");
```

一條會員路由:

```ts
// contract:.input(z.object({ query: SpaceQuery }))
handler: async ({ input, context }) => {
  const person = await memberPerson(context.state, context.c);
  const space = memberSpace(context.state, person, input.query.space);  // 404 / 403
  ...
}
```

面板:

```tsx
const { space } = useAdminSpace();                    // 管理頁:傳 { query: { space: space ?? undefined } }
const { space, spaces, setSpace } = useMemberSpace(); // 會員頁
<SpacePicker value={space} spaces={spaces} onChange={setSpace} />
```

## 8. 這一步沒做的(P2–P5)

| 項目 | 給誰 |
|---|---|
| 設定匯入成一版、面板改每個 Space 的設定(`?space=&room=`、`source: "space" \| "room"`)、殼的 Space 切換器 | P2 |
| agent 的話多話少和 `language` 用 `PlaceConfig`、舊的 `channel_mode:*` 搬家、Discord 每個伺服器都註冊指令、`GuildCreate` / `GuildDelete` 呼叫 `places.seen` / `left`、home 的收件匣按 Space 過濾、拿掉 `?? "discord"` | P3 |
| 錢和榜:每個 Space 的列表、預測和懸賞的 `space_id` | P4 |
| 拍賣、樂透、佇列、卡拉 OK 房每個 Space 一份,外掛表的 migration | P5 |
| 換主要的 Space 的指令或面板動作;`db doctor` 列出 Space 和會被選成主要的那個 | 還沒排 |
