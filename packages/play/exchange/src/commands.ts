// `/me market …` (owner 2026-11-21: no new top-level command; a group under `/me`): every answer
// is a picture with a neutral text card under it, the card alone when no picture can be drawn.
//
// - `/me market quote code:` a company's quote with its two-week line and its newest news.
// - `/me market day`: today's market: the index, every company's move, the totals, her closing line.
// - `/me market mine`: their own holdings and leveraged positions; only they see it.
// - `/me market rich`, `/me market volume`: the rich list and the week's volume table (people who
//   hide are not on them; the viewer's own place is said to them only).
//
// Buying and selling stay on the member page, where the order ticket shows its confirmation in
// plain numbers before anything is placed.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  cardReply,
  commandSpec,
  notice,
} from "@miyoria/commands";
import type { Pictures } from "@miyoria/types";
import { COMPANY_CODES, priceText, qtyText } from "./engine/index.js";
import {
  boardPictureData,
  dayPictureData,
  portfolioPictureData,
  quotePictureData,
  withPicture,
} from "./pictures.js";
import type { ExchangeService } from "./service.js";

export const PATHS = [
  "me market quote",
  "me market day",
  "me market mine",
  "me market rich",
  "me market volume",
] as const;

/** The wallet's node: a role without it, like `blocked`, cannot take part. */
const NODE = "me.wallet";
const OFF = "交易所現在沒有開";

const pct = (x: number) => {
  const v = Math.round(x * 1000) / 10;
  return v > 0 ? `+${v.toFixed(1)}%` : v < 0 ? `−${Math.abs(v).toFixed(1)}%` : "0.0%";
};
const limitWord = (l: "up" | "down" | null) => (l === "up" ? " 漲停" : l === "down" ? " 跌停" : "");

function card(title: string, lines: string[], muted: string | null = null): CommandReply {
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      ...(muted ? [{ type: "muted" as const, text: muted }] : []),
    ],
    { accent: "neutral", title },
  );
}

export function registerCommands(
  registry: CommandRegistry,
  service: () => ExchangeService | null,
  pictures: () => Pictures | null,
): void {
  registry.setGroupDescription("me market", "深海交易所：行情、個股、你的持股、富人榜與交易量");
  const run = async (fn: (x: ExchangeService) => Promise<CommandReply>): Promise<CommandReply> => {
    const x = service();
    if (x === null || !x.config.open) return notice("info", OFF);
    return fn(x);
  };

  registry.register(
    commandSpec("me market quote", "深海交易所:一家公司的走勢和最新消息(圖)", {
      args: [argSpec("code", "公司代號", ArgKind.choice(COMPANY_CODES))],
      permission: NODE,
    }),
    (inv) =>
      run(async (x) => {
        const code = inv.str("code") ?? "";
        const view = await x.company(code, null);
        if (!view) return notice("info", "沒有這家公司");
        const c = view.company;
        const text = card(`${c.code} ${c.name}`, [
          `現價 ${priceText(c.price)}(${pct(c.change)}${limitWord(c.limit)}),參考價 ${priceText(c.ref)}`,
          ...view.news
            .slice(0, 2)
            .map((n) => `${n.direction === "up" ? "利多" : "利空"}:${n.headline}`),
        ]);
        return withPicture(pictures(), "exchange_quote", quotePictureData(x, view), text);
      }),
  );

  registry.register(
    commandSpec("me market day", "深海交易所:今天的行情(圖)", { permission: NODE }),
    () =>
      run(async (x) => {
        const s = x.summary();
        const her = x.store.words(`close:${s.day}`)?.text ?? null;
        const delta = s.fish_ref > 0 ? s.fish / s.fish_ref - 1 : 0;
        const sorted = [...s.companies].sort((a, b) => b.change - a.change);
        const text = card("今天的行情", [
          `FISH ${s.fish.toFixed(0)}(${pct(delta)}),成交 ${s.volume},燒掉 ${s.burned}${s.halted ? ",今天熔斷過" : ""}`,
          sorted.map((c) => `${c.code} ${pct(c.change)}${limitWord(c.limit)}`).join("・"),
        ]);
        return withPicture(pictures(), "exchange_day", dayPictureData(x, her), text);
      }),
  );

  registry.register(
    commandSpec("me market mine", "深海交易所:你的持股和槓桿部位(只有你看得到)", {
      permission: NODE,
      ephemeral: true,
    }),
    (inv) =>
      run(async (x) => {
        const p = await x.portfolio(inv.invoker);
        if (!p) return notice("info", "她還不認識你,先和她說說話吧");
        if (!p.account.opened) return notice("info", "還沒開戶:會員頁的「深海交易所」可以開戶");
        const lines = [
          `總資產 ${p.totals.worth === null ? "—" : Math.floor(p.totals.worth)}(錢包 ${p.account.balance ?? "—"})`,
          ...p.holdings.map(
            (h) => `${h.code} ${qtyText(h.qty)} 股,成本 ${h.cost},市值 ${Math.floor(h.value)}`,
          ),
          ...p.leveraged.map(
            (l) =>
              `${l.code} ${l.leverage} 倍,保證金 ${l.margin},剩 ${Math.max(0, Math.floor(l.equity))},跌到 ${priceText(l.line_price)} 自動賣出`,
          ),
        ];
        if (p.holdings.length === 0 && p.leveraged.length === 0) lines.push("沒有持股");
        const text = {
          ...card("你的持股", lines, "只有你看得到;她也看不到任何人的持股。"),
          ephemeral: true,
        };
        return withPicture(
          pictures(),
          "exchange_portfolio",
          portfolioPictureData(x, inv.invoker_display_name, p),
          text,
        );
      }),
  );

  for (const kind of ["rich", "volume"] as const) {
    const title = kind === "rich" ? "富人榜" : "本週交易量";
    registry.register(
      commandSpec(`me market ${kind}`, `深海交易所:${title}(圖)`, { permission: NODE }),
      (inv) =>
        run(async (x) => {
          const b = await x.boards(inv.invoker);
          const rows =
            kind === "rich"
              ? b.rich.slice(0, 10).map((r) => `${r.rank}. ${r.name} ${r.worth}`)
              : b.volume.slice(0, 10).map((r) => `${r.rank}. ${r.name} ${r.volume}`);
          const text = card(
            title,
            rows.length === 0 ? ["還沒有人上榜"] : rows,
            "預設會上榜;會員頁可以設定不上榜。",
          );
          // The board is posted where anyone sees it: nobody's own place is on the picture.
          const data = { ...boardPictureData(kind, b), me: null };
          return withPicture(
            pictures(),
            kind === "rich" ? "exchange_rich" : "exchange_volume",
            data,
            text,
          );
        }),
    );
  }
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
