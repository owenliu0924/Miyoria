# 她的房間:設計

> 2026-11-28。依據:owner 核可的示意圖([mock/her-room.html](mock/her-room.html)、[mock/her-room.md](mock/her-room.md))和 owner 同日的三個決定(私密如私訊、羈絆照 Discord 動、她只有一個)。下面每一條「現在怎樣」都讀過程式;檔名寫在旁邊。這份只設計第一版,動手的是 §7 的兩包。

## 1. 這頁是什麼、不是什麼

會員區的一個整頁(`/her`,和 `/karaoke`、`/watch` 一樣是自己的網址),登入的會員一個人和她說話:她占滿畫面,膠囊輸入、她的一句話、紀錄、角落的羈絆環、左上的一行狀態。照示意圖。

它**是**一個新的私訊入口:這裡說的話和那個會員的 Discord 私訊同一種地方、同一套記憶範圍、同一套隱私、同一個額度、同一個 `<feel>`。它**不是**另一個她:沒有房間自己的人設、規則或模型,也不是一個客製伴侶。

第一版**不做**:

- **麥克風**:不放圖示。`apps/panel/DESIGN.md` 的規則是「Every control does something the Core can do; nothing planned, nothing dead」,一個寫著「之後才有」的鍵正是它禁止的。等語音輸入真的做了再加。
- **在會員瀏覽器跑 Live2D**:授權沒確認。用登陸頁的錄影循環(`apps/panel/src/pages/public/landing/her/*.webm`),留一個 `HerFigure` 介面當接縫(§7.3)。
- **「睡著了」**:系統沒有這個狀態。`[modules.arbiter] quiet_start_hour / quiet_end_hour`(預設 1–7 點)只擋她**自己開口**,有人叫她照樣回(`packages/brain/arbiter/src/config.ts`、`floor.ts` 的 `check`:addressed 一律可以)。所以示意圖的睡著畫面、「留話給她」整個拿掉;她半夜也會回,和 Discord 一樣(§9 問題 2 已決定不另做)。
- **「也在『雜談』跟大家聊」**:公開狀態只說「在語音」,不說哪個頻道(`publicStatus`,`packages/api/src/public.ts`)。讓一個會員看到她在哪個頻道跟誰聊,是新的對外資訊,第一版不給。
- **長回覆的「分段」由程式另外切**:不需要。她的回覆本來就一行一行送(`SelfRunner` 一邊寫一邊切行,每行一次 `Outlet.deliver`,`packages/brain/self/src/run.ts`),每一行就是一段;頁面一次顯示一段。
- **記憶的「在哪裡說的」**(示意圖的「語音 · 深夜雜談」):同上,頻道名是新的對外資訊;只給日期和種類。
- **她主動來敲門**(「她想你了」推播):不做,而且要把她的主動開口擋在房間外面(§5)。

## 2. 對話的通道

### 2.1 結論

**在 API 模組裡加一個 `web` 平台的轉接器**:會員送出的一句話,以會員自己的 Discord 帳號為作者,發成一則普通的 `platform.message.created`,情境是

```ts
{ platform: "web", scope: null, channel: "a.<帳號平台>.<帳號 id>", kind: "dm" }   // roomContext(account)
```

她的回覆走她原本的路(runner → `MouthOutlet` → mouth / 輸出審核 → scheduler → `PlatformSinks.get("web")`),由這個轉接器的 `PlatformSink` 接住,推給那個帳號開著的分頁。Discord 那邊什麼都不改。

這和 `platform.cli`(`packages/core/src/cli-platform.ts`:`miyoria chat` 就是一個發 `platform.message.created`、註冊 sink 的模組)是同一個做法,只是作者是真的會員帳號。

### 2.2 考慮過的做法

| 做法 | 為什麼不用 |
|---|---|
| **A. 新的 `web` 平台,和 Discord 共用同一個 host**(採用) | 進門的路只有一條:input defence(`#onMessage` 的 `inspectInput`)、封鎖、chat record(facts 模組)、identity、heart 的 `seen`、`MessageFilesBook`、看圖、讀檔、triage、lane、Floor、額度、`<feel>`,全部照原樣跑,因為它們都只看 `platform.message.created` 和 `ContextKey.kind === "dm"`。 |
| B. 注入會員現有的 Discord 私訊情境 | sink 是照平台選的(`PlatformSinks.get(context.platform)`),她的回覆會真的發到 Discord 私訊,而會員那句話在 Discord 上不存在;要知道私訊頻道 id(`openDm` 要 bot 或 self 帳號,self 帳號的私訊是 owner 不想多碰的風險);Discord 斷線房間就斷;transcript 裡混兩種回聲語意。 |
| C. API 直接呼叫 runner(`TextRunner.line()`),不經 bus | 繞過 input defence、chat record、identity、heart、facts、`MessageFilesBook` 和每個聽 `platform.message.created` 的模組,等於重寫一遍入口。 |
| D. `web` 但 `kind: "channel"` | 記憶範圍會變成頻道(`scopeForNew`),不是私訊;違反決定 1。 |

### 2.3 什麼決定了「這是誰的私訊」

| 東西 | 用什麼算 | 結果 |
|---|---|---|
| 作者 | session 的 `account`(`discord:<id>`),`display_name` 是 session 的名字 | 權限節點、角色、`Principals.user(account, context)`、封鎖、額度都對到同一個人 |
| 記憶範圍 | `scopeForNew`:`isPrivate(ctx)` 且 `dmPartner` 是作者 → `{ type: "dm", account }`(`packages/memory/memory/src/scope.ts`) | **和他的 Discord 私訊同一個範圍**(dm 範圍以帳號為鍵,不以頻道)。這裡學到的在 Discord 私訊想得起來,反過來也是;`person` 範圍照常。伺服器裡永遠想不起來 |
| identity 的 place / session | `Identity.resolve`:`scope === null` → room `web` / `a.discord.<id>`,`dm_person` = 他,session key `web:dm:<person>`(`packages/store/src/identity/identity.ts` 的 `sessionKey`) | 和 Discord 私訊(`discord:dm:<person>`)**是兩個 place、兩份 transcript**。同一個人兩個連結帳號開房,共用 `web:dm:<person>` |
| 額度 | `payerOfAuthor` → `personKey(account)` = person id(`packages/brain/selfhost/src/quota.ts`) | 和 Discord 共用每人每小時 / 每天的 USD |
| 羈絆 | `applyFeel` 用 transcript 裡的人和 `heart.feel(person, …, {turn})` | 同一列 `heart_person`、同一套步長、每日上限、錨點;私訊的 `<feel>` 原本就另外標記、每晚的整體反思不讀(v5-heart §2.12),這裡因為 `kind: "dm"` 一樣 |
| 情緒的原因 | `applyFeel`:`context.kind === "dm"` → `DM_CAUSE`「私訊裡的事」 | 她在別處不會說出房間裡的話 |
| /watch 和直播字幕 | `isPublicPlace`:`kind === "dm"` → 否(`packages/live/src/privacy.ts`) | 房間的話不上 `/watch`。她臉上的表情(`agent.emotion`)會像 Discord 私訊一樣影響直播的 avatar 表情(`packages/stage/src/link/forward.ts`),這是現在私訊就有的行為,不改 |
| 檔案的可見範圍 | `ArtifactPlaces.at(ctx)`:DM room 的 viewer 是 `dm_person` | 她在房間做的檔案只有他看得到;她在 Discord 私訊做的檔案不能在房間交出去(一個 DM 的就是那個 DM 的,`packages/store/src/artifacts/outgoing.ts`) |

**第一句話的時序**:identity 的 room 是 chat record 寫第一行時才建的,而 host 收第一行時就會問 `transcript.sessionFor(ctx)`;如果 chat record 還沒寫,host 會用 `contextKeyString` 當 session,重啟後才換成 `web:dm:<person>`,接不起來。所以轉接器**先同步寫 chat log**(`store.chat.message(msg, { self: false, source: "api.room" })`,這一步 `resolve` 出 room、session 和 person),**再發 bus 事件**;facts 模組之後寫同一行會因為同一個 key(`msg:web:<id>`)被略過(`ChatLog.#record`)。

### 2.4 一份還是兩份對話

**兩個地方,同一個私訊範圍。** 房間有自己的 transcript(`web:dm:<person>`),Discord 私訊有它的;她在房間裡看不到剛才在 Discord 私訊那幾句的原文,但記得 dm / person 範圍的記憶和羈絆。合成一份要讓一個 session 同時有兩個平台的回聲和 sink,牽動 transcript、identity 和 outlet,第一版不做;要不要在第一次開房時把私訊最後幾句帶進來,是 §9 問題 1。

她知道自己在房間:`whenAndWhere`(`packages/brain/agent/src/prompt.ts`)對 `isRoomContext` 寫「地點:網站上她的房間(私訊)」,不寫「web 的私訊」。

