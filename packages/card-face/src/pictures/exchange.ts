// The deep-sea exchange's pictures (docs/design/exchange.md §7): the market overview (the five
// local stocks with their lines, what the server holds most, the sessions), a ticker's quote with
// its line, a member's own portfolio, the rich list, a trade receipt and the bankruptcy notice.
// They read like the panel's exchange page: the frame with `交易所 / 頁面`, a chart block with its
// 24 px headline, strips of facts, hairline rows.
//
// Up and down (owner 2026-11-21): one convention for the whole product, `colors` in the data —
// `tw` red up and green down (the default), `us` green up and red down — stated in a legend on
// every chart. A move is never colour alone: every change carries its sign and an arrow (▲ +1.2% /
// ▼ −0.8%). These two are the only red and green the pictures use. Prices come in cents and are
// drawn with two decimals. Every picture ends with the exchange's small print.

import type {
  ExchangeBankruptPicture,
  ExchangeBoardPicture,
  ExchangeColors,
  ExchangeOverviewPicture,
  ExchangePortfolioPicture,
  ExchangeQuotePicture,
  ExchangeReceiptPicture,
} from "@miyoria/types";
import {
  baseline,
  blockTitle,
  type Canvas,
  CONTENT,
  facts,
  finish,
  legend,
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

/** The market's red and green, softened for the dark glass. */
const RED = "#ef5f5f";
const GREEN = "#3fc48a";

/** Up's and down's colours under a convention. */
export function moveColors(colors: ExchangeColors): { up: string; down: string } {
  return colors === "us" ? { up: GREEN, down: RED } : { up: RED, down: GREEN };
}

/** The legend's words (`紅漲綠跌`). */
export function conventionWord(colors: ExchangeColors): string {
  return colors === "us" ? "綠漲紅跌(美股習慣)" : "紅漲綠跌(台股習慣)";
}

/** The small print at the bottom of every exchange picture (legible at Discord's preview size). */
function smallPrint(c: Canvas, y: number, text: string): number {
  c.hairline(X0, y + 10, CONTENT);
  return paragraph(c, y + 20, text, 4, { size: TYPE.label, fill: T.sheetMuted });
}

/** The convention's legend: ▲ up and ▼ down in their colours. */
function moveLegend(c: Canvas, top: number, colors: ExchangeColors): number {
  const m = moveColors(colors);
  return legend(c, top, [
    { label: "▲ 漲", color: m.up },
    { label: "▼ 跌", color: m.down },
    { label: conventionWord(colors), color: T.chartFaint },
  ]);
}

/** Cents as `123.45`. */
export function price(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** A change with its arrow and sign: `▲ +1.2%` / `▼ −0.8%` / `0.0%`. */
export function change(x: number): string {
  const v = Math.round(x * 1000) / 10;
  if (v > 0) return `▲ +${v.toFixed(1)}%`;
  if (v < 0) return `▼ −${Math.abs(v).toFixed(1)}%`;
  return "0.0%";
}

function limitWord(limit: "up" | "down" | null): string {
  return limit === "up" ? "漲停" : limit === "down" ? "跌停" : "";
}

const colorOf = (x: number, colors: ExchangeColors) => {
  const m = moveColors(colors);
  return x > 0 ? m.up : x < 0 ? m.down : T.sheetMuted;
};

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
function lineChart(c: Canvas, top: number, values: readonly number[], height: number, ref: number | null, label: (v: number) => string, colors: ExchangeColors): number {
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
  const color = colorOf(last - (ref ?? first), colors);
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

/** A small line (a sparkline) in a box, coloured by its move. */
function sparkline(c: Canvas, x0: number, top: number, w: number, h: number, values: readonly number[], colors: ExchangeColors): void {
  if (values.length < 2) {
    c.hairline(x0, top + h / 2, w, T.chartGrid);
    return;
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values) === lo ? lo + 1 : Math.max(...values);
  const pts = values.map((v, i) => `${(x0 + (i / (values.length - 1)) * w).toFixed(1)},${(top + (1 - (v - lo) / (hi - lo)) * h).toFixed(1)}`);
  const color = colorOf((values.at(-1) as number) - (values[0] as number), colors);
  c.shape(`<path d="M${pts.join(" L")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`);
}

/** A row with a coloured change on the right, the sign and arrow always written. */
function moveRows(c: Canvas, top: number, items: readonly { text: string; value: string; delta: number | null; note: string }[], colors: ExchangeColors): number {
  let y = top;
  items.forEach((item, i) => {
    if (i > 0) c.hairline(X0, y, CONTENT);
    const ty = baseline(y + SPACE.rowY, TYPE.body);
    const deltaText = `${item.delta === null ? "—" : change(item.delta)}${item.note === "" ? "" : ` ${item.note}`}`;
    const dw = textWidth(deltaText, TYPE.label) + 4;
    const vw = textWidth(item.value, TYPE.body) + 12;
    c.text(X0, ty, item.text, { max: CONTENT - dw - vw - 16 });
    c.text(X0 + CONTENT - dw - 8, ty, item.value, { anchor: "end", max: vw });
    c.text(X0 + CONTENT, ty, deltaText, { size: TYPE.label, weight: 700, fill: colorOf(item.delta ?? 0, colors), anchor: "end", max: dw });
    y += SPACE.rowY * 2 + TYPE.body + 4;
  });
  return y;
}

export function exchangeOverviewPicture(d: ExchangeOverviewPicture): Out {
  const { canvas: c, top } = page("交易所", "市場總覽", d.as_of);
  const sessions = d.markets.map((m) => `${m.label} ${m.hours} ${m.open ? "開盤中" : "休市"}`).join("・");
  c.text(X0, baseline(top, TYPE.label), sessions, { size: TYPE.label, fill: T.sheetMuted, max: CONTENT });
  let y = top + TYPE.label + 14;
  y = blockTitle(c, y, "新手推薦 · 這裡獨家", "單日漲跌最多 ±10%・不開放槓桿");
  const rowH = SPACE.rowY * 2 + TYPE.body + 4;
  const sparkW = 96;
  d.local.forEach((s, i) => {
    if (i > 0) c.hairline(X0, y - SPACE.rowY, CONTENT);
    const ty = baseline(y, TYPE.body);
    const delta = change(s.change);
    const dw = textWidth(delta, TYPE.label) + 4;
    c.text(X0, ty, `${s.code} ${s.name}`, { max: CONTENT - sparkW - dw - 90 });
    sparkline(c, X0 + CONTENT - dw - 80 - sparkW, y, sparkW, TYPE.body, s.series, d.colors);
    c.text(X0 + CONTENT - dw - 8, ty, `${price(s.price)}`, { anchor: "end", max: 70 });
    c.text(X0 + CONTENT, ty, delta, { size: TYPE.label, weight: 700, fill: colorOf(s.change, d.colors), anchor: "end", max: dw });
    y += rowH;
  });
  y = plainLine(c, y - 4, "價格單位:魚幣一股");
  y += SPACE.stage - 12;
  y = blockTitle(c, y, "大家都在買", "持有人數;不顯示是誰");
  y =
    d.popular.length === 0
      ? plainLine(c, y, "還沒有人持有")
      : moveRows(c, y - SPACE.rowY, d.popular.slice(0, 6).map((p) => ({ text: `${p.code} ${p.name}`, value: `${num(p.holders)} 人`, delta: p.change, note: "" })), d.colors) - 4;
  y += 10;
  y = moveLegend(c, y, d.colors);
  const alt = `市場總覽:${d.local.map((s) => `${s.code} ${price(s.price)}(${change(s.change)})`).join("、")}${d.popular[0] ? `;大家最常持有 ${d.popular[0].code}(${d.popular[0].holders} 人)` : ""}。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeQuotePicture(d: ExchangeQuotePicture): Out {
  const { canvas: c, top } = page("交易所", `${d.code} ${d.name}`, d.as_of);
  const word = limitWord(d.limit);
  let y = head(c, top, `現價(${d.sector}・${d.currency})`, price(d.price), `${change(d.change)}${word === "" ? "" : ` ${word}`}`, colorOf(d.change, d.colors), d.range);
  if (d.coin_line !== null) {
    c.text(X0, baseline(y - 6, TYPE.label), d.coin_line, { size: TYPE.label, fill: T.sheetMuted, max: CONTENT });
    y += TYPE.label + 4;
  }
  y = lineChart(c, y + 6, d.series, 132, d.ref, price, d.colors) + 10;
  y = moveLegend(c, y, d.colors) + 8;
  const hi = d.series.length > 0 ? Math.max(...d.series) : d.price;
  const lo = d.series.length > 0 ? Math.min(...d.series) : d.price;
  y = facts(c, y, [
    { label: "參考價", value: price(d.ref) },
    { label: "漲跌", value: change(d.change) },
    { label: "區間最高", value: price(hi) },
    { label: "區間最低", value: price(lo) },
  ]);
  y += 10;
  y = plainLine(c, y, d.market_line);
  y += 4;
  y = paragraph(c, y, d.blurb, 2, { fill: T.sheetMuted, size: TYPE.label });
  const alt = `${d.code} ${d.name}:${d.currency} ${price(d.price)}(${change(d.change)}${word === "" ? "" : `,${word}`})${d.coin_line === null ? "" : `,${d.coin_line}`},${d.market_line}。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangePortfolioPicture(d: ExchangePortfolioPicture): Out {
  const { canvas: c, top } = page("交易所", `${d.name} 的持股`, d.as_of);
  const held = d.holdings.reduce((t, h) => t + h.value, 0) + d.leveraged.reduce((t, l) => t + Math.max(0, l.equity), 0);
  const cost = d.holdings.reduce((t, h) => t + h.cost, 0) + d.leveraged.reduce((t, l) => t + l.margin, 0);
  const pnl = held - cost;
  const pnlText = cost > 0 ? `${pnl > 0 ? "▲ +" : pnl < 0 ? "▼ −" : ""}${num(Math.abs(pnl))}` : "";
  let y = head(c, top, "總資產(錢包加持股市值)", d.worth === null ? "—" : num(d.worth), pnlText, colorOf(pnl, d.colors), d.balance === null ? null : `錢包 ${num(d.balance)} ${d.currency}`);
  y = facts(c, y, [
    { label: "持股市值", value: num(held), unit: d.currency },
    { label: "成本", value: num(cost), unit: d.currency },
    { label: "損益", value: cost > 0 ? `${pnl >= 0 ? "+" : "−"}${num(Math.abs(pnl))}` : "—", unit: d.currency },
    { label: "槓桿部位", value: num(d.leveraged.length), unit: "個" },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "持股", "市值・損益");
  y =
    d.holdings.length === 0
      ? plainLine(c, y, "沒有持股")
      : moveRows(
          c,
          y - SPACE.rowY,
          d.holdings.map((h) => ({ text: `${h.code}・${h.qty} 股・成本 ${num(h.cost)}`, value: num(h.value), delta: h.cost > 0 ? h.value / h.cost - 1 : 0, note: "" })),
          d.colors,
        ) - 4;
  if (d.leveraged.length > 0) {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, "2 倍部位", "可能賠超過保證金");
    const m = moveColors(d.colors);
    for (const l of d.leveraged) {
      const line = `${l.code}・保證金 ${num(l.margin)}・剩 ${num(Math.max(0, l.equity))}(${Math.max(0, Math.round(l.ratio * 100))}%)`;
      c.text(X0, baseline(y, TYPE.body), line, { max: CONTENT * 0.62 });
      c.text(X0 + CONTENT, baseline(y, TYPE.label), `跌到 ${price(l.line_price)} 自動賣出`, { size: TYPE.label, fill: T.sheetMuted, anchor: "end", max: CONTENT * 0.36 });
      meter(c, X0, y + TYPE.body + 8, CONTENT, Math.max(0, Math.min(1, l.ratio)), l.ratio <= 0.5 ? m.down : m.up);
      y += TYPE.body + 26;
    }
  }
  y += 6;
  y = moveLegend(c, y, d.colors);
  const alt = `${d.name}的持股:總資產 ${d.worth === null ? "—" : num(d.worth)} ${d.currency},持股市值 ${num(held)}、成本 ${num(cost)}、損益 ${pnl >= 0 ? "+" : "−"}${num(Math.abs(pnl))}${d.leveraged.length > 0 ? `;${d.leveraged.length} 個 2 倍部位,${d.leveraged.map((l) => `${l.code} 跌到 ${price(l.line_price)} 自動賣出`).join("、")}` : ""}。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeReceiptPicture(d: ExchangeReceiptPicture): Out {
  const word = d.side === "buy" ? "買進" : "賣出";
  const { canvas: c, top } = page("交易所", `${d.name} 的成交`, d.at);
  let y = head(c, top, `${word}${d.leverage > 1 ? "(2 倍)" : ""}`, `${d.code}`, d.ticker, T.sheetMuted, null);
  y = facts(c, y, [
    { label: "股數", value: d.shares, unit: "股" },
    { label: "成交價", value: d.price },
    { label: d.side === "buy" ? "付出" : "拿到", value: num(d.coins), unit: d.currency },
    { label: "手續費", value: num(d.fee), unit: d.currency },
  ]);
  y += 10;
  y = plainLine(c, y, d.side === "buy" ? "手續費燒掉,不會回到誰手上。" : "賣出的魚幣已經進錢包。");
  const alt = `${d.name}${word} ${d.code} ${d.shares} 股,成交價 ${d.price},${d.side === "buy" ? "付出" : "拿到"} ${num(d.coins)} ${d.currency}(手續費 ${num(d.fee)})。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeBankruptPicture(d: ExchangeBankruptPicture): Out {
  const { canvas: c, top } = page("交易所", `${d.name} 破產了`, d.since);
  let y = head(c, top, "所有持股已經結清", "破產", "", T.sheetMuted, null);
  y = facts(c, y, [
    { label: "交易所吸收", value: num(d.written_off), unit: d.currency },
    { label: "冷靜期到", value: d.until },
  ]);
  y += 10;
  y = paragraph(c, y, "不會欠錢:賠不夠的部分由交易所吸收。冷靜期過後才能再買進。", 3);
  const alt = `${d.name}在交易所破產:所有持股已經結清,冷靜期到 ${d.until},不會欠錢。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeRichPicture(d: ExchangeBoardPicture): Out {
  const title = "富人榜";
  const unit = d.currency;
  const { canvas: c, top } = page("交易所", title, null);
  const total = d.rows.reduce((t, r) => t + r.value, 0);
  let y = facts(c, top, [
    { label: "上榜", value: num(d.rows.length), unit: "人" },
    { label: "合計", value: num(total), unit },
    { label: "第一名", value: d.rows[0] ? num(d.rows[0].value) : "—", unit },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, title, "錢包加持股市值;設定不上榜的人不列");
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
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt: `${title}:${top3 === "" ? "還沒有人上榜" : top3}。` };
}
