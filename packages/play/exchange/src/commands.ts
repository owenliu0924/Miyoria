// `/me market …` (owner 2026-11-21: no new top-level command; a group under `/me`, browsing with
// components rather than more subcommands). v1: real Taiwan and US stocks and the five local ones.
// Every answer is a neutral card with the exchange's small print, and a picture above it when one
// can be drawn.
//
// - `/me market overview`: the overview picture and, only for the caller, a select of LISTS
//   (新手推薦 · 這裡獨家 first and the default for someone with no positions, 大家都在買, 今天漲跌最多,
//   熱門台股, 熱門美股, 我的持股, 我最近看過, 我的觀察) and a select of the list's tickers (25 a page,
//   ◀ ▶ for more). Picking a ticker turns the message into its quote card (a candle chart) with
//   買 / 賣 / 加入觀察 / 回清單 and a select of the chart's timeframe (當日 / 日線 / 週線 / 月線) that
//   draws the picture again; 買 and 賣 open a modal (coins or shares; 1× or 2× where allowed), then
//   the confirmation, then the message shows the order and the position. The list select also
//   carries the three heat maps (伺服器持股圖, 熱門台股圖, 熱門美股圖), each drawn as a picture.
// - `/me market quote code:` a ticker's quote card (the code has suggestions while typing).
// - `/me market mine`: their own holdings, only to them, with 分享 buttons that post the holdings
//   or the latest trade's receipt publicly with their name, only when pressed.
// - `/me market rich`: the rich list.
//
// Component hygiene: every control's id carries a tag of the member who opened it and its expiry,
// so a press by someone else gets a neutral refusal, an expired one says how to reopen, and both
// hold across a Core restart (nothing about them lives in memory).

import {
  ArgKind,
  argSpec,
  type CardBlock,
  type CardButton,
  type CommandRegistry,
  type CommandReply,
  type ComponentInvocation,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  defineRoute,
  type Invocation,
  type Modal,
} from "@miyoria/commands";
import { type AccountRef, exchangeSmallPrint, type Pictures } from "@miyoria/types";
import {
  bankruptPictureData,
  boardPictureData,
  coinText,
  defaultTimeframe,
  mapPictureData,
  marketLine,
  overviewPictureData,
  portfolioPictureData,
  quotePictureData,
  receiptPictureData,
  sharesText,
  withPicture,
} from "./pictures.js";
import { isTimeframe, TIMEFRAME_WORD, TIMEFRAMES, type Timeframe } from "./real/candles.js";
import type { RealLine } from "./real/desk.js";
import { LIST_KINDS, LIST_LABEL, type ListKind, pageOf } from "./real/lists.js";
import { isMapKind, MAP_KINDS, MAP_TITLE, type MapKind } from "./real/maps.js";
import type { ExchangeService } from "./service.js";

/** A map's option value in the list select (no new subcommand: the overview's list carries them). */
const MAP_PREFIX = "map:";

export const PATHS = [
  "me market overview",
  "me market quote",
  "me market mine",
  "me market rich",
] as const;

/** The wallet's node: a role without it, like `blocked`, cannot take part. */
const NODE = "me.wallet";
const OFF = "交易所現在沒有開";
export const EXPIRED = "這個面板過期了:用 /me market overview 重新打開";
export const NOT_YOURS = "這是別人打開的面板:用 /me market overview 打開你自己的";

/** The honest line of every 2× confirmation (owner 2026-11-21). */
export const LEVERAGE_CONFIRM =
  "2 倍可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股;跳空時可能沒有預警就被自動賣出。";

const R = {
  list: "xm:list",
  tf: "xm:tf",
  pick: "xm:pick",
  page: "xm:page",
  back: "xm:back",
  buy: "xm:buy",
  sell: "xm:sell",
  order: "xm:order",
  ok: "xm:ok",
  no: "xm:no",
  watch: "xm:watch",
  share: "xm:share",
} as const;

const pct = (x: number | null) => {
  if (x === null) return "";
  const v = Math.round(x * 1000) / 10;
  return v > 0 ? `▲ +${v.toFixed(1)}%` : v < 0 ? `▼ −${Math.abs(v).toFixed(1)}%` : "0.0%";
};