### 2.5 她的東西怎麼到瀏覽器

轉接器的 `WebSink implements PlatformSink`(`platform = "web"`):

- `send(context, message)`:`roomAccount(context)` 找出帳號,給新 ULID 當訊息 id,推一個 `line` 事件給那個帳號的每個分頁;附件(她 `share` 的檔案,`OutgoingAttachment.artifact_id`)先用 `AttachmentSourceKey.open(id, context, { maxBytes })` 檢查一次(還在、可下載、這裡看得到、大小),只把名字、類型、大小放進事件,位元組之後由下載路由再 `open` 一次。然後發她自己那行的回聲:`platform.message.created`,作者是 `ROOM_SELF`(`{ platform: "web", id: "her" }`,`is_bot: true`),附件寫成 `https://files.room.invalid/<artifact_id>`(沒人會去抓;抓也連不到)。chat record 認得她(轉接器啟動時發 `platform.ready` 帶 `ROOM_SELF`),紀錄裡就有她的話,host 看到 `own` 直接略過(它自己寫過 transcript)。回傳 `{ context, id }`。
- 文字:去掉平台標記(`<@…>`、`<:name:id>` 變成 `:name:`),`mention()` 回 `null`,所以 `linkMentions` 什麼都不換。2000 字的切行照舊(`MouthOutlet.#parts`)。
- `typing(context)` → `typing` 事件(同一帳號一秒最多一次)。
- `react(message, emoji)` → `reaction` 事件(她只用 emoji 回謝謝 / 晚安時就是這個,`courtesy.ts`)。
- `attachmentLimit(context)` → `max_file_mb`;`describe(context)` → `她的房間 · <名字>`。
- 頁面在網頁上用的「分頁」= 她這一輪的每一行;`MouthOutlet.#pace` 在第二行之前等她打字的時間、送 typing,頁面自然就是一段一段出來。字是一行一行到的(不是逐 token),頁面在本機一字一字顯示;要逐 token 得改 runner 的 `StepText`,不在第一版。

還有從 bus 讀的(轉接器只看 `isRoomContext` 的情境):

| bus | 事件 |
|---|---|
| `agent.turn.started` `{turn, context}` | `thinking`(她開始想) |
| `agent.tool.running` `{turn, context, tool, state}` | `step`(工具名換成幾個字:查資料、看網頁、畫圖、在電腦上做事、交給助手、想一想) |
| `agent.emotion` `{turn, context, emotion}` | `face`(她那一行的表情,給她的樣子換姿勢) |
| `agent.turn.completed` `{turn, context}` | `done` |
| `heart` 的變動(新的 `onChanged`,§6) | `bond`:那一輪 `cause = "feel"`、`field = "bond"`、`delta ≠ 0` 的變動,只給方向和她引用的理由 |
| `activity.*`、`sing.*`、`speech.pause`、`voice.joined/left/golive`、`llm.budget`(和推播 `status` 主題同一組觸發) | `state`(重算 `RoomState`,有變才送,一秒最多一次) |

**她主動的東西**:

- 在房間裡開始的工作做完(`result` wake)、在房間設的提醒到了:回到房間這個 place,照常送進 sink。開著頁面就即時看到;沒開就在 chat log 裡,下次開頁面時紀錄的最後一句就是它。不另外推播到 Discord(§9 問題 3)。
- 她自己的主動開口(想念、早安、閒聊開場)**不進房間**:`Initiative.#dmWith` 會在所有 `kind: "dm"` 的 transcript 裡找「和這個人的私訊」,不擋的話房間會被當成私訊的目的地。改成跳過 `isRoomContext`;`#home` 和 `resolvePlace` 的 `私訊:名字` 也跳過(§7 B)。`message_dm` 只走有 `openDm` 的平台,`WebSink` 沒有,所以不會從房間打到別人。`say` 本來就拒絕私訊。

### 2.6 一定要涵蓋的人

| 誰 | 怎樣 |
|---|---|
| 沒有私訊紀錄的人 | 第一句建 identity 的 room、session 和 person(§2.3);backfill 找不到東西;她照常從 person / dm 範圍想起他。`relation` 給陌生人的樣子(`bond: null`) |
| 「不要記住我」的人 | 系統沒有「別記得我」的持續開關:選項只有 `/me privacy` 的 dm、approach、watch(`packages/gate/actions/src/privacy.ts`)和「全部忘記」、Discord 的「不要記住這則」。房間是他自己開口,dm / approach 關掉不擋她回(Discord 私訊也是這樣);approach 關掉也不會有她主動進房間(本來就擋)。房間補上同等的兩個:全部忘記(現有 `/api/member/forget`,§6 讓它也清掉房間裡她的話)和每一句的「不要記住這句」(`MessageActions.dontRemember`,和 Discord 選單同一條路) |
| 被封鎖的人 | 跟會員頁的規則一樣「看起來和陌生人一樣」:送出照樣回 200、自己那句出現在畫面上,但**不發 bus、不寫紀錄**(agent 本來就會丟掉封鎖的人的話,這裡連 chat log 都不留,也不花額度);`relation` 是陌生人。她不回他,就像她在 Discord 不回他 |
| 沒有 `chat.talk` 的人(`restricted` 角色)、不在任何一個她在的伺服器的人(被 ban 了、退群了) | 房間不開:`state.open = false`,`closed = "她的房間現在沒有對你開放"`,送出 403 同一句。`chat.talk` 是「要她回這則」選單用的同一個節點(`packages/commands/src/menus.ts`);伺服器成員用 `Places.spacesOf(person)` 非空,等同 Discord 要有共同伺服器才能私訊 |
| 同時開兩個分頁 | 一個帳號一個 hub,每個分頁一條串流(每帳號最多 `streams_per_account`)。送出時帶 `client_id`,`you` 事件廣播給所有分頁,送出的那頁靠 `client_id` 去重。聲音只在「最後操作的那一頁」播(前端用 `BroadcastChannel` 選,§7.3),伺服器端同一行的聲音有快取,第二頁不會再合成 |
| 兩個連結帳號 | 各自一個 context、一個 hub;identity 讓兩邊共用 `web:dm:<person>` 的 transcript 和紀錄 |
| 她整個停住(緊急停止) | 她記得聽到的、什麼都不回(`agent.muted`,`MouthOutlet.deliver` 回 blocked)。`state.paused = true`,膠囊照常收 |
| 她不在線(agent 沒跑) | `state.doing = "offline"`,送出 503「她現在不在」 |

## 3. HTTP 介面

全部是會員路由:cookie 的 session、任何 tier;bearer token 打不開(`authenticateMember`);非 GET 要 `X-Miyoria-Request: 1`(CSRF);回應 `no-store`、`nosniff`,不帶內部錯誤字;session cookie 是 `SameSite=Lax`,別的網站嵌 `<audio>` 也帶不到 cookie。路由只在 `[modules.api.public] enabled` 且 `[modules.api.room] enabled` 時存在(rpc 的 `PUBLIC_SIDE` 加 `room`;關掉就是 404)。走公開監聽(`public_bind`)。

**不取別人的 id**:路由只接「這個人自己的東西」的 id(他自己房間裡的一行、他自己看得到的一件記憶、他剛上傳的檔案);每個都用 session 的帳號重新查一次是不是他的,不是就 404,和「不存在」一樣。

### 3.1 路由表

| 路由 | 用途 | 限制(除了每帳號每分鐘 60 的會員限制 `limitMember`) |
|---|---|---|
| `GET /api/member/room` | `RoomState` | `limited` |
| `GET /api/member/room/stream` | SSE,`RoomEvent` | 每帳號 `streams_per_account`(3)、全部 `streams_total`(64)、每位址 `PublicSide.admit`;每 30 秒 `memberStillIn` 重查,登出就斷 |
| `POST /api/member/room/messages` | 送一句(帶已上傳的檔案) | `limited`;每帳號每分鐘 `messages_per_minute`(12)、每天 `messages_per_day`(400);body ≤ 16 KiB |
| `POST /api/member/room/uploads` | 上傳一個檔案(原始位元組) | 一般路由(不是 JSON);每帳號每小時 `uploads_per_hour`(20);邊讀邊量,超過上限立刻 413 |
| `GET /api/member/room/backlog?before=` | 紀錄,一頁 `backlog_page`(50) | `limited` |
| `GET /api/member/room/relation` | 羈絆環、她寫給你的、她記得的 | `limited` |
| `POST /api/member/room/memories/{id}/forget` | 忘掉一件 | `limited`;每帳號每小時 30;節點 `memory.self.forget` |
| `POST /api/member/room/lines/{id}/exclude` | 這句不要記住 | `limited`;每帳號每小時 30 |
| `GET /api/member/room/voice/{id}` | 她那一行的聲音(`audio/wav`) | 一般路由;也要 `X-Miyoria-Request: 1`;每人每小時 `voice_lines_per_hour`(60);同帳號同時一個、全部同時兩個合成 |
| `GET /api/member/room/files/{id}/{n}` | 她交給你的第 n 個檔案 | 一般路由;`limitMember` |

