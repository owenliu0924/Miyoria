// The exchange's picture messages (owner 2026-11-21: more commands that answer with a picture):
// a company's quote with its line, a member's own portfolio (only ever drawn for them), the day's
// market, the rich list and the week's volume table, as templates of `PicturesKey`. A picture goes
// above the text card with its one-line summary as the alt text; the text card is all there is
// when the renderer is absent, slow or answers `null`. Drawing never decides anything.

import { type CommandReply, pictureParts } from "@miyoria/commands";
import type {
  ExchangeBoardPicture,
  ExchangeDayPicture,
  ExchangePortfolioPicture,
  ExchangeQuotePicture,
  PictureDataMap,
  PictureFile,
  PictureKind,
  Pictures,
} from "@miyoria/types";
import { qtyText, roundSlot, SECTOR_LABEL, type Sector } from "./engine/index.js";
import type { BoardsView, CompanyView, ExchangeService, PortfolioView } from "./service.js";

/** Longest wait for a picture before the answer goes out with its text alone. */
export const PICTURE_TIMEOUT_MS = 8_000;

function asOf(service: ExchangeService): string {
  const last = service.store.rounds({ limit: 1, held: true })[0];
  if (!last) return "還沒有開盤";
  const hour = service.params.first_hour + roundSlot(last.round, service.params);
  return `${dateOfDay(last.day)} ${String(hour).padStart(2, "0")}:00`;
}

function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function quotePictureData(
  service: ExchangeService,
  view: CompanyView,
): ExchangeQuotePicture {
  const c = view.company;
  const first = view.history[0];
  const last = view.history.at(-1);
  const offset = service.config.utc_offset_minutes;
  const range =
    first && last ? `${shortDate(first.at, offset)} – ${shortDate(last.at, offset)}` : null;
  return {
    code: c.code,
    name: c.name,
    sector: SECTOR_LABEL[c.sector as Sector] ?? c.sector,
    blurb: c.blurb,
    currency: service.currency,
    price: c.price,
    ref: c.ref,
    change: c.change,
    limit: c.limit,
    series: view.history.map((h) => h.price),
    range,
    news: view.news.slice(0, 3).map((n) => ({ headline: n.headline, direction: n.direction })),
    as_of: asOf(service),
  };
}

export function portfolioPictureData(
  service: ExchangeService,
  name: string,
  p: PortfolioView,
): ExchangePortfolioPicture {
  return {
    name,
    currency: service.currency,
    balance: p.account.balance,
    worth: p.totals.worth === null ? null : Math.floor(p.totals.worth),
    holdings: p.holdings.map((h) => ({
      code: h.code,
      qty: qtyText(h.qty),
      cost: h.cost,
      value: Math.floor(h.value),
    })),
    leveraged: p.leveraged.map((l) => ({
      code: l.code,
      margin: l.margin,
      equity: Math.floor(l.equity),
      ratio: l.ratio,
      price: l.price,
      line_price: l.line_price,
    })),
    as_of: asOf(service),
  };
}

export function dayPictureData(service: ExchangeService, her: string | null): ExchangeDayPicture {
  const s = service.summary();
  const m = service.market();
  const rounds = service.store.rounds({ from: s.day * service.params.rounds_per_day, held: true });
  return {
    date: s.date,
    currency: service.currency,
    fish: s.fish,
    fish_ref: s.fish_ref,
    level: s.level,
    vault: m.vault,
    volume: s.volume,
    burned: s.burned,
    halted: s.halted,
    companies: s.companies,
    series: rounds.map((r) => r.fish),
    her,
  };
}

export function boardPictureData(kind: "rich" | "volume", b: BoardsView): ExchangeBoardPicture {
  const rows =
    kind === "rich"
      ? b.rich.map((r) => ({
          rank: r.rank,
          name: r.name,
          value: r.worth,
          extra: r.holdings === null ? null : r.holdings.map((h) => h.code).join(" "),
        }))
      : b.volume.map((r) => ({
          rank: r.rank,
          name: r.name,
          value: r.volume,
          extra: `${r.trades} 筆`,
        }));
  const me =
    b.me === null ? null : { rank: kind === "rich" ? b.me.rich : b.me.volume, hidden: b.me.hidden };
  return { currency: b.currency, week_start: kind === "volume" ? b.week_start : null, rows, me };
}

function shortDate(iso: string, offsetMinutes: number): string {
  const d = new Date(Date.parse(iso) + offsetMinutes * 60_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
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