/** A line of one ticker: its price in its currency and in coins, its change, its quote time. */
export function lineText(l: RealLine): string {
  if (l.price === null) return `${l.code} ${l.name}:還沒有報價`;
  const native =
    l.currency === "COIN"
      ? `${coinText(l.price)} 魚幣`
      : `${l.currency} ${l.price}(約 ${l.coin_price === null ? "—" : coinText(l.coin_price)} 魚幣)`;
  const age = l.age_minutes === null ? "" : `,${l.age_minutes} 分鐘前的報價`;
  return `${l.code} ${l.name}:${native} ${pct(l.change)}${age}`;
}

/** A neutral card with the small print under it, always. */
export function card(
  title: string,
  lines: string[],
  o: { real?: boolean; leverage?: boolean } = {},
  more: CardBlock[] = [],
): CommandReply {
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      ...more,
      { type: "muted", text: exchangeSmallPrint(o) },
    ],
    { accent: "neutral", title },
  );
}

// ---- who opened a panel, and until when ------------------------------------------------------

/** A short tag of an account (FNV-1a), carried in every control id. */
export function ownerTag(a: AccountRef): string {
  let h = 0x811c9dc5;
  for (const ch of `${a.platform}:${a.id}`) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

interface Stamp {
  o: string;
  e: string;
}

function stampFor(x: ExchangeService, who: AccountRef): Stamp {
  const until = Math.ceil((x.nowMs() + x.config.component_minutes * 60_000) / 60_000);
  return { o: ownerTag(who), e: until.toString(36) };
}

const cid = (route: string, s: Stamp, ...params: (string | number)[]) =>
  componentId(route, s.o, s.e, ...params);

/** The refusal of a press by someone else or after expiry; `null` when it may go on. */
function refusal(x: ExchangeService, inv: ComponentInvocation): ComponentResult | null {
  const [o, e] = inv.params;
  if (o !== ownerTag(inv.invoker))
    return ComponentResult.reply({ ...card("深海交易所", [NOT_YOURS]), ephemeral: true });
  const until = Number.parseInt(e ?? "", 36) * 60_000;
  if (!Number.isFinite(until) || until < x.nowMs())
    return ComponentResult.update(card("深海交易所", [EXPIRED]));
  return null;
}

/** A reply only the caller sees, its controls bound to them until they expire. */
function privately(x: ExchangeService, reply: CommandReply): CommandReply {
  return {
    ...reply,
    ephemeral: true,
    session: { ttlMs: x.config.component_minutes * 60_000, initiatorOnly: true },
  };
}

// ---- the overview: lists and tickers ---------------------------------------------------------

/**
 * The select of lists, with the three heat maps after them; `current` is shown chosen. A list and
 * a map may share a name (`tw`, `us`), so which of the two it is has to be said: Discord refuses a
 * select with two chosen options.
 */
function listSelect(s: Stamp, current: { list: ListKind } | { map: MapKind }): CardBlock {
  const list = "list" in current ? current.list : null;
  const map = "map" in current ? current.map : null;
  return {
    type: "select",
    select: {
      id: cid(R.list, s),
      placeholder: "選一個清單或熱力圖",
      options: [
        ...LIST_KINDS.map((k) => ({
          label: LIST_LABEL[k],
          value: k,
          ...(k === "local" ? { description: "新手先看這裡" } : {}),
          default: k === list,
        })),
        ...MAP_KINDS.map((k) => ({
          label: `熱力圖:${MAP_TITLE[k]}`,
          value: `${MAP_PREFIX}${k}`,
          description:
            k === "holdings" ? "大家持有多少(不顯示是誰),今天的漲跌" : "預設權重,今天的漲跌",
          default: k === map,
        })),
      ],
    },
  };
}

/** A heat map as a card: its biggest tiles in words, the list select, and the map as a picture. */
async function mapCard(
  x: ExchangeService,
  pictures: Pictures | null,
  who: AccountRef,
  kind: MapKind,
): Promise<CommandReply> {
  const s = stampFor(x, who);
  const map = x.real.map(kind);
  const top = [...map.tiles].sort((a, b) => b.weight - a.weight).slice(0, 6);
  const lines = [
    `${map.title}${map.tiles.length === 0 ? ":還沒有可以畫的股票" : `(${map.tiles.length} 格)`}`,
    ...top.map((t) => `${t.code} ${t.name}・${t.sector} ${pct(t.change) || "—"}`),
    map.footnote,
  ];
  const reply = privately(
    x,
    card("深海交易所", lines, { real: true }, [listSelect(s, { map: kind })]),
  );
  return withPicture(pictures, "exchange_map", mapPictureData(x, map, x.nowMs()), reply);
}

async function overview(
  x: ExchangeService,
  pictures: Pictures | null,
  who: AccountRef,
  kind: ListKind | null,
  page: number,
  withOverviewPicture: boolean,
): Promise<CommandReply> {
  const person = await x.personOf(who);
  const list = kind ?? x.lists.defaultList(person);
  const s = stampFor(x, who);
  const rows = x.lists.rows(list, person);
  const p = pageOf(rows, page);
  const firstTime = person === null || x.real.portfolio(person).holdings.length === 0;
  const lines = [
    ...(firstTime && list === "local"
      ? [
          "第一次來?這裡用魚幣買賣股票,只是遊戲:",
          "・新手推薦的五檔是這裡獨家,一股約 100 魚幣、單日漲跌最多 ±10%",
          "・台股和美股照真實報價,可以買零股;每筆收 1% 手續費",
        ]
      : []),
    `${LIST_LABEL[list]}${rows.length === 0 ? ":這裡還沒有東西" : `(${rows.length} 檔)`}`,
    ...p.items.slice(0, 5).map(lineText),
    ...(p.items.length > 5 ? [`……還有 ${rows.length - 5} 檔,在下面選`] : []),
  ];
  const blocks: CardBlock[] = [listSelect(s, { list })];
  if (p.items.length > 0)
    blocks.push({
      type: "select",
      select: {
        id: cid(R.pick, s, list),
        placeholder: "選一檔看報價",
        options: p.items.map((r) => ({
          label: `${r.code} ${r.name}`.slice(0, 100),
          value: r.code,
          description:
            `${r.price === null ? "還沒有報價" : r.currency === "COIN" ? `${coinText(r.price)} 魚幣` : `${r.currency} ${r.price}`} ${pct(r.change)}${r.holders === null ? "" : `・${r.holders} 人持有`}`.slice(
              0,
              100,
            ),
        })),
      },
    });
  if (p.pages > 1)
    blocks.push({
      type: "buttons",
      buttons: [
        {
          id: cid(R.page, s, list, Math.max(0, p.page - 1)),
          label: "◀",
          style: "secondary",
          disabled: p.page === 0,
        },
        {
          id: cid(R.page, s, list, p.page + 1),
          label: "▶",
          style: "secondary",
          disabled: p.page >= p.pages - 1,
        },
      ],
    });
  const reply = privately(
    x,
    card(
      "深海交易所",
      [...lines, ...(p.pages > 1 ? [`第 ${p.page + 1} / ${p.pages} 頁`] : [])],
      { real: list !== "local" },
      blocks,
    ),
  );
  return withOverviewPicture
    ? withPicture(pictures, "exchange_overview", overviewPictureData(x, x.nowMs()), reply)
    : reply;
}

// ---- a ticker's card -------------------------------------------------------------------------

async function quoteCard(
  x: ExchangeService,
  pictures: Pictures | null,
  who: AccountRef,
  line: RealLine,
  back: ListKind,
  note: string | null,
  /** The chart's timeframe (from the switch); none: the session in progress, else daily. */
  chosen: Timeframe | null = null,
): Promise<CommandReply> {
  const person = await x.personOf(who);
  if (person !== null) x.real.noteView(person, line.code);
  const s = stampFor(x, who);
  const watching = person !== null && x.lists.watching(person, line.code);
  const held =
    person === null ? [] : x.real.portfolio(person).holdings.filter((h) => h.code === line.code);
  const lines = [
    ...(note === null ? [] : [note, ""]),
    lineText(line),
    marketLine(line),
    ...(line.local
      ? [line.local.what_moves, ...(line.local.today ? [line.local.today] : [])]
      : [line.source]),
    ...held.map(
      (h) =>
        `你持有 ${sharesText(h.qty)} 股${h.leverage > 1 ? "(2 倍)" : ""}:市值 ${h.value === null ? "—" : coinText(h.value)} 魚幣`,
    ),
  ];
  const buttons: CardButton[] = [
    { id: cid(R.buy, s, line.code, back), label: "買", style: "primary", disabled: !x.config.open },
    {
      id: cid(R.sell, s, line.code, back),
      label: "賣",
      style: "secondary",
      disabled: held.length === 0,
    },
    {
      id: cid(R.watch, s, line.code, back, watching ? 0 : 1),
      label: watching ? "取消觀察" : "加入觀察",
      style: "secondary",
    },
    { id: cid(R.back, s, back), label: "回清單", style: "secondary" },
  ];
  const leverage = held.some((h) => h.leverage > 1);
  // The chart: the chosen timeframe, or the session in progress (daily before it has two bars).
  let set = await x.real.candles(line.code, chosen ?? defaultTimeframe(line));
  if (chosen === null && set && set.tf === "intraday" && set.candles.length < 2)
    set = await x.real.candles(line.code, "daily");
  const tf = set?.tf ?? chosen ?? "daily";
  const timeframes: CardBlock = {
    type: "select",
    select: {
      id: cid(R.tf, s, line.code, back),
      placeholder: "K 線:當日 / 日線 / 週線 / 月線",
      options: TIMEFRAMES.map((k) => ({
        label: `K 線:${TIMEFRAME_WORD[k]}`,
        value: k,
        default: k === tf,
      })),
    },
  };
  const text = privately(
    x,
    card(`${line.code} ${line.name}`, lines, { real: line.local === null, leverage }, [
      { type: "buttons", buttons },
      timeframes,
    ]),
  );
  return set ? withPicture(pictures, "exchange_quote", quotePictureData(x, set), text) : text;
}

function lineOf(x: ExchangeService, code: string): RealLine | null {
  return x.real.view().instruments.find((i) => i.code === code) ?? null;
}

// ---- orders ----------------------------------------------------------------------------------

export type Amount = { unit: "c" | "s" | "a"; value: number };

/** What a modal's amount says: coins, shares or everything (`fallback` when no unit is written). */
export function parseAmount(raw: string, fallback: "coins" | "shares"): Amount | null {
  const t = raw.trim().replace(/,/g, "");
  if (/^(全部|all)$/i.test(t)) return { unit: "a", value: 0 };
  const m = /^(\d+(?:\.\d{1,6})?)\s*(股|幣|魚幣|coins?|shares?)?$/i.exec(t);
  if (!m) return null;
  const value = Number(m[1]);
  if (!(value > 0)) return null;
  const word = (m[2] ?? "").toLowerCase();
  const unit: "c" | "s" =
    word === "股" || word.startsWith("share")
      ? "s"
      : word === ""
        ? fallback === "shares"
          ? "s"
          : "c"
        : "c";
  if (unit === "c" && !Number.isInteger(value)) return null;
  return { unit, value };
}

function orderModal(
  x: ExchangeService,
  s: Stamp,
  side: "buy" | "sell",
  line: RealLine,
  back: ListKind,
): Modal {
  const local = line.local !== null;
  const fields: Modal["fields"] = [
    {
      id: "amount",
      label:
        side === "buy"
          ? local
            ? "買幾股(也可以寫「100 幣」)"
            : "用多少魚幣(也可以寫「0.5 股」)"
          : "賣幾股(或寫「全部」)",
      placeholder: side === "buy" ? (local ? "1" : "100") : "全部",
      maxLength: 20,
    },
  ];
  if (side === "buy" && !local && x.config.leverage)
    fields.push({
      id: "leverage",
      label: "倍數:1 或 2(2 倍要先在會員頁同意風險)",
      placeholder: "1",
      required: false,
      maxLength: 1,
    });
  return {
    id: cid(R.order, s, side, line.code, back),
    title: `${side === "buy" ? "買進" : "賣出"} ${line.code}`.slice(0, 45),
    fields,
  };
}

/** A sale's request from what they typed: plain shares or all; a leveraged-only holding closes whole. */
function saleRequest(
  x: ExchangeService,
  person: string | null,
  code: string,
  amount: Amount,
): { side: "sell"; code: string; shares?: number; all?: boolean; position?: string } {
  const held =
    person === null ? [] : x.real.portfolio(person).holdings.filter((h) => h.code === code);
  const plain = held.filter((h) => h.leverage <= 1);
  const lev = held.find((h) => h.leverage > 1);
  if (plain.length === 0 && lev) return { side: "sell", code, position: lev.id };
  return amount.unit === "s"
    ? { side: "sell", code, shares: amount.value }
    : { side: "sell", code, all: true };
}

async function requestOf(
  x: ExchangeService,
  who: AccountRef,
  side: "buy" | "sell",
  code: string,
  amount: Amount,
  lev: number,
) {
  if (side === "buy")
    return {
      side,
      code,
      ...(amount.unit === "s" ? { shares: amount.value } : { coins: amount.value }),
      leverage: lev,
    } as const;
  return saleRequest(x, await x.personOf(who), code, amount);
}

async function confirmCard(
  x: ExchangeService,
  inv: ComponentInvocation,
  side: "buy" | "sell",
  code: string,
  back: ListKind,
  amount: Amount,
  lev: number,
): Promise<CommandReply> {
  const s = stampFor(x, inv.invoker);
  const q = await x.real.quote(
    inv.invoker,
    await requestOf(x, inv.invoker, side, code, amount, lev),
  );
  if (!q.ok)
    return privately(
      x,
      card("深海交易所", [q.message], { real: true }, [
        {
          type: "buttons",
          buttons: [{ id: cid(R.back, s, back), label: "回清單", style: "secondary" }],
        },
      ]),
    );
  const amt = amount.unit === "a" ? "all" : String(amount.value);
  const leverage = q.quote.leverage > 1;
  return privately(
    x,
    card(
      `確認${side === "buy" ? "買進" : "賣出"} ${code}`,
      [q.quote.sentence, ...(leverage ? [LEVERAGE_CONFIRM] : [])],
      { real: lineOf(x, code)?.local === null, leverage },
      [
        {
          type: "buttons",
          buttons: [
            {
              id: cid(R.ok, s, side, code, amt, amount.unit, lev, back),
              label: leverage ? "我了解風險,確認" : "確認",
              style: leverage ? "danger" : "primary",
            },
            { id: cid(R.no, s, code, back), label: "取消", style: "secondary" },
          ],
        },
      ],
    ),
  );
}

async function placeOrder(
  x: ExchangeService,
  pictures: Pictures | null,
  inv: ComponentInvocation,
  side: "buy" | "sell",
  code: string,
  amount: Amount,
  lev: number,
  back: ListKind,
): Promise<CommandReply> {
  // The same press (message and control) is the same order.
  const key = `discord:${inv.messageId ?? "none"}:${inv.customId}`;
  const r = await x.real.place(
    inv.invoker,
    await requestOf(x, inv.invoker, side, code, amount, lev),
    key,
  );
  const line = lineOf(x, code);
  if (!line) return privately(x, card("深海交易所", ["沒有這個標的"]));
  const note = r.ok
    ? `委託已送出:${side === "buy" ? "買進" : "賣出"} ${code}${r.order.status === "open" ? ",下一筆有效報價成交(成交前可以在會員頁取消)" : ""}。`
    : r.message;
  return quoteCard(x, pictures, inv.invoker, line, back, note);
}

// ---- registration ----------------------------------------------------------------------------

export function registerCommands(
  registry: CommandRegistry,
  service: () => ExchangeService | null,
  pictures: () => Pictures | null,
): void {
  registry.setGroupDescription("me market", "深海交易所:新手推薦、台股美股行情、你的持股、富人榜");
  const open = (): ExchangeService | null => {
    const x = service();
    return x === null || !x.config.open ? null : x;
  };
  const run = async (fn: (x: ExchangeService) => Promise<CommandReply>): Promise<CommandReply> => {
    const x = open();
    if (x === null) return card("深海交易所", [OFF]);
    return fn(x);
  };
  /** A control's handler: the market must be open, the press the opener's and in time. */
  const press =
    (
      fn: (
        x: ExchangeService,
        inv: ComponentInvocation,
        rest: readonly (string | undefined)[],
      ) => Promise<ComponentResult>,
    ) =>
    async (inv: ComponentInvocation): Promise<ComponentResult> => {
      const x = open();
      if (x === null) return ComponentResult.update(card("深海交易所", [OFF]));
      const no = refusal(x, inv);
      if (no) return no;
      return fn(x, inv, inv.params.slice(2));
    };
  const listOf = (raw: string | undefined): ListKind =>
    (LIST_KINDS as readonly string[]).includes(raw ?? "") ? (raw as ListKind) : "local";
  const gone = () => ComponentResult.update(card("深海交易所", ["沒有這個標的"]));

  const routes = [
    defineRoute({
      route: R.list,
      handle: press(async (x, inv) => {
        const value = inv.values[0] ?? "";
        const map = value.startsWith(MAP_PREFIX) ? value.slice(MAP_PREFIX.length) : null;
        if (map !== null && isMapKind(map))
          return ComponentResult.update(await mapCard(x, pictures(), inv.invoker, map));
        return ComponentResult.update(
          await overview(x, pictures(), inv.invoker, listOf(value), 0, false),
        );
      }),
    }),
    defineRoute({
      route: R.tf,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        const tf = inv.values[0];
        return ComponentResult.update(
          await quoteCard(
            x,
            pictures(),
            inv.invoker,
            line,
            listOf(kind),
            null,
            isTimeframe(tf) ? tf : null,
          ),
        );
      }),
    }),
    defineRoute({
      route: R.page,
      handle: press(async (x, inv, [kind, page]) =>
        ComponentResult.update(
          await overview(x, pictures(), inv.invoker, listOf(kind), Number(page) || 0, false),
        ),
      ),
    }),
    defineRoute({
      route: R.back,
      handle: press(async (x, inv, [kind]) =>
        ComponentResult.update(await overview(x, pictures(), inv.invoker, listOf(kind), 0, true)),
      ),
    }),
    defineRoute({
      route: R.pick,
      handle: press(async (x, inv, [kind]) => {
        const line = lineOf(x, inv.values[0] ?? "");
        if (!line)
          return ComponentResult.update(
            await overview(x, pictures(), inv.invoker, listOf(kind), 0, false),
          );
        return ComponentResult.update(
          await quoteCard(x, pictures(), inv.invoker, line, listOf(kind), null),
        );
      }),
    }),
    defineRoute({
      route: R.watch,
      handle: press(async (x, inv, [code, kind, on]) => {
        const person = await x.personOf(inv.invoker);
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        if (!person)
          return ComponentResult.update(card("深海交易所", ["她還不認識你,先和她說說話吧"]));
        const r = x.lists.setWatch(person, line.code, on === "1");
        const note = r.ok ? (r.watching ? `已加入觀察(${r.count} 檔)` : "已取消觀察") : r.message;
        return ComponentResult.update(
          await quoteCard(x, pictures(), inv.invoker, line, listOf(kind), note),
        );
      }),
    }),
    defineRoute({
      route: R.buy,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        return ComponentResult.modal(
          orderModal(x, stampFor(x, inv.invoker), "buy", line, listOf(kind)),
        );
      }),
    }),
    defineRoute({
      route: R.sell,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        return ComponentResult.modal(
          orderModal(x, stampFor(x, inv.invoker), "sell", line, listOf(kind)),
        );
      }),
    }),
    defineRoute({
      route: R.order,
      handle: press(async (x, inv, [side, code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line || (side !== "buy" && side !== "sell")) return gone();
        const amount = parseAmount(inv.field("amount"), line.local !== null ? "shares" : "coins");
        if (!amount || (side === "buy" && amount.unit === "a")) {
          return ComponentResult.update(
            await quoteCard(
              x,
              pictures(),
              inv.invoker,
              line,
              listOf(kind),
              "看不懂這個數量:寫數字,例如「100」「100 幣」「0.5 股」,賣出時也可以寫「全部」",
            ),
          );
        }
        const lev = inv.field("leverage") === "2" ? 2 : 1;
        return ComponentResult.update(
          await confirmCard(x, inv, side, line.code, listOf(kind), amount, lev),
        );
      }),
    }),
    defineRoute({
      route: R.ok,
      handle: press(async (x, inv, [side, code, amt, unit, lev, kind]) => {
        if (
          (side !== "buy" && side !== "sell") ||
          !code ||
          !amt ||
          (unit !== "c" && unit !== "s" && unit !== "a")
        )
          return ComponentResult.update(card("深海交易所", [EXPIRED]));
        const amount: Amount = { unit, value: unit === "a" ? 0 : Number(amt) };
        return ComponentResult.update(
          await placeOrder(
            x,
            pictures(),
            inv,
            side,
            code,
            amount,
            lev === "2" ? 2 : 1,
            listOf(kind),
          ),
        );
      }),
    }),
    defineRoute({
      route: R.no,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line)
          return ComponentResult.update(
            await overview(x, pictures(), inv.invoker, listOf(kind), 0, true),
          );
        return ComponentResult.update(
          await quoteCard(x, pictures(), inv.invoker, line, listOf(kind), "已取消,沒有下單。"),
        );
      }),
    }),
    defineRoute({
      route: R.share,
      // Posted where the command was used, with their name, only when they press it.
      handle: press(async (x, inv, [what, ref]) => {
        const person = await x.personOf(inv.invoker);
        if (!person)
          return ComponentResult.reply({
            ...card("深海交易所", ["她還不認識你,先和她說說話吧"]),
            ephemeral: true,
          });
        const name = inv.invoker_display_name;
        const p = x.real.portfolio(person);
        if (what === "r") {
          const fill = p.fills.find((f) => f.id === ref) ?? p.fills[0];
          if (!fill)
            return ComponentResult.reply({
              ...card("深海交易所", ["還沒有成交紀錄"]),
              ephemeral: true,
            });
          const data = receiptPictureData(x, name, fill);
          const text = card(
            `${name} 的成交`,
            [
              `${fill.side === "sell" ? "賣出" : "買進"} ${fill.code} ${data.shares} 股,成交價 ${data.price}`,
            ],
            { real: lineOf(x, fill.code)?.local === null, leverage: fill.leverage > 1 },
          );
          return ComponentResult.reply({
            ...(await withPicture(pictures(), "exchange_receipt", data, text)),
            ephemeral: false,
          });
        }
        const account = await x.portfolio(inv.invoker);
        const balance = account?.account.balance ?? null;
        const leverage = p.holdings.some((h) => h.leverage > 1);
        const text = card(
          `${name} 的持股`,
          p.holdings.map(
            (h) => `${h.code} ${sharesText(h.qty)} 股${h.leverage > 1 ? "(2 倍)" : ""}`,
          ),
          { real: true, leverage },
        );
        return ComponentResult.reply({
          ...(await withPicture(
            pictures(),
            "exchange_portfolio",
            portfolioPictureData(x, name, p, balance),
            text,
          )),
          ephemeral: false,
        });
      }),
    }),
  ];

  registry.register(
    commandSpec("me market overview", "深海交易所:市場總覽,從清單挑股票看報價、買賣", {
      permission: NODE,
    }),
    async (inv) => {
      const x = open();
      if (x === null) return { ...card("深海交易所", [OFF]), ephemeral: true };
      return overview(x, pictures(), inv.invoker, null, 0, true);
    },
    { components: routes },
  );

  registry.register(
    commandSpec("me market quote", "深海交易所:一檔股票的報價和走勢(圖)", {
      args: [argSpec("code", "代號或名稱:台股 2330、0050,美股 AAPL,或獨家的 RICE", ArgKind.string)],
      permission: NODE,
    }),
    (inv) =>
      run(async (x) => {
        const typed = (inv.str("code") ?? "").trim().toUpperCase();
        let line = lineOf(x, typed);
        if (!line) {
          const found = await x.real.lookup(inv.invoker, typed);
          if (!found.ok)
            return { ...card("深海交易所", [found.message], { real: true }), ephemeral: true };
          line = found.instrument;
        }
        return quoteCard(x, pictures(), inv.invoker, line, "recent", null);
      }),
    {
      autocomplete: {
        code: (inv: Invocation, value: string) => {
          const x = open();
          if (x === null) return [];
          return x.lists
            .suggest(ownerTag(inv.invoker), value)
            .map((s) => ({ name: `${s.code} ${s.name}`.slice(0, 100), value: s.code }));
        },
      },
    },
  );

  registry.register(
    commandSpec("me market mine", "深海交易所:你的持股(只有你看得到)", { permission: NODE }),
    (inv) =>
      run(async (x) => {
        const p = await x.portfolio(inv.invoker);
        if (!p) return { ...card("深海交易所", ["她還不認識你,先和她說說話吧"]), ephemeral: true };
        if (!p.account.opened)
          return {
            ...card("你的持股", ["還沒開戶:會員頁的「深海交易所」可以開戶"]),
            ephemeral: true,
          };
        const real = x.real.portfolio((await x.personOf(inv.invoker)) ?? "");
        const lines = real.holdings.map(
          (h) =>
            `${h.code} ${sharesText(h.qty)} 股${h.leverage > 1 ? "・2 倍" : ""}:市值 ${h.value === null ? "—" : coinText(h.value)} 魚幣,成本 ${h.cost}`,
        );
        if (real.bankrupt) lines.unshift("破產冷靜期中:所有持股已經結清,不會欠錢");
        if (lines.length === 0) lines.push("沒有持股");
        const leverage = real.holdings.some((h) => h.leverage > 1);
        const s = stampFor(x, inv.invoker);
        const latest = real.fills[0];
        const buttons: CardButton[] = [
          {
            id: cid(R.share, s, "p", "0"),
            label: "分享持股",
            style: "secondary",
            disabled: real.holdings.length === 0,
          },
          ...(latest
            ? [
                {
                  id: cid(R.share, s, "r", latest.id),
                  label: "分享最近一筆成交",
                  style: "secondary" as const,
                },
              ]
            : []),
        ];
        const text = privately(
          x,
          card(
            "你的持股",
            [...lines, "只有你看得到;按「分享」才會用你的名字貼出來。她也看不到任何人的持股。"],
            { real: true, leverage },
            [{ type: "buttons", buttons }],
          ),
        );
        if (real.bankrupt)
          return withPicture(
            pictures(),
            "exchange_bankrupt",
            bankruptPictureData(x, inv.invoker_display_name, real.bankrupt),
            text,
          );
        return withPicture(
          pictures(),
          "exchange_portfolio",
          portfolioPictureData(x, inv.invoker_display_name, real, p.account.balance),
          text,
        );
      }),
  );

  registry.register(
    commandSpec("me market rich", "深海交易所:富人榜(圖)", { permission: NODE }),
    (inv) =>
      run(async (x) => {
        const b = await x.boards(inv.invoker);
        const rows = b.rich.slice(0, 10).map((r) => `${r.rank}. ${r.name} ${r.worth}`);
        const text = card(
          "富人榜",
          [...(rows.length === 0 ? ["還沒有人上榜"] : rows), "預設會上榜;會員頁可以設定不上榜。"],
          { real: true },
        );
        // The board is posted where anyone sees it: nobody's own place is on the picture.
        return withPicture(pictures(), "exchange_rich", { ...boardPictureData(b), me: null }, text);
      }),
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