### 3.2 合約(`packages/contracts/api/src/room.ts`)

這份檔案就是 B 和 F 之間的介面,B 第一個提交照這裡寫(§7.1)。

```ts
// Her room (docs/design/her-room.md): one logged-in member alone with her. A DM on the `web`
// platform: the session's account is the author, and nothing here takes anyone else's id. Her bond
// stays words and the ring (`MemberBondSchema`); a change in it is a direction and her quote, never
// a number.

import { eventIterator } from "@orpc/contract";
import { z } from "zod";
import { MemberBondSchema } from "./member.js";
import { route } from "./route.js";

/** A line's id: the ULID the room gave it. */
export const ROOM_LINE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** An upload's id: 128 random bits. */
export const ROOM_UPLOAD_ID = /^up_[A-Za-z0-9_-]{22}$/;
/** A tab's id for one send, so the tab that sent a line knows it again. */
export const ROOM_CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** An opaque page cursor of the backlog. */
export const ROOM_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;
/** A memory's id as the relation gives it. */
export const ROOM_MEMORY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `POST` a file here as the raw body; its name in `X-Miyoria-Filename` (URI-encoded). */
export const ROOM_UPLOAD_PATH = "/api/member/room/uploads";
export const roomVoicePath = (line: string) => `/api/member/room/voice/${encodeURIComponent(line)}`;
export const roomFilePath = (line: string, n: number) =>
  `/api/member/room/files/${encodeURIComponent(line)}/${n}`;

/** Her emotion name, as her avatar's `[emotion]` keys are written (`happy`, `shy`). */
export const RoomFaceSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/).meta({ id: "ApiRoomFace" });

/** What she is doing, from the public status and this room. */
export const RoomDoingSchema = z
  .enum(["offline", "idle", "singing", "playing", "live", "in_voice", "browsing", "working"])
  .meta({ id: "ApiRoomDoing" });
export type RoomDoing = z.output<typeof RoomDoingSchema>;

export const RoomStateSchema = z
  .object({
    /** The room is open to them. */
    open: z.boolean(),
    /** Why not, in zh-TW, when it is closed. */
    closed: z.string().nullable(),
    /** One word of how she feels (`得意`) and her face now; `null`: nothing to say. */
    mood: z.object({ word: z.string(), face: RoomFaceSchema.nullable() }).nullable(),
    doing: RoomDoingSchema,
    /** The song (screened) while `singing`, the game id while `playing`; else `null`. */
    detail: z.string().nullable(),
    /** She is on `/watch` now. */
    watch: z.boolean(),
    /** The emergency stop: she hears and keeps, and answers nothing. */
    paused: z.boolean(),
    /** Her voice can be played here; `reason` in zh-TW when it cannot. */
    voice: z.object({ available: z.boolean(), reason: z.string().nullable() }),
    /** Their AI quota: capped until when (ISO), or `null`. Her own fixed line says it too. */
    quota: z.object({ capped: z.enum(["hour", "day"]).nullable(), until: z.string().nullable() }),
    limits: z.object({
      max_text_chars: z.number().int(),
      max_files: z.number().int(),
      max_image_bytes: z.number().int(),
      max_file_bytes: z.number().int(),
    }),
  })
  .meta({ id: "ApiRoomState" });
export type RoomState = z.output<typeof RoomStateSchema>;

/** A file on a line: theirs (never served back) or hers (`download`: `roomFilePath`). */
export const RoomFileSchema = z
  .object({
    name: z.string(),
    size: z.number().int().nullable(),
    kind: z.enum(["image", "file"]),
    download: z.boolean(),
  })
  .meta({ id: "ApiRoomFile" });
export type RoomFile = z.output<typeof RoomFileSchema>;

export const RoomEntrySchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("line"),
      id: z.string(),
      /** ISO 8601 UTC. */
      at: z.string(),
      who: z.enum(["you", "her"]),
      text: z.string(),
      files: z.array(RoomFileSchema),
    }),
    /** Her bond moved in this conversation: after her line of that turn. */
    z.object({
      type: z.literal("mark"),
      id: z.string(),
      at: z.string(),
      sign: z.enum(["plus", "minus"]),
      /** Her reason as she wrote it, screened; `null` when it could not be shown. */
      quote: z.string().nullable(),
    }),
  ])
  .meta({ id: "ApiRoomEntry" });
export type RoomEntry = z.output<typeof RoomEntrySchema>;

/** `GET /api/member/room/backlog`: oldest first; `older` reads the page before it. */
export const RoomBacklogSchema = z
  .object({ entries: z.array(RoomEntrySchema), older: z.string().nullable() })
  .meta({ id: "ApiRoomBacklog" });
export type RoomBacklog = z.output<typeof RoomBacklogSchema>;

export const RoomMemorySchema = z
  .object({ id: z.string(), text: z.string(), kind: z.string(), date: z.string() })
  .meta({ id: "ApiRoomMemory" });
export type RoomMemory = z.output<typeof RoomMemorySchema>;

/** `GET /api/member/room/relation`: `/api/member/me`'s bond, line and memories, with ids. */
export const RoomRelationSchema = z
  .object({
    /** `null` for someone she does not know (or will not say). */
    bond: MemberBondSchema.nullable(),
    /** The line she wrote for them (`public_feeling`), screened. */
    feeling: z.string().nullable(),
    /** At most 30, newest first. */
    memories: z.array(RoomMemorySchema),
  })
  .meta({ id: "ApiRoomRelation" });
export type RoomRelation = z.output<typeof RoomRelationSchema>;

export const RoomSendRequestSchema = z
  .strictObject({
    /** Trimmed; at most `limits.max_text_chars` (checked by the handler). May be empty with files. */
    text: z.string().max(8000),
    uploads: z.array(z.string().regex(ROOM_UPLOAD_ID)).max(8).default([]),
    client_id: z.string().regex(ROOM_CLIENT_ID),
  })
  .meta({ id: "ApiRoomSendRequest" });
export type RoomSendRequest = z.input<typeof RoomSendRequestSchema>;

/**
 * `heard`: `ok`; `held` (the input defence slowed them down: she reads it, it starts nothing);
 * `ignored` (it does not reach her). `notice`: the fixed zh-TW line for the last two.
 */
export const RoomSendResultSchema = z
  .object({
    id: z.string(),
    at: z.string(),
    heard: z.enum(["ok", "held", "ignored"]),
    notice: z.string().nullable(),
  })
  .meta({ id: "ApiRoomSendResult" });
export type RoomSendResult = z.output<typeof RoomSendResultSchema>;

/** Answer of `POST /api/member/room/uploads` (not on the table: a raw body). */
export const RoomUploadSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    size: z.number().int(),
    kind: z.enum(["image", "file"]),
    /** Unsent, it is dropped then. */
    expires_at: z.string(),
  })
  .meta({ id: "ApiRoomUpload" });
export type RoomUpload = z.output<typeof RoomUploadSchema>;

const Confirm = z.strictObject({ confirm: z.literal(true) });

/** One event of the room's stream. Ids are `<run>-<n>`; a reconnect sends `Last-Event-ID`. */
export const RoomEventSchema = z
  .union([
    /** First: where things are. `turn`: a run of hers going on in this room. */
    z.object({
      kind: z.literal("hello"),
      state: RoomStateSchema,
      turn: z.object({ id: z.string(), phase: z.enum(["thinking", "speaking"]) }).nullable(),
    }),
    /** Their line, as any of their tabs sent it (`client_id` of the tab, `null` from elsewhere). */
    z.object({
      kind: z.literal("you"),
      id: z.string(),
      at: z.string(),
      text: z.string(),
      files: z.array(RoomFileSchema),
      client_id: z.string().nullable(),
    }),
    z.object({ kind: z.literal("thinking"), turn: z.string() }),
    z.object({ kind: z.literal("typing") }),
    /** A tool of hers in this room: a few words of what, started or ended. */
    z.object({
      kind: z.literal("step"),
      turn: z.string(),
      label: z.string(),
      state: z.enum(["started", "ended"]),
    }),
    /** One line of hers: one step of the reply. `voice`: `roomVoicePath(id)` can be played. */
    z.object({
      kind: z.literal("line"),
      id: z.string(),
      at: z.string(),
      turn: z.string().nullable(),
      text: z.string(),
      files: z.array(RoomFileSchema),
      voice: z.boolean(),
    }),
    z.object({ kind: z.literal("face"), turn: z.string(), face: RoomFaceSchema }),
    /** She answered one of their lines with only an emoji. */
    z.object({ kind: z.literal("reaction"), to: z.string(), emoji: z.string() }),
    z.object({ kind: z.literal("done"), turn: z.string() }),
    z.object({
      kind: z.literal("bond"),
      id: z.string(),
      at: z.string(),
      turn: z.string(),
      sign: z.enum(["plus", "minus"]),
      quote: z.string().nullable(),
    }),
    z.object({ kind: z.literal("state"), state: RoomStateSchema }),
    /** The events since `Last-Event-ID` are gone: read the backlog again. */
    z.object({ kind: z.literal("reset") }),
    z.object({ kind: z.literal("ping") }),
  ])
  .meta({ id: "ApiRoomEvent" });
export type RoomEvent = z.output<typeof RoomEventSchema>;

const member = (limited: boolean) =>
  route.meta({ audience: "member", permission: null, ...(limited ? { limited: true } : {}) });

export const room = {
  state: member(true).route({ method: "GET", path: "/api/member/room" }).output(RoomStateSchema),
  stream: member(false)
    .route({ method: "GET", path: "/api/member/room/stream" })
    .output(eventIterator(RoomEventSchema)),
  /** `403` closed, `429` too many, `409` an upload gone, `413` too long, `503` she is not there. */
  send: member(true)
    .route({ method: "POST", path: "/api/member/room/messages" })
    .input(z.object({ body: RoomSendRequestSchema }))
    .output(RoomSendResultSchema),
  backlog: member(true)
    .route({ method: "GET", path: "/api/member/room/backlog" })
    .input(z.object({ query: z.object({ before: z.string().regex(ROOM_CURSOR).optional() }) }))
    .output(RoomBacklogSchema),
  relation: member(true)
    .route({ method: "GET", path: "/api/member/room/relation" })
    .output(RoomRelationSchema),
  /** Not theirs to see, or gone: `{ forgotten: false }` (a blocked person's too). */
  forgetMemory: member(true)
    .route({ method: "POST", path: "/api/member/room/memories/{id}/forget" })
    .input(
      z.object({ params: z.object({ id: z.string().regex(ROOM_MEMORY_ID) }), body: Confirm }),
    )
    .output(z.object({ forgotten: z.boolean() }).meta({ id: "ApiRoomForgotten" })),
  /** "不要記住這句", their own line only. */
  excludeLine: member(true)
    .route({ method: "POST", path: "/api/member/room/lines/{id}/exclude" })
    .input(z.object({ params: z.object({ id: z.string().regex(ROOM_LINE_ID) }), body: Confirm }))
    .output(z.object({ excluded: z.boolean() }).meta({ id: "ApiRoomExcluded" })),
};
```

