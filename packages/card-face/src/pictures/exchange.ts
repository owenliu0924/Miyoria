// The deep-sea exchange's pictures (docs/design/exchange.md §7): a company's quote with its line, a
// member's own portfolio, the day's market, the rich list and the week's volume table. They read
// like the panel's exchange page: the frame with `交易所 / 頁面`, a chart block with its 24 px
// headline, strips of facts, hairline rows. A move is never colour alone: every change carries its
// sign (+1.2% / −0.8%) and the words 漲停 / 跌停, and the line chart marks the reference price
// with a dashed line and its number. Prices come in cents and are drawn with two decimals.

import type {
  ExchangeBoardPicture,
  ExchangeDayPicture,
  ExchangePortfolioPicture,
  ExchangeQuotePicture,
} from "@miyoria/types";
import {
  baseline,
  blockTitle,
  type Canvas,
  CONTENT,
  facts,
  finish,
  meter,
  num,
  page,
  paragraph,
  plainLine,
  rows,
  SPACE,
  T,
  TYPE,
  X0,
} from "./draw.js";
import { textWidth } from "./measure.js";

type Out = { drawn: ReturnType<typeof finish>; alt: string };

const UP = T.chart1;
const DOWN = T.chart2;

/** Cents as `123.45`. */
export function price(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** A change as `+1.2%` / `−0.8%` / `0.0%`. */
export function change(x: number): string {
  const v = Math.round(x * 1000) / 10;
  if (v > 0) return `+${v.toFixed(1)}%`;
  if (v < 0) return `−${Math.abs(v).toFixed(1)}%`;
  return "0.0%";
}

function limitWord(limit: "up" | "down" | null): string {
  return limit === "up" ? "漲停" : limit === "down" ? "跌停" : "";
}

const colorOf = (x: number) => (x > 0 ? UP : x < 0 ? DOWN : T.sheetMuted);

/** The headline block: title, the big number, the change with its sign beside it. */
function head(c: Canvas, top: number, title: string, value: string, delta: string, color: string, aside: string | null): number {
  c.text(X0, baseline(top, TYPE.label), title, { size: TYPE.label, fill: T.sheetMuted, max: CONTENT });
  const y = baseline(top + TYPE.label + 6, TYPE.headline);
  const w = c.text(X0, y, value, { size: TYPE.headline, weight: 700, max: CONTENT * 0.5 });
  c.text(X0 + w + 10, y, delta, { size: TYPE.title, weight: 700, fill: color, max: CONTENT * 0.25 });
  if (aside !== null) c.text(X0 + CONTENT, y, aside, { size: TYPE.label, fill: T.sheetMuted, anchor: "end", max: CONTENT * 0.3 });
  return top + TYPE.label + 6 + TYPE.headline + 10;
}

/**
 * A line of `values` (oldest first) in a box `height` tall, with the reference as a dashed line
 * and its number, and the highest and lowest values at the right. Answers the bottom.
 */
function lineChart(c: Canvas, top: number, values: readonly number[], height: number, ref: number | null, label: (v: number) => string): number {
  const labelW = 54;
  const w = CONTENT - labelW;
  if (values.length < 2) {
    c.rect(X0, top, w, height, T.chartFaint, 4);
    c.text(X0 + w / 2, baseline(top + height / 2 - 8, TYPE.label), "還沒有走勢", { size: TYPE.label, fill: T.sheetMuted, anchor: "middle" });
    return top + height;
  }
  const all = ref === null ? values : [...values, ref];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (i: number) => X0 + (i / (values.length - 1)) * w;
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * height;
  for (let g = 0; g <= 3; g++) c.hairline(X0, top + (g / 3) * height, w, T.chartGrid);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const last = values[values.length - 1] as number;
  const first = values[0] as number;
  const color = colorOf(last - (ref ?? first));
  c.shape(`<path d="M${pts.join(" L")} L${x(values.length - 1).toFixed(1)},${(top + height).toFixed(1)} L${X0},${(top + height).toFixed(1)} Z" fill="${color}" fill-opacity="0.12"/>`);
  c.shape(`<path d="M${pts.join(" L")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  if (ref !== null) {
    const ry = y(ref).toFixed(1);
    c.shape(`<line x1="${X0}" y1="${ry}" x2="${X0 + w}" y2="${ry}" stroke="${T.chartAxis}" stroke-width="1" stroke-dasharray="4 4"/>`);
    c.text(X0 + CONTENT, baseline(y(ref) - 7, TYPE.tick), `參考 ${label(ref)}`, { size: TYPE.tick, fill: T.sheetMuted, anchor: "end", max: labelW + 20 });
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  c.text(X0 + CONTENT, baseline(top - 2, TYPE.tick), label(max), { size: TYPE.tick, fill: T.sheetMuted, anchor: "end", max: labelW });
  c.text(X0 + CONTENT, baseline(top + height - 12, TYPE.tick), label(min), { size: TYPE.tick, fill: T.sheetMuted, anchor: "end", max: labelW });
  c.shape(`<circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="${color}"/>`);
  return top + height;
}

/** A row with a coloured change on the right, the sign always written. */
function moveRows(c: Canvas, top: number, items: readonly { text: string; value: string; delta: number; note: string }[]): number {
  let y = top;
  items.forEach((item, i) => {
    if (i > 0) c.hairline(X0, y, CONTENT);
    const ty = baseline(y + SPACE.rowY, TYPE.body);
    const deltaText = `${change(item.delta)}${item.note === "" ? "" : ` ${item.note}`}`;
    const dw = textWidth(deltaText, TYPE.label) + 4;
    const vw = textWidth(item.value, TYPE.body) + 12;
    c.text(X0, ty, item.text, { max: CONTENT - dw - vw - 16 });
    c.text(X0 + CONTENT - dw - 8, ty, item.value, { anchor: "end", max: vw });
    c.text(X0 + CONTENT, ty, deltaText, { size: TYPE.label, weight: 700, fill: colorOf(item.delta), anchor: "end", max: dw });
    y += SPACE.rowY * 2 + TYPE.body + 4;
  });
  return y;
}

export function exchangeQuotePicture(d: ExchangeQuotePicture): Out {
  const { canvas: c, top } = page("交易所", `${d.code} ${d.name}`, d.as_of);
  const word = limitWord(d.limit);
  let y = head(c, top, `現價(${d.sector})`, price(d.price), `${change(d.change)}${word === "" ? "" : ` ${word}`}`, colorOf(d.change), d.range);
  y = lineChart(c, y + 6, d.series, 132, d.ref, price) + 16;
  const hi = d.series.length > 0 ? Math.max(...d.series) : d.price;
  const lo = d.series.length > 0 ? Math.min(...d.series) : d.price;
  y = facts(c, y, [
    { label: "參考價", value: price(d.ref) },
    { label: "漲跌", value: change(d.change) },
    { label: "兩週最高", value: price(hi) },
    { label: "兩週最低", value: price(lo) },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "最新消息");
  y =
    d.news.length === 0
      ? plainLine(c, y, "最近沒有消息")
      : rows(c, y - SPACE.rowY, d.news.slice(0, 3).map((n) => ({ text: n.headline, aside: n.direction === "up" ? "利多" : "利空" }))) - 4;
  y += 10;
  y = paragraph(c, y, d.blurb, 2, { fill: T.sheetMuted, size: TYPE.label });
  const alt = `${d.code} ${d.name}:${price(d.price)}(${change(d.change)}${word === "" ? "" : `,${word}`}),參考價 ${price(d.ref)}${d.news[0] ? `;最新消息:${d.news[0].headline}` : ""}。`;
  return { drawn: finish(c, y), alt };
}

export function exchangePortfolioPicture(d: ExchangePortfolioPicture): Out {
  const { canvas: c, top } = page("交易所", `${d.name} 的持股`, d.as_of);
  const held = d.holdings.reduce((t, h) => t + h.value, 0) + d.leveraged.reduce((t, l) => t + Math.max(0, l.equity), 0);
  const cost = d.holdings.reduce((t, h) => t + h.cost, 0) + d.leveraged.reduce((t, l) => t + l.margin, 0);
  const pnl = held - cost;
  let y = head(
    c,
    top,
    "總資產(錢包加持股市值)",
    d.worth === null ? "—" : num(d.worth),
    cost > 0 ? `${pnl >= 0 ? "+" : "−"}${num(Math.abs(pnl))}` : "",
    colorOf(pnl),
    d.balance === null ? null : `錢包 ${num(d.balance)} ${d.currency}`,
  );
  y = facts(c, y, [
    { label: "持股市值", value: num(held), unit: d.currency },
    { label: "成本", value: num(cost), unit: d.currency },
    { label: "槓桿部位", value: num(d.leveraged.length), unit: "個" },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "持股");
  y =
    d.holdings.length === 0
      ? plainLine(c, y, "沒有持股")
      : moveRows(
          c,
          y - SPACE.rowY,
          d.holdings.map((h) => ({
            text: `${h.code}・${h.qty} 股・成本 ${num(h.cost)}`,
            value: num(h.value),
            delta: h.cost > 0 ? h.value / h.cost - 1 : 0,
            note: "",
          })),
        ) - 4;
  if (d.leveraged.length > 0) {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, "槓桿部位", "最多賠掉保證金,不會欠錢");
    for (const l of d.leveraged) {
      const line = `${l.code}・保證金 ${num(l.margin)}・剩 ${num(Math.max(0, l.equity))}(${Math.max(0, Math.round(l.ratio * 100))}%)`;
      c.text(X0, baseline(y, TYPE.body), line, { max: CONTENT * 0.62 });
      c.text(X0 + CONTENT, baseline(y, TYPE.label), `跌到 ${price(l.line_price)} 自動賣出`, { size: TYPE.label, fill: T.sheetMuted, anchor: "end", max: CONTENT * 0.36 });
      meter(c, X0, y + TYPE.body + 8, CONTENT, Math.max(0, Math.min(1, l.ratio)), l.ratio <= 0.5 ? DOWN : UP);
      y += TYPE.body + 26;
    }
  }
  const alt = `${d.name}的持股:總資產 ${d.worth === null ? "—" : num(d.worth)} ${d.currency},持股市值 ${num(held)}、成本 ${num(cost)}${d.leveraged.length > 0 ? `;${d.leveraged.length} 個槓桿部位,${d.leveraged.map((l) => `${l.code} 跌到 ${price(l.line_price)} 自動賣出`).join("、")}` : ""}。`;
  return { drawn: finish(c, y), alt };
}

export function exchangeDayPicture(d: ExchangeDayPicture): Out {
  const { canvas: c, top } = page("交易所", "今天的行情", d.date);
  const delta = d.fish_ref > 0 ? d.fish / d.fish_ref - 1 : 0;
  let y = head(c, top, "魚市指數 FISH", d.fish.toFixed(0), change(delta), colorOf(delta), d.halted ? "今天熔斷過" : null);
  y = lineChart(c, y + 6, d.series, 96, d.fish_ref, (v) => v.toFixed(0)) + 16;
  y = facts(c, y, [
    { label: "成交", value: num(d.volume), unit: d.currency },
    { label: "燒掉", value: num(d.burned), unit: d.currency },
    { label: "水位", value: d.level === null ? "—" : d.level.toFixed(2) },
    { label: "金庫", value: num(d.vault), unit: d.currency },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "八家公司", "漲跌對昨天收盤");
  const sorted = [...d.companies].sort((a, b) => b.change - a.change);
  y = moveRows(c, y - SPACE.rowY, sorted.map((x) => ({ text: `${x.code} ${x.name}`, value: price(x.price), delta: x.change, note: limitWord(x.limit) }))) - 4;
  if (d.her !== null && d.her.trim() !== "") {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, "她的收盤講評");
    y = paragraph(c, y, d.her, 4);
  }
  const best = sorted[0];
  const worst = sorted.at(-1);
  const alt = `今天的行情:FISH ${d.fish.toFixed(0)}(${change(delta)}),成交 ${num(d.volume)} ${d.currency},燒掉 ${num(d.burned)}${best && worst ? `;漲最多 ${best.code} ${change(best.change)},跌最多 ${worst.code} ${change(worst.change)}` : ""}${d.halted ? ";今天熔斷過" : ""}。`;
  return { drawn: finish(c, y), alt };
}

function board(d: ExchangeBoardPicture, title: string, unit: string, note: string): Out {
  const { canvas: c, top } = page("交易所", title, d.week_start === null ? null : `${d.week_start} 起`);
  const total = d.rows.reduce((t, r) => t + r.value, 0);
  let y = facts(c, top, [
    { label: "上榜", value: num(d.rows.length), unit: "人" },
    { label: "合計", value: num(total), unit },
    { label: "第一名", value: d.rows[0] ? num(d.rows[0].value) : "—", unit },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, title, note);
  y =
    d.rows.length === 0
      ? plainLine(c, y, "還沒有人上榜")
      : rows(
          c,
          y - SPACE.rowY,
          d.rows.slice(0, 15).map((r) => ({ text: `${r.rank}. ${r.name}`, aside: `${num(r.value)} ${unit}${r.extra === null ? "" : `・${r.extra}`}` })),
        ) - 4;
  y += 12;
  y = plainLine(c, y, "預設會上榜;會員頁的交易所可以設定不上榜。");
  if (d.me !== null) {
    y += 4;
    const mine = d.me.hidden ? "你設定了不上榜" : d.me.rank === null ? "你還沒上榜" : `你是第 ${d.me.rank} 名`;
    y = plainLine(c, y, mine);
  }
  const top3 = d.rows.slice(0, 3).map((r) => `${r.rank}. ${r.name} ${num(r.value)}`).join("、");
  return { drawn: finish(c, y), alt: `${title}:${top3 === "" ? "還沒有人上榜" : top3}。` };
}

export const exchangeRichPicture = (d: ExchangeBoardPicture): Out => board(d, "富人榜", d.currency, "錢包加持股市值;設定不上榜的人不列");
export const exchangeVolumePicture = (d: ExchangeBoardPicture): Out => board(d, "本週交易量", d.currency, "這一週買賣的金額;不排賺賠");
