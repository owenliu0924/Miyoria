// `/me market …` (owner 2026-11-21: no new top-level command; a group under `/me`). v1: real Taiwan
// and US stocks and the five local ones. Every answer is a neutral card with the exchange's small
// print, and a picture above it when one can be drawn.
//
// - `/me market overview`: the five local stocks first (新手推薦 · 這裡獨家), then what is in use.
// - `/me market quote code:` a ticker's price in its currency and in coins, its quote time, its line.
// - `/me market mine`: their own holdings; only they see it.
// - `/me market rich`: the rich list (people who hide are not on it).
//
// Buying and selling stay on the member page, where the order ticket shows its confirmation.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  cardReply,
  commandSpec,
  notice,
} from "@miyoria/commands";
import { exchangeSmallPrint, type Pictures } from "@miyoria/types";
import {
  boardPictureData,
  portfolioPictureData,
  quotePictureData,
  sharesText,
  withPicture,
} from "./pictures.js";
import type { RealLine } from "./real/desk.js";
import type { ExchangeService } from "./service.js";

export const PATHS = [
  "me market overview",
  "me market quote",
  "me market mine",
  "me market rich",
] as const;

/** The wallet's node: a role without it, like `blocked`, cannot take part. */
const NODE = "me.wallet";
const OFF = "交易所現在沒有開";

const pct = (x: number | null) => {
  if (x === null) return "";
  const v = Math.round(x * 1000) / 10;
  return v > 0 ? `+${v.toFixed(1)}%` : v < 0 ? `−${Math.abs(v).toFixed(1)}%` : "0.0%";
};

/** A line of one ticker: its price in its currency and in coins, its change, its quote time. */
export function lineText(l: RealLine): string {
  if (l.price === null) return `${l.code} ${l.name}:還沒有報價`;
  const native =
    l.currency === "COIN" ? `${l.price} 魚幣` : `${l.currency} ${l.price}(${l.coin_price} 魚幣)`;
  const age = l.age_minutes === null ? "" : `,${l.age_minutes} 分鐘前的報價`;
  return `${l.code} ${l.name}:${native} ${pct(l.change)}${age}`;
}

/** A neutral card with the small print under it, always. */
export function card(
  title: string,
  lines: string[],
  o: { real?: boolean; leverage?: boolean } = {},
): CommandReply {
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      { type: "muted", text: exchangeSmallPrint(o) },
    ],
    { accent: "neutral", title },
  );
}

export function registerCommands(
  registry: CommandRegistry,
  service: () => ExchangeService | null,
  pictures: () => Pictures | null,
): void {
  registry.setGroupDescription("me market", "深海交易所:新手推薦、台股美股行情、你的持股、富人榜");
  const run = async (fn: (x: ExchangeService) => Promise<CommandReply>): Promise<CommandReply> => {
    const x = service();
    if (x === null || !x.config.open) return card("深海交易所", [OFF]);
    return fn(x);
  };

  registry.register(
    commandSpec("me market overview", "深海交易所:新手推薦的獨家股票和大家在看的行情", {
      permission: NODE,
    }),
    () =>
      run(async (x) => {
        const v = x.real.view();
        const local = v.instruments.filter((i) => i.local !== null);
        const real = v.instruments.filter((i) => i.local === null && i.price !== null).slice(0, 10);
        const lines = [
          "新手推薦 · 這裡獨家(波動較小、單日漲跌 ±10%、不開放槓桿):",
          ...local.map((l) => `${lineText(l)} — ${l.local?.what_moves ?? ""}`),
          ...(real.length > 0 ? ["", "台股和美股:", ...real.map(lineText)] : []),
        ];
        return card("深海交易所", lines, { real: real.length > 0 });
      }),
  );

  registry.register(
    commandSpec("me market quote", "深海交易所:一檔股票的報價和走勢(圖)", {
      args: [argSpec("code", "代號:台股 2330、0050,美股 AAPL,或獨家的 RICE", ArgKind.string)],
      permission: NODE,
    }),
    (inv) =>
      run(async (x) => {
        const typed = (inv.str("code") ?? "").trim().toUpperCase();
        let line = x.real.view().instruments.find((i) => i.code === typed) ?? null;
        if (!line) {
          const found = await x.real.lookup(inv.invoker, typed);
          if (!found.ok) return card("深海交易所", [found.message]);
          line = found.instrument;
        }
        const history = x.real.history(line.code);
        const text = card(`${line.code} ${line.name}`, [lineText(line), line.source], {
          real: line.local === null,
        });
        return history
          ? withPicture(pictures(), "exchange_quote", quotePictureData(x, history), text)
          : text;
      }),
  );

  registry.register(
    commandSpec("me market mine", "深海交易所:你的持股(只有你看得到)", {
      permission: NODE,
      ephemeral: true,
    }),
    (inv) =>
      run(async (x) => {
        const p = await x.portfolio(inv.invoker);
        if (!p) return notice("info", "她還不認識你,先和她說說話吧");
        if (!p.account.opened)
          return {
            ...card("你的持股", ["還沒開戶:會員頁的「深海交易所」可以開戶"]),
            ephemeral: true,
          };
        const real = x.real.portfolio((await x.personOf(inv.invoker)) ?? "");
        const lines = real.holdings.map(
          (h) =>
            `${h.code} ${sharesText(h.qty)} 股${h.leverage > 1 ? "・2 倍" : ""}:市值 ${h.value === null ? "—" : Math.floor(h.value)} 魚幣`,
        );
        if (real.bankrupt) lines.unshift("破產冷靜期中");
        if (lines.length === 0) lines.push("沒有持股");
        const leverage = real.holdings.some((h) => h.leverage > 1);
        const text = {
          ...card("你的持股", [...lines, "只有你看得到;她也看不到任何人的持股。"], {
            real: true,
            leverage,
          }),
          ephemeral: true,
        };
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
        const text = card("富人榜", [
          ...(rows.length === 0 ? ["還沒有人上榜"] : rows),
          "預設會上榜;會員頁可以設定不上榜。",
        ]);
        // The board is posted where anyone sees it: nobody's own place is on the picture.
        return withPicture(pictures(), "exchange_rich", { ...boardPictureData(b), me: null }, text);
      }),
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