`index.ts` 匯出這些,`contract` 加 `room`;`pnpm contracts:gen` 重產 `schema/api.json`、`api.routes.json`(前端的 oRPC link 讀後者)。

### 3.3 送出與附加

**上傳**(`POST /api/member/room/uploads`,一般路由,沿用卡拉 OK 錄音上傳的做法:原始位元組、邊讀邊量、只放記憶體):

- 標頭:`Content-Type`(只當提示)、`X-Miyoria-Filename`(URI 編碼,用 `inboxName` 的規則清成一段安全的名字)、`X-Miyoria-Request: 1`。
- 類型:位元組開頭用 `sniffImage`(`packages/types/src/platform.ts`)判斷;png / jpeg / webp / gif 是圖片,上限 `max_image_mb`(5,等於看圖的 `max_image_bytes`);其他都是檔案,上限 `max_file_mb`(8)。和 Discord 一樣不限檔案類型:檔案只會被讀檔器在斷網的容器裡抽文字,或被 `workspace_attach` 原樣存進他的資料夾,不會在主機上執行。
- 存哪裡:`RoomUploads`,記憶體,整體上限 `upload_pool_mb`(128,滿了就 503「現在收不下檔案,等一下再試」)。沒送出的 30 分鐘後丟掉;送出後再留 30 分鐘(= `MessageFilesBook` 的 `KEEP_MS`,`workspace_attach` 能回頭找的時間),然後丟掉。**不寫磁碟、不回傳給任何人**(頁面的縮圖是瀏覽器自己的 blob URL),所以這裡不當圖床,也不必另外審圖。
- 回 `RoomUpload`。

**送出**(`POST /api/member/room/messages`):

1. 房間開著嗎(§2.6),她在嗎(agent 跑著、`PlatformSinks` 有 `web`);限制;`text` 去空白後 ≤ `max_text_chars`(2000,和 Discord 一則一樣),文字和檔案都空就 422。
2. 每個 upload id 都是這個帳號的、沒過期,否則 409「附加的檔案過期了,再附一次」。最多 `max_files`(4)。
3. 組 `IncomingMessage`:`id = { context: roomContext(account), id: ULID }`、作者、`text`、`mentions_self: false`、`reply_to_self: false`、`attachments` 每個是 `{ url: "https://uploads.room.invalid/<upload id>", filename, content_type, id: <upload id>, size }`、`ts`。私訊不需要叫名字,triage 的 `directReason` 對 DM 就是 `dm`(`packages/brain/agent/src/address.ts`)。
4. **封鎖的人**到這裡就停:回 `{ heard: "ok" }`,只推 `you` 事件。
5. `inspectInput(services, { id, text: incomingText(msg), source: "chat", author, context })`。審核服務按訊息 id 記住判決(`ModerationService.inspect` 的 `#verdicts`),agent 之後同一個 id 再問會拿到同一個,不會重算洗版次數。
6. 寫 chat log(§2.3),`ctx.publish(platform.message.created, msg)`,推 `you`。
7. 回 `{ id, at, heard, notice }`:`ignore` → `ignored`、「這句她收不到」;`rate_limit` → `held`、「你說得有點快,她先聽著」。這兩句是固定字,不帶判決的理由。

**附件到她手上**:三個下載的地方(看圖 `ImageLoader`、讀檔器 `FileReader`、`workspace_attach`)都只接 HTTPS 和白名單主機,用可注入的 `FetchLike` 抓。加一個服務 `IncomingFilesKey`:`handles(url)` 只認 `https://uploads.room.invalid/<id>`,`fetch()` 從 `RoomUploads` 回位元組(`Response`,有 `content-length`)。三個地方的檢查改成「白名單主機 **或** `handles(url)`」,抓檔改成 `incomingFetch(services)`(認得的交給服務,其他照舊 `fetch`)。`.invalid` 永遠解析不到(RFC 2606),所以哪個地方漏改了、真的去連,只會失敗,不會連到外面。Discord 的附件網址是 Discord API 給的 CDN 網址,沒人能把它設成這個主機。其他規則照舊:看圖的大小、每回合張數;讀檔要 `tools.file`、每人次數、沙箱;`workspace_attach` 要 `sandbox.workspace`、資料夾額度、`f.who === requester`。所以「檔案進他的工作資料夾」就是她自己決定呼叫 `workspace_attach`,和 Discord 一模一樣。

### 3.4 串流

oRPC 的 `eventIterator`(和 `push.member` 同樣的殼:`HEAD` 不開訂閱、`no-cache`、`x-accel-buffering: no`、15 秒沒事件送 `ping`)。

- 每個帳號一個 hub,環狀緩衝最近 200 個事件或 10 分鐘。事件 id `<run>-<n>`(`run` 是這次 Core 啟動的隨機字)。重連帶 `Last-Event-ID`:同一個 run 而且還在緩衝裡,就補送之後的;否則送 `hello` 再送 `reset`,頁面重讀紀錄。
- 第一個事件永遠是 `hello`(`RoomState` 和她正在進行的那一輪)。
- 推給誰:`you`、`line`、`reaction`、`bond` 只進那個帳號的 hub;`thinking`、`step`、`face`、`done` 也只看那個帳號的 context;`state` 每個 hub 自己算(心情、額度、聲音的配額是個人的)。
- 跨人資料:hub 用 `roomAccount(context)` 定址,沒有任何「全部房間」的廣播。

### 3.5 紀錄

`GET /api/member/room/backlog?before=`:讀 chat log 裡 `session = web:dm:<person>` 的行(新的 `ChatLogStore.page`,§6),跳過已刪除的(「全部忘記」、「不要記住這句」都會讓它消失),新到舊取一頁再反過來給。每行:誰、時間、文字(`incomingText` 的附件標籤拿掉,改成 `files`)、檔案(他的只給名字和大小,`download: false`;她的 `download: true`)。

羈絆的標記:這一頁她那些行的 turn,配上 heart 那段時間的變動(`HeartPeople.day` 的 changes,§6 給它加 `turn`),只取 `cause = "feel"`、`field = "bond"`、`delta ≠ 0`、turn 在這一頁裡的,放在那一輪她最後一行後面。**只給方向和她的引用**,引用過 `shown()`(不能提到別人、過審核;不過就給 `null`,只顯示 + / −)。被 caps 吃掉的提議(`delta = 0`)不顯示:那次羈絆沒有動。

