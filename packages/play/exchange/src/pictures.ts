// The exchange's picture messages (v1): a ticker's quote with its line, a member's own holdings
// (only ever drawn for them), and the rich list, as templates of `PicturesKey`. Each carries the
// exchange's small print at the bottom. A picture goes above the text card with its one-line
// summary as the alt text; the text card is all there is when the renderer is absent, slow or
// answers `null`. Drawing never decides anything.

import { type CommandReply, pictureParts } from "@miyoria/commands";
import {
  type ExchangeBoardPicture,
  type ExchangePortfolioPicture,
  type ExchangeQuotePicture,
  exchangeSmallPrint,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
} from "@miyoria/types";
import type { RealLine, RealPortfolio } from "./real/desk.js";
import { QTY_REAL } from "./real/house.js";
import type { BoardsView, ExchangeService } from "./service.js";

/** Longest wait for a picture before the answer goes out with its text alone. */
export const PICTURE_TIMEOUT_MS = 8_000;

const MARKET_WORD: Readonly<Record<string, string>> = {
  tw: "台股",
  us: "美股",
  local: "這裡獨家",
  crypto: "加密",
};

/** Cents of a price, as the templates draw them (two decimals). */
const cents = (x: number) => Math.round(x * 100);

function shortDate(iso: string, offsetMinutes: number): string {
  const d = new Date(Date.parse(iso) + offsetMinutes * 60_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function quoteTime(iso: string | null, offsetMinutes: number): string {
  if (iso === null) return "還沒有報價";
  const d = new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} 的報價`;
}

/** A share count as drawn: whole shares plainly, a fraction to four places. */
export function sharesText(qty: number): string {
  const shares = qty / QTY_REAL;
  return Number.isInteger(shares) ? String(shares) : shares.toFixed(4);
}

export function quotePictureData(
  service: ExchangeService,
  h: { line: RealLine; points: { at: string; price: number }[] },
): ExchangeQuotePicture {
  const l = h.line;
  const offset = service.config.utc_offset_minutes;
  const first = h.points[0];
  const last = h.points.at(-1);
  const price = l.price ?? last?.price ?? 0;
  const ref = l.change === null ? price : price / (1 + l.change);
  const local = l.local !== null;
  const coin = l.currency === "COIN";
  return {
    code: l.code,
    name: l.name,
    sector: MARKET_WORD[l.market] ?? l.market,
    blurb: local ? (l.local?.what_moves ?? "") : `約 ${l.coin_price ?? "—"} 魚幣一股・${l.source}`,
    currency: coin ? "魚幣" : l.currency,
    price: cents(price),
    ref: cents(ref),
    change: l.change ?? 0,
    limit: null,
    series: h.points.map((p) => cents(p.price)),
    range: first && last ? `${shortDate(first.at, offset)} – ${shortDate(last.at, offset)}` : null,
    news: [],
    as_of: quoteTime(l.at, offset),
    small_print: exchangeSmallPrint({ real: !local }),
  };
}

export function portfolioPictureData(
  service: ExchangeService,
  name: string,
  p: RealPortfolio,
  balance: number | null,
): ExchangePortfolioPicture {
  const leverage = p.holdings.some((h) => h.leverage > 1);
  return {
    name,
    currency: service.currency,
    balance,
    worth: balance === null ? null : Math.floor(balance + p.totals.value),
    holdings: p.holdings
      .filter((h) => h.leverage <= 1)
      .map((h) => ({
        code: h.code,
        qty: sharesText(h.qty),
        cost: h.cost,
        value: Math.floor(h.value ?? 0),
      })),
    leveraged: p.holdings
      .filter((h) => h.leverage > 1)
      .map((h) => ({
        code: h.code,
        margin: h.margin,
        equity: Math.floor(h.equity ?? 0),
        ratio: h.ratio ?? 0,
        price: cents(h.price ?? 0),
        line_price: cents(h.line_price ?? 0),
      })),
    as_of: p.bankrupt ? "破產冷靜期中" : "以最新報價計算",
    small_print: exchangeSmallPrint({ real: true, leverage }),
  };
}

export function boardPictureData(b: BoardsView): ExchangeBoardPicture {
  return {
    currency: b.currency,
    week_start: null,
    rows: b.rich.map((r) => ({
      rank: r.rank,
      name: r.name,
      value: r.worth,
      extra: r.holdings === null ? null : r.holdings.map((h) => h.code).join(" "),
    })),
    me: b.me === null ? null : { rank: b.me.rich, hidden: b.me.hidden },
    small_print: exchangeSmallPrint({ real: true }),
  };
}

/** Draws `kind`, or `null`: no renderer, a failure, or too slow. Never throws. */
export async function drawPicture<K extends PictureKind>(
  pictures: Pictures | null | undefined,
  kind: K,
  data: PictureDataMap[K],
  timeoutMs: number = PICTURE_TIMEOUT_MS,
): Promise<PictureFile | null> {
  if (!pictures) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([pictures.render(kind, data).catch(() => null), late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `reply` with the picture of `kind` above its card, when one can be drawn. */
export async function withPicture<K extends PictureKind>(
  pictures: Pictures | null | undefined,
  kind: K,
  data: PictureDataMap[K],
  reply: CommandReply,
): Promise<CommandReply> {
  const file = await drawPicture(pictures, kind, data);
  if (file === null || reply.card === undefined) return reply;
  const parts = pictureParts(file);
  return {
    ...reply,
    card: { ...reply.card, blocks: [...parts.blocks, ...reply.card.blocks] },
    files: [...(reply.files ?? []), ...parts.files],
  };
}