### 3.6 她的狀態

`RoomState` 寫成一個 `Watch<RoomState>`(`packages/api/src/watch.ts` 的做法),`GET /api/member/room` 和串流的 `state` 都經過它,不會兩邊說不一樣。怎麼算見 §4。

### 3.7 關係面板與忘記一件

`GET /api/member/room/relation`:和 `/api/member/me` 同一套函式(`memberOf`、`bondView`、`cardView` 的 `public_feeling`、`shownMemories` 的篩選:只有 episode / fact、不是她自己的筆記、不是別人告訴她的、不提到別人、過審核、`visibleToSelf`),只是記憶多帶 `id`。B 在 `member.ts` 把 `shownMemories` 拆成先回紀錄再轉成畫面用的形狀,`/me` 的輸出不變(不加 id,維持它的 schema)。被隱藏的人:`bond: null`、`feeling: null`、`memories: []`。

`POST …/memories/{id}/forget`:用同一個篩選**重算一次**這個人現在看得到的記憶;id 在裡面才刪(新的 `MemoryEngine.forgetRecord(id)`:刪紀錄、版本加一讓快取失效),不在就 `{ forgotten: false }`。所以 id 猜得到也只能刪自己看得到的。寫一筆稽核 `member.forget.one`。羈絆不動(示意圖的字照用)。

**已知的界線**:她每個人的筆記文件(`@miyoria/memory/notes`,夜間整理寫的)可能也寫了同一件事,刪一件記憶不會動到它;全部忘記才會(`personData.forget`)。所以面板的字不寫「她再也不會提」,改成「她會忘掉這件事」(§9 問題 4)。

`POST …/lines/{id}/exclude`:確認那行是他自己在這個房間的(chat log 的 key `msg:web:<id>`、session、作者帳號),呼叫 `MessageActionsKey.dontRemember({ message, author, requested_by })`;後面是 Discord 選單同一條路(`agent.message.excluded` → chat log 刪除、transcript 刪除、記憶裡只靠這則的刪掉)。

### 3.8 她的聲音

**逐行的音檔網址,不是串流**:`line` 事件的 `voice: true` 表示可以拿 `GET /api/member/room/voice/{id}`,回一整個 `audio/wav`(16-bit PCM)。她的一行很短,整段合成完再給,前端照順序播;比在瀏覽器接 PCM 串流簡單太多。

- 誰合成:新的 `HerVoiceKey`,由 voice 模組提供(`packages/voice/voice/src/her-voice.ts`),做的事和語音頻道的 `#producer`(`packages/voice/voice/src/sink.ts`)一樣:輸出審核的 `tts` 路徑、翻譯(有設 `tts_language` 時)、`profile.voice` / `referenceFor(emotion)` / `instructFor(emotion)`,但 `priority: "ahead"`:同一台 worker 上,她在 Discord 語音裡要說的 `now` 先。走 `SpeechService.synthesize`,所以叢集怎麼找 TTS worker 照舊(`http-worker` 從 endpoint registry 找)。
- 能不能用(`state.voice`):沒有 `HerVoiceKey` 或沒有設 TTS →「她的聲音現在沒有開」;`SpeechPauseKey.paused()` 有值 →「聲音借給唱歌了,唱完就好」;最近 60 秒合成失敗過 →「她的聲音暫時出不來」;這小時到上限 →「這小時聽太多了」。owner 現在把語音 worker 關著,所以第一版上線時看到的就是第一句,聲音鍵灰著、滑過去看得到原因。
- 誰能拿:那行要是她在**這個帳號房間**裡、30 分鐘內說的(hub 的緩衝裡查得到),否則 404;超過 `voice_max_chars`(300)的行 `voice: false`。
- 快取:記憶體 LRU `voice_cache`(64)行、10 分鐘,鍵是行 id。兩個分頁拿同一行不會合成兩次。
- 花費:TTS 不在每人的 USD 額度裡(額度只算模型),另外是每人每小時 `voice_lines_per_hour`(60)行(§9 問題 5)。

### 3.9 她交給你的檔案

`GET /api/member/room/files/{id}/{n}`:那行是她在這個帳號房間的、第 n 個附件,用 `AttachmentSourceKey.open(artifact, roomContext(account), …)` 再檢查一次(還在、這裡看得到、位元組對),圖片經過 `ArtifactCleanerKey`(和交給 Discord 時一樣清掉中繼資料)。為了不讓她做的 HTML 在網站自己的網域上跑:一律 `content-disposition: attachment`,`content-type` 只在嗅出是 png / jpeg / webp / gif 時給圖片類型,其他都是 `application/octet-stream`,再加 `Content-Security-Policy: default-src 'none'; sandbox`。她發的網頁(`page_publish`)是她那行文字裡的連結,本來就在檔案網域。

### 3.10 錯誤

都是 `{ "error": "…" }` 加狀態碼(殼的老規矩),會員看得到的字都是固定中文:

| 情況 | 回應 |
|---|---|
| 房間沒開 / 不給他 | 403「她的房間現在沒有對你開放」 |
| 太快 | 429 + `Retry-After`,「你說得太快了,等一下再說」 |
| 文字太長 | 413「這段太長了,分幾次說」 |
| 檔案太大 | 413「檔案太大了(圖片最多 5 MB,其他最多 8 MB)」 |
| 附加過期 | 409「附加的檔案過期了,再附一次」 |
| 她不在 | 503「她現在不在」 |
| **額度到了** | 不是錯誤。照收,runner 在那段時間第一次被叫時說她的固定句(`quotaLine`,`packages/brain/agent/src/signals.ts`),那句就是一個普通的 `line` 事件;`state.quota` 讓膠囊的提示寫「她晚點才能回你(HH:MM)」 |
| **她在忙** | 不是錯誤。沒有「忙」會拒收的規則(§4) |
| 審核 | 200,`heard: "ignored" / "held"` 和固定句(§3.3) |
| 聲音拿不到 | 503 + `state.voice.reason` 那句;429 這小時上限 |

## 4. 她在忙的時候

**不加第二套規則**,而且要照實說:現在**沒有**任何東西讓她在唱歌時回得比較短。相反,2026-11-08 的修正明確告訴她唱歌只占語音、文字照常做(`activityBlock`:「唱歌只佔語音,不影響這裡:文字頻道的事…現在就用工具做,不用等唱完。」,`packages/brain/agent/src/self-block.ts`)。她知道自己在做什麼(那個區塊每回合都在 prompt 裡),要不要短短回一句是她自己的選擇。Floor 對有人叫她的一律放行(`floor.ts` 的 `check`)。所以示意圖膠囊上的「她在唱歌,只會簡短回你」不能寫:頁面不承諾她做不到的事(§9 問題 1)。

「晚點回」真正會發生的地方只有這些,頁面照它們顯示:同一個房間的 lane 一次一輪(她還在回上一句時,新的一句照 lane 的規則等或重來);模型排隊;額度;緊急停止。

狀態行(左上一行)從現有的訊號算:

| 訊號 | 來源 | `doing` / 狀態行 | 對她的影響 |
|---|---|---|---|
| 她在唱 | `SingerKey.singing()`,歌名 `playing()` 過 `songText` 的篩選(和 `/api/public/songs` 一樣) | `singing`:「在唱〈歌名〉」;直播時加「去聽」連到 `/watch` | 文字照常(上面那條);TTS 被 `SpeechPause` 借走時聲音鍵灰掉 |
| 遊戲 | `ActivityManagerKey` 的 `game` 在 starting / running,`gameName` 篩過的 id | `playing`:「在玩 minecraft」 | 無 |
| 直播 | `broadcast.type === "live"` | `live`:「在直播」·「去看」 | 無 |
| 語音 | `presence.type === "in"` | `in_voice`:「在語音頻道」(不說哪個) | 房間的 TTS 讓路(`ahead`) |
| 逛網站 | `activity.type === "browse"` | `browsing`:「在逛網站」(不說哪個) | 無 |
| 這個房間裡她在用工具 | `agent.tool.running` 這個 context | `working`:「在幫你{查資料…}」 | 無 |
| 都沒有 | | `idle`,只寫心情 | |
| 沒有 ActivityManager 也沒有 Singer | `publicStatus` 的 `offline` 規則 | `offline`:「她現在不在」 | 送出 503 |
| 緊急停止 | `ActuatorExecutorKey.paused` | `paused: true`:「她現在暫停中」 | 她記得,不回 |

優先順序和 `publicStatus` 一樣(唱歌 > 遊戲 > 直播 > 語音),`working` 只在其他都沒有時。

**心情一個詞**:`AffectStateKey.emotions(0.35)` 裡最強、而且 `person` 是 `null` 或就是這個人的那一個(她對別人的想念、吃醋不給),用一組給會員看的詞(joy 開心、anger 生氣、sorrow 有點難過、fear 不安、surprise 驚訝、disgust 嫌棄、shy 害羞、pride 得意、jealousy 吃醋、lonely 寂寞、missing 想念、gratitude 感激、guilt 不好意思、frustration 不甘心),沒有就「平靜」。只給詞,不給原因(原因可能是別人的私訊)。`face` 是她在這個房間最後一行的表情(`agent.emotion`),沒有就 `null`。她臉上的表情在 `/watch` 本來就公開,一個詞不比它多。

## 5. 濫用和花費

**一個人不能花掉大家的**,用現有的、有名字的限制:

- **每人 AI 額度** `[modules.agent.quota] person_usd_per_hour / person_usd_per_day`(`PersonQuota`):房間的每一輪照常記在他的 person 上,和 Discord 合計。到了就是她的固定句,不再呼叫模型(`run.ts` 的 `over_budget`)。
- **每人沙箱 CPU**(`WorkQuotaKey`,v6-sandbox §8):她在房間裡幫他跑程式也記在他身上。
- **全體每日 LLM 預算** `[llm.budget]`(`agent.handle.llmBudget()`):照舊。
- **input defence** `[modules.moderation]`:洗版、重複、連續被標記的人 → `rate_limit`(她讀,不開新的一輪)或 `ignore`(§3.3)。判決按訊息 id,不會因為房間多問一次而多算。
- **lane 的合併**:連續幾句在 `debounce_ms` 裡會併成一輪(`Lane`),不是一句一輪。
- **會員路由的限制** `limitMember`(每帳號每分鐘 60,`packages/api/src/public.ts`)、**每位址** `rate_per_minute`。
- **房間自己的**(傳輸層的上限,不是她的規則):每分鐘 12 句、每天 400 句、每小時 20 個上傳、記憶體裡全部上傳 128 MB、每帳號 3 條、全部 64 條串流、每人每小時 60 行聲音、同時合成兩行。

**網頁的一句話和 Discord 私訊的一句話相比,不能觸發的東西**:

1. **她的主動開口不進房間**(想念、早安、閒聊開場、`home`):§2.5。房間只有他先開口、或他開口時交代的事(工作的結果、他要她設的提醒)才有她的話。
2. **檔案的上限比 Discord 小**:4 個、圖片 5 MB、其他 8 MB(Discord 一則 25 MB)。
3. **不能請她回「別人的那一句」**:沒有「要她回這則」(房間裡沒有別人的話)。
4. 其餘一樣:工具、權限節點、高風險工具的審核、`share`、`workspace_attach`、`message_dm` 給別人(要對方的同意和它自己的限制),都以他的帳號經過閘門(`Principals.user`),一句都沒放寬也沒另外收緊。

## 6. 資料和設定

**沒有新的資料表,沒有遷移。** 只有加法:

| 哪裡 | 改什麼 |
|---|---|
| `packages/store/src/stores.ts`、`events/chat.ts` | `ChatLogStore.page(context, { before, limit })`:`session = identity.sessionOf(context)` 的聊天行,新到舊,跳過已刪除,回 `{ lines: { event_id, at, seq, turn, self, message }[], older }`(游標是 `at` + `seq` 編碼)。用 migration 3 的部分索引,和 `recent` 同一個條件 |
| 同上 | `forgetPerson(person)` 也刪掉 `session = 'web:dm:' || person` 裡她自己的行。「全部忘記」之後房間的紀錄是空的,不會只剩她的回答;這是加強,不是放寬。Discord 私訊裡她的話 Discord 本來就留著,不動 |
| `packages/types/src/heart.ts` | `HeartDayChange.turn?: string \| null`;`HeartPeople.onChanged?(listener): () => void`,listener 收 `{ person, field, delta, quote, cause, turn, at, event_id }` |
| `packages/heart/person/src/store.ts`、`log.ts`、`module.ts` | `HeartStore.onChanged`(和 `onTierEntered` 一樣在 commit 之後叫);`day()` 的 changes 從信封帶出 `turn`;`HeartService` 轉接 |
| `packages/memory/memory/src/engine.ts` | `forgetRecord(id): Promise<boolean>`(刪、`#version += 1`) |
| 記憶體裡 | `RoomUploads`、每帳號的 hub 和緩衝、聲音快取、限制的計數。重啟就沒了,都可以沒有 |

**設定** `[modules.api.room]`(`ApiConfigSchema.room = RoomConfigSchema.prefault({})`,`packages/api/src/room/config.ts`)。兩份範例 toml(`miyoria.example.toml`、`packages/cli/templates/miyoria.example.toml`)都在 `[modules.api.public]` 那段後面加:

```toml
# 她的房間(/her):登入的會員一個人和她說話,和他的 Discord 私訊是同一種地方(同一套記憶範圍、
# 額度、羈絆)。要 [modules.api.public] enabled。預設關;下面是預設值(docs/design/her-room.md)。
# [modules.api.room]
# enabled = false
# messages_per_minute = 12         # 每個人每分鐘最多幾句
# messages_per_day = 400           # 每個人每天最多幾句
# max_text_chars = 2000            # 一句最多幾個字
# max_files = 4                    # 一句最多附幾個檔案
# max_image_mb = 5                 # 一張圖最大(和看圖的上限一樣)
# max_file_mb = 8                  # 其他檔案最大
# uploads_per_hour = 20            # 每個人每小時最多上傳幾個
# upload_pool_mb = 128             # 還沒用完的上傳全部加起來最多放多少(只在記憶體)
# streams_per_account = 3          # 一個人最多開幾個分頁
# streams_total = 64               # 所有人加起來最多幾條連線
# voice = true                     # 有 TTS 時可以聽她念(語音 worker 關著時自動不能用)
# voice_lines_per_hour = 60        # 每個人每小時最多聽幾行
# voice_max_chars = 300            # 太長的行不念
# voice_cache = 64                 # 念過的行留幾行在記憶體
# backlog_page = 50                # 紀錄一頁幾行
```

## 7. 分工

### 7.1 先後

1. **B 的第一個提交**:`packages/contracts/api/src/room.ts` 照 §3.2 一字不改、`index.ts` 匯出和 `contract.room`、`pnpm contracts:gen`。提交後 integrator 讓 F 的 worktree 從這個提交開始(記得 agent worktree 起點會是舊的,先 fast-forward)。
2. 之後 B 和 F 同時做,互不碰對方的檔案。
3. 兩邊都好了,integrator 收尾(§7.4)。

### 7.2 B:後端(OWNS)

新檔:

- `packages/contracts/api/src/room.ts`
- `packages/types/src/room.ts`:`ROOM_PLATFORM`、`ROOM_SELF`、`roomContext`、`roomAccount`、`isRoomContext`、`INCOMING_FILE_HOST`、`IncomingFiles` / `IncomingFilesKey` / `incomingFetch` / `incomingAllowed`、`HerVoice` / `HerVoiceKey`(§7.3 的介面)
- `packages/api/src/room/`:`config.ts`、`channel.ts`(hub、緩衝、事件 id、送出流程)、`sink.ts`(`WebSink`)、`uploads.ts`(`RoomUploads`,也是 `IncomingFiles` 的實作)、`state.ts`(`roomStateWatch`、心情詞)、`backlog.ts`、`relation.ts`、`voice.ts`(快取、WAV 編碼,用 `packages/voice/speech/src/wav.ts`)、`files.ts`、`routes.ts`(`roomRpc` 和一般路由)、`start.ts`(在 API 模組裡啟動:註冊 sink、發 `platform.ready`、provide `IncomingFilesKey`、訂閱 bus、接 heart 的 `onChanged`;停止時全部收掉)
- `packages/api/test/room-*.test.ts`
- `packages/api/dev/room-dev.ts`、`packages/api/dev/llm-stub.ts`(§8)
- `packages/voice/voice/src/her-voice.ts` 和它的測試

改的檔(都是加法):

- `packages/contracts/api/src/index.ts`、`packages/contracts/schema/api.json`、`api.routes.json`(重產)
- `packages/types/src/index.ts`、`packages/types/src/heart.ts`
- `packages/api/src/module.ts`(`room` 設定、`startRoom`)、`state.ts`(`room` 欄位,和 `files` 一樣是可變的)、`rpc.ts`(`room: roomRpc`、`PUBLIC_SIDE` 加 `"room"`)、`server.ts`(一般路由)、`member.ts`(`shownMemories` 拆出帶紀錄的版本,`/me` 不變)
- `packages/store/src/stores.ts`、`packages/store/src/events/chat.ts` 和測試
- `packages/heart/person/src/store.ts`、`log.ts`、`module.ts` 和測試
- `packages/memory/memory/src/engine.ts` 和測試
- `packages/brain/selfhost/src/initiative.ts`(`#dmWith`、`#home` 跳過房間)、`places.ts`(`私訊:` 跳過房間)和測試
- `packages/brain/agent/src/prompt.ts`(`whenAndWhere` 的房間字)、`vision.ts`(`allowedUrl` 或 `incomingAllowed`;`ImageLoader` 用 `incomingFetch`)和建 `ImageLoader` 的地方
- `packages/workspace/sandbox/src/files.ts`、`attach.ts`(同樣兩處)和建它們的 `module.ts`
- `packages/voice/voice/src/module.ts`(provide `HerVoiceKey`)
- `.gitignore`(`/.dev/`)

B 的測試至少要有:作者是 Discord 帳號、context 是 `web` 時記憶範圍是 `dm{account}`(scope 的單元測試);第一句先寫 chat log、identity session 是 `web:dm:<person>`;封鎖的人不發事件;審核判決只算一次;兩個帳號的 hub 互相看不到;`Last-Event-ID` 補送和 `reset`;上傳上限邊讀邊量;`.invalid` 網址只有服務認得,`workspace_attach` / 讀檔 / 看圖拿得到位元組;`forgetRecord` 只刪看得到的;`exclude` 只認自己的行;羈絆標記只給方向和篩過的引用、`delta = 0` 不出;initiative 的想念不挑房間;聲音的擁有者檢查和上限。整套一輪跑在背景的檢查 worktree,每一步只跑動到的套件。

### 7.3 F:前端(OWNS)

新檔,全部在 `apps/panel/src/pages/public/room/`:

- `path.ts`(`ROOM_PAGE = "/her"`、`isRoomPath`)
- `RoomPage.tsx`(整頁,照示意圖的版面、尺寸、對比、手機規則)
- `room-api.ts`(下面的 `RoomApi`:真的實作用 `api.rpc.room.*` 和 `ApiClient.send`)
- `room-stream.ts`(跟串流:退避重連、`Last-Event-ID`、看門狗;`reset` 時重讀紀錄)
- `room-store.ts`(reducer:她現在這一輪的行、第幾段、思考中、標記、兩個分頁的 `client_id` 去重)
- `figure.ts`、`Figure.tsx`(`HerFigure` 和錄影版)
- `StatusLine.tsx`、`HerLine.tsx`、`Capsule.tsx`、`Attachments.tsx`、`Backlog.tsx`、`Relation.tsx`、`BondMark.tsx`
- `voice.ts`(照順序播、只在被選中的分頁播、聲音鍵的狀態和原因)
- `demo.ts`(`?room-demo` 的假 Core,照 `member-demo/demo.ts` 和 `karaoke/demo.ts` 的做法:只在 `import.meta.env.DEV`)
- `room.test.tsx`、`room-logic.test.ts`

改的檔:

- `apps/panel/src/app/App.tsx`:一個分支,`isRoomPath(path)` 且是會員(或用 Discord 登入的 admin,和 `/karaoke` 一樣)時 lazy 載入 `RoomPage`;不是會員就照 `/` 的樣子
- `apps/panel/src/main.tsx`:`?room-demo` 分支

B 和 F 之間的 TypeScript(合約型別都從 `@miyoria/contracts/api` 來):

```ts
// apps/panel/src/pages/public/room/room-api.ts — the page talks to the Core only through this.
import type {
  RoomBacklog, RoomEvent, RoomRelation, RoomSendRequest, RoomSendResult, RoomState, RoomUpload,
} from "@miyoria/contracts/api";

export interface RoomApi {
  state(signal?: AbortSignal): Promise<RoomState>;
  backlog(older: string | null, signal?: AbortSignal): Promise<RoomBacklog>;
  relation(signal?: AbortSignal): Promise<RoomRelation>;
  send(request: RoomSendRequest): Promise<RoomSendResult>;
  /** `POST ROOM_UPLOAD_PATH`, the file as the body, its name in `X-Miyoria-Filename`. */
  upload(file: File, signal?: AbortSignal): Promise<RoomUpload>;
  forgetMemory(id: string): Promise<{ forgotten: boolean }>;
  excludeLine(id: string): Promise<{ excluded: boolean }>;
  /** `GET roomVoicePath(line)` with the CSRF header; a WAV. */
  voice(line: string, signal?: AbortSignal): Promise<Blob>;
  /** `GET roomFilePath(line, n)`; saved by the page as a download. */
  file(line: string, n: number, signal?: AbortSignal): Promise<{ blob: Blob; name: string }>;
  /** Follows the stream until `signal` aborts; resolves when it ends (the caller reconnects). */
  follow(options: {
    lastEventId: string | null;
    signal: AbortSignal;
    onEvent: (event: RoomEvent, id: string | null) => void;
  }): Promise<void>;
}
```

```ts
// packages/types/src/room.ts (B) — what other packages use of the room.
export const ROOM_PLATFORM = "web";
export const ROOM_SELF: AccountRef = { platform: ROOM_PLATFORM, id: "her" };
export function roomContext(account: AccountRef): ContextKey; // channel `a.<platform>.<id>`, kind dm
export function roomAccount(context: ContextKey): AccountRef | null;
export function isRoomContext(context: ContextKey): boolean;

/** Files people attached on the site, handed to the downloaders without a network. */
export const INCOMING_FILE_HOST = "uploads.room.invalid";
export interface IncomingFiles {
  handles(url: string): boolean;
  fetch(url: string, init: { signal: AbortSignal; redirect: "error" }): Promise<Response>;
}
export const IncomingFilesKey = serviceKey<IncomingFiles>("IncomingFiles");
export function incomingAllowed(services: ServiceLookup, url: string): boolean;
export function incomingFetch(services: ServiceLookup): FetchLike;

/** Her voice for one line, outside a voice channel (the room). Provided by `voice`. */
export type HerVoiceDown = "off" | "lent" | "failing";
export interface HerVoice {
  available(): { ok: true } | { ok: false; why: HerVoiceDown };
  /** Reviewed, translated and synthesized like a voice line, at priority `ahead`. */
  speak(
    text: string,
    emotion: string | null,
    signal: AbortSignal,
  ): Promise<{ sampleRate: number; samples: Int16Array }>;
}
export const HerVoiceKey = serviceKey<HerVoice>("HerVoice");
```

```ts
// apps/panel/src/pages/public/room/figure.ts (F) — the seam where Live2D goes later.
export type Pose = "heart" | "finger" | "sing" | "chest" | "glasses" | "basin" | "grass" | "still";
export interface HerFigure {
  mount(into: HTMLElement): void;
  show(pose: Pose): void;
  /** Her line is being read out (a mouth for Live2D; nothing for the loops). */
  speaking(on: boolean): void;
  dispose(): void;
}
/** The pose for her state and face: singing → sing; joy / pride → heart; anger / disgust → finger; … */
export function poseFor(state: RoomState, face: string | null): Pose;
```

F 的細節(示意圖沒寫死、這裡定下來的):

- 她的話:`thinking` → 「她在想」;每個 `line` 一字一字出來;同一輪後面還有行就出現往下的小箭頭,點她的話或空膠囊按 Enter 換下一段(示意圖的行為);`done` 之後幾秒你的那句淡掉。
- `bond` 事件:環下方的 + / − 和她的引用,幾秒後淡掉,紀錄裡留著;然後重讀 `relation`(環可能動了)。
- 聲音鍵:`state.voice.available` 為否就是灰的,`title` 和 `aria-describedby` 是原因。開著時照順序拿每一行的 WAV 播;用 `BroadcastChannel("miyoria-room")` 選「最後按過鍵 / 送出過」的那一頁播,其他頁不播。
- 膠囊提示:`paused` →「她現在暫停中,你說的她會記得」;`quota.capped` →「她晚點才能回你(HH:MM)」;其他都是「跟她說點什麼」,**不寫「只會簡短回你」**(§4)。沒有麥克風鍵。
- 紀錄:往上翻用 `older`;自己的那句旁邊有「不要記住這句」(確認一次);底部那行小字照示意圖,但「拿掉的她不會再提」改成「她會忘掉這件事」。
- 關係面板:分級、她寫給你的、她記得的(展開、問她這件事 = 把字放進膠囊、請她忘掉);不顯示「在哪裡說的」。
- 被關掉(`open: false`):畫面只有她和 `closed` 那一句,沒有膠囊。
- 字級:她的話 18 px(手機 16 px)是示意圖的,超過 DESIGN.md 的 15 px,照登陸頁的例外處理,由 integrator 寫進 DESIGN.md(owner 已核可示意圖)。

### 7.4 integrator 收尾

- 核心(`packages/core`):房間在 API 模組裡,不用新的模組或服務登記;要看的是 `packages/core/test/config-schema.test.ts` 一類的設定結構快照有沒有要更新,和 `PlatformSinksKey` 在 API 模組啟動前就有(它是 boot 時 kernel 提供的)。
- 兩份範例 toml(§6)。
- 會員站的入口:`PublicSite.tsx` 的頁首加「她的房間」連到 `/her`(房間沒開時不顯示:先問 `GET /api/member/room`,404 或 `open: false` 就不放)。
- `apps/panel/DESIGN.md` 的 Public site 加這一頁和 18 px 的例外;`docs/design/backlog.md` 記下延後的:麥克風、會員瀏覽器的 Live2D、逐 token 串流、睡著、房間和私訊接續、記憶的「在哪裡說的」。
- `.claude/launch.json` 加 §8 的 `panel-room-dev`。
- 驗證(§8),上線前在線上的 toml 打開 `enabled` 要 owner 說可以。

## 8. 在這台電腦上真的驗一次(不碰線上的服務)

查過的現況:沒有開發用的登入後門(`packages/api/src/session.ts`、`oauth.ts` 都沒有);`MockProvider`(`packages/llm/llm/src/mock.ts`)和 `ScriptedLlm`(`tools/replay/src/fakes.ts`)只在測試和 replay 的行程裡用,真的 Core 只能接設定檔的 provider;`[llm.providers.*] kind = "openai-compatible"` 可以指到任何 `base_url`;每個模組都能 `enabled = false`(`packages/runtime/kernel` 的 config);`.claude/launch.json` 只有一個 panel 的 vite;vite 用 `MIYORIA_CORE_URL` 決定 `/api` 代理到哪(`apps/panel/vite.config.ts`);session 存在設定庫的 `_global` / `panel_session:<sha256(token)>`,而且只有設了 `discord_oauth` 才會讀 cookie。

所以**最小、不改 Core 一行**的做法是兩支開發腳本(B 寫,放在 `packages/api/dev/`,不在 `src/`,不進 build):

1. `room-dev.ts init`:在 worktree 的 `.dev/room/`(gitignore)建一份丟棄式的設定和資料庫,放一個標記檔 `.miyoria-dev`。設定:
   - `database_url = "sqlite:.dev/room/miyoria.db"`,`profile = "deepseek-chan"`;
   - 關掉會碰到線上或埠衝突的:`platform.discord.bot`、`voice`、`voice.link`、`stage.link`、`cluster`、`sandbox`、`sing`(線上 Core 用 7878、7880、7885、7886,這份全部不用);
   - `[modules.api] bind` 用一個查到是空的埠(避開 Windows 保留的埠段;寫進 `.dev/room/ports.json`),`token` 隨機;`[modules.api.discord_oauth]` 填假的 `client_id = "dev"`、`client_secret = "dev"`、`redirect_uri = http://127.0.0.1:<埠>/api/auth/oauth/callback`(只是讓 cookie 會被讀;沒人按登入就不會連 Discord);`[modules.api.room] enabled = true`;
   - `[llm.providers.stub] kind = "openai-compatible"`、`base_url = http://127.0.0.1:<stub 埠>/v1`、`api_key = "dev"`,`[llm.purposes]` 全部指 `stub:chat`;
   - 一個 `panel.env`:`MIYORIA_CORE_URL=http://127.0.0.1:<埠>`。
2. `room-dev.ts member --name 測試小澄`:只肯打開 `.dev/` 底下、有標記檔的資料庫(否則直接結束,線上的 `data/miyoria.db` 不可能被它打開),用 `@miyoria/store` 寫一筆 `tier: "member"` 的 session 給 `discord:900000000000000001`,再用 `Places.seen` / `memberSeen` 讓這個帳號是一個假伺服器的成員(房間只給伺服器成員)。印出 cookie 值。
3. `llm-stub.ts`:Node 內建 `http` 的 OpenAI 相容 `/v1/chat/completions`(串流),照腳本回:一般回兩行,開頭帶 `<feel>\n我: 開心 中\n測試小澄: 羈絆 + 「記得答應我的事」\n</feel>`;會員的話含「鬧」時改成 `羈絆 -`;請求裡有 `image_url` 時回「我看到你的圖了」;要 JSON 的請求(`response_format` 或系統訊息要 JSON)回 `{}`。它記下每個請求,`GET /requests` 看得到,用來確認圖片真的到了模型。

跑起來(三個終端機,或 Monitor 背景):

```
pnpm exec tsx --conditions=@miyoria/source packages/api/dev/room-dev.ts init
pnpm exec tsx --conditions=@miyoria/source packages/api/dev/room-dev.ts member --name 測試小澄
pnpm exec tsx --conditions=@miyoria/source packages/api/dev/llm-stub.ts
pnpm dev core --config .dev/room/miyoria.toml
```

(從 repo 根目錄跑;腳本 import 的 `@miyoria/store` 從 `packages/api/node_modules` 解析,不用 install。)

panel:`.claude/launch.json` 加

```json
{
  "name": "panel-room-dev",
  "runtimeExecutable": "node",
  "runtimeArgs": ["--env-file=.dev/room/panel.env", "apps/panel/node_modules/vite/bin/vite.js",
                  "apps/panel", "--port", "51879", "--strictPort", "--host", "127.0.0.1"],
  "port": 51879,
  "url": "http://127.0.0.1:51879"
}
```

瀏覽器:打開 `http://127.0.0.1:51879/`,用 `document.cookie = "miyoria_session=<印出來的值>; path=/"` 放 cookie(伺服器只看名字,不看 HttpOnly),到 `/her`。要看到:

- **送出和串流**:打一句 → 「她在想」→ 兩行一段一段出來;第二個分頁同時看到你那句和她的回答,只有一頁有聲音(這裡聲音鍵是灰的,原因是「她的聲音現在沒有開」,因為 voice 關著)。
- **羈絆標記**:環下方出現 +「記得答應我的事」;打含「鬧」的句子出現 −。`GET /api/member/room/relation` 的 `bond` 只有圈數和二十分之一的填充。
- **紀錄**:重新整理後往上滑,兩邊的話、時間、標記在對的位置;「不要記住這句」之後那句消失。
- **附件**:附一張圖 → 她說「我看到你的圖了」,`GET http://127.0.0.1:<stub>/requests` 裡那個請求有 `image_url`;附一個 PDF → 紀錄裡你那句下面寫著附加了它(讀檔和 `workspace_attach` 要沙箱,這份設定關著,所以她只看得到檔名;沙箱的部分由 B 的單元測試涵蓋)。
- **忘記一件**:面板裡請她忘掉一件 → 重讀後不見。
- 前端先不接 Core 也能看:`http://127.0.0.1:51879/her?room-demo`。

收掉:停掉三個行程,刪 `.dev/room/`。整段沒有開線上的 `miyoria.toml`、`.env`、`host.toml`、`data/`,沒有連 Discord,也沒有用付費的模型。

## 9. 要 owner 決定的(每題附預設)

1. **唱歌時「只會簡短回你」**:現在的規則正好相反(唱歌只占語音,文字照常,2026-11-08 修的)。要她在房間裡忙的時候真的簡短,得在她的 prompt 加一句,而且會和那次修正衝突。**預設**:不改,狀態行寫她在做什麼,膠囊不承諾簡短。
2. **房間和 Discord 私訊要不要接得上**:現在是同一個記憶範圍、兩份對話原文。**預設**:分開;她記得事,不記得字句。要接的話,第一次開房時把私訊最後 20 句帶進房間的 transcript(反過來不做)。
3. **他不在時房間裡的結果和提醒**:**預設**:留在房間,下次打開看得到,不用 Discord 叫他。
4. **「請她忘掉」一件事要多徹底**:**預設**:刪那一件記憶,她每個人的筆記文件不動(只有「全部忘記」會動),面板寫「她會忘掉這件事」。要更徹底就連筆記裡同一件事的行一起刪,要另外做。
5. **聽她的聲音算不算額度**:TTS 不在每人的 USD 額度裡。**預設**:不算,每人每小時 60 行的上限;語音 worker 開回來之前這題不影響任何人。
6. **誰能進房間**:**預設**:有 `chat.talk`、而且至少是一個她在的伺服器的成員;第一版上線時 `enabled = false`,等 owner 說開。

## 10. 最大的風險

`web` 這個 context 的作者是 Discord 帳號,而 identity、transcript session、檔案可見範圍、`<feel>` 的名字比對、initiative 找私訊這些程式,都是在「一段對話只有一個平台」的前提下寫的。已知的兩個(第一句的 session 時序、initiative 把房間當私訊)上面處理了;沒想到的會表現成「接不起來」或「她在房間外提起房間」。所以 B 的驗收一定要包含一個從送出到她回覆、走真的 store 和 host 的測試,和 §8 的實機一輪,不能只靠單元測試。第二個要小心的是附件的 `.invalid` 網址改動了三個下載的地方,它是安全邊界:B 要有測試證明別的主機照舊被拒絕。
