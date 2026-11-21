// 熱力圖 on the member page (owner 2026-11-21, after finviz's market map), loaded only when someone
// opens the tab: one tile a ticker, its area its weight, its colour today's change on a diverging
// scale in the product's up/down convention, grouped by sector with the sector's name on top. Each
// tile that has room writes its code and its change with an arrow and a sign; every tile names
// itself, its price, its change and what its size means to a screen reader and in the tooltip on
// hover or focus. A tile opens its ticker on click or Enter. Two maps: 伺服器持股圖 (what the
// server holds, never who; a ticker held by too few people is merged into 其他) and 熱門股票圖 with
// a switch between 台股 and 美股 (preset weights, not live market caps). The layout is the one the
// Discord picture uses (`@miyoria/card-face/market`). While the tab is open its map is asked for
// every minute, which keeps its tickers' quotes coming in the exchange's usual batches.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ExchangeMap, ExchangeMarket } from "@miyoria/contracts/api";
import { changeText, layoutMap, moveColors, tileColor, tileRoom } from "@miyoria/card-face/market";
import { isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ChartEmpty } from "@/components/charts/charts";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Segmented } from "@/components/ui/segmented";
import { readStorage, writeStorage } from "@/lib/storage";

type MapKind = ExchangeMap["kind"];
type Tile = ExchangeMap["tiles"][number];

const KIND_KEY = "miyoria.exchange.map";
const KINDS: { value: MapKind; label: string }[] = [
  { value: "holdings", label: "伺服器持股圖" },
  { value: "tw", label: "熱門台股" },
  { value: "us", label: "熱門美股" },
];
const OTHER = "其他";

/** A Taiwan code without its board: tiles have little room. */
export const shortCode = (code: string) => code.replace(/\.TWO?$/, "");

const priceOf = (t: Tile) =>
  t.price === null ? "—" : t.currency === "COIN" ? `${t.price.toFixed(2)} 魚幣` : `${t.currency} ${t.price.toFixed(2)}`;

/** What a tile says to a screen reader and in its tooltip. */
export function tileLabel(t: Tile): string {
  if (t.code === OTHER) return `${t.name}:${t.basis}`;
  return `${t.name}(${t.code}),${priceOf(t)},今天 ${changeText(t.change)},${t.basis}`;
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Board({ map, colors, onPick }: { map: ExchangeMap; colors: ExchangeMarket["colors"]; onPick: (code: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const measured = useWidth(box);
  // jsdom has no layout: a fixed width keeps the tiles testable there.
  const width = measured > 0 ? measured : 640;
  const height = Math.round(width < 520 ? width * 1.15 : width * 0.56);
  const layout = layoutMap(map.tiles, width, height, { header: 18, gap: 2 });
  const [hover, setHover] = useState<string | null>(null);
  const hovered = layout.tiles.find((t) => t.tile.code === hover) ?? null;
  return (
    <div ref={box} className="relative w-full" style={{ height }} role="group" aria-label={map.title}>
      {layout.sectors.map((s) => (
        <span
          key={s.name}
          aria-hidden
          className="absolute truncate px-0.5 text-[11px] font-semibold text-muted-foreground"
          style={{ left: s.x, top: s.y, width: s.w, lineHeight: "16px" }}
        >
          {s.name}
        </span>
      ))}
      {layout.tiles.map(({ tile, x, y, w, h }) => {
        const room = tileRoom(w, h);
        const big = w >= 120 && h >= 64;
        const label = tileLabel(tile);
        const style = { left: x, top: y, width: w, height: h, background: tileColor(tile.change, colors) };
        const inner = room > 0 && (
          <span className="pointer-events-none grid place-items-center gap-0.5 overflow-hidden px-0.5 text-center leading-tight text-white [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
            <span className={big ? "text-[15px] font-semibold" : "text-[11px] font-semibold"}>{shortCode(tile.code)}</span>
            {room === 2 && <span className={big ? "text-[13px] tabular-nums whitespace-nowrap" : "text-[11px] tabular-nums whitespace-nowrap"}>{changeText(tile.change)}</span>}
          </span>
        );
        const common = {
          "aria-label": label,
          onMouseEnter: () => setHover(tile.code),
          onMouseLeave: () => setHover((c) => (c === tile.code ? null : c)),
          onFocus: () => setHover(tile.code),
          onBlur: () => setHover((c) => (c === tile.code ? null : c)),
          className:
            "absolute grid place-items-center overflow-hidden rounded-[3px] outline-none transition-[filter] hover:brightness-125 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring",
          style,
        };
        return tile.code === OTHER ? (
          // 其他 is several tickers: nothing to open.
          <div key={tile.code} role="note" tabIndex={0} {...common}>
            {inner}
          </div>
        ) : (
          <button key={tile.code} type="button" onClick={() => onPick(tile.code)} {...common}>
            {inner}
          </button>
        );
      })}
      {hovered && (
        <div
          role="tooltip"
          className="glass-float pointer-events-none absolute z-20 grid max-w-64 gap-0.5 rounded-md px-2.5 py-2 text-xs"
          style={{
            left: Math.min(Math.max(0, hovered.x + hovered.w / 2 - 110), Math.max(0, width - 230)),
            top: hovered.y + hovered.h + 4 > height - 70 ? Math.max(0, hovered.y - 76) : hovered.y + Math.min(hovered.h, 40) + 4,
          }}
        >
          <span className="font-medium">{hovered.tile.code === OTHER ? hovered.tile.name : `${hovered.tile.code} ${hovered.tile.name}`}</span>
          {hovered.tile.code !== OTHER && <span className="tabular-nums">{`${priceOf(hovered.tile)}・${changeText(hovered.tile.change)}`}</span>}
          <span className="text-muted-foreground">{hovered.tile.basis}</span>
        </div>
      )}
    </div>
  );
}

/** The 熱力圖 tab: the map switch, the map, the convention, the footnote. */
export default function HeatMap({
  m,
  onPick,
  footer,
}: {
  m: ExchangeMarket;
  onPick: (code: string) => void;
  footer?: React.ReactNode;
}) {
  const api = useApi();
  const stored = readStorage(KIND_KEY);
  const [kind, setKind] = useState<MapKind>(KINDS.some((k) => k.value === stored) ? (stored as MapKind) : "holdings");
  const q = useQuery({
    queryKey: ["member", "exchange", "map", kind],
    queryFn: ({ signal }) => api.rpc.exchange.map({ params: { kind } }, { signal }),
    // Polled only while this tab is open: that is what keeps its tickers counted as viewed.
    refetchInterval: (s) => (s.state.error ? false : 60_000),
    retry: (n, e) => !isNotProvided(e) && n < 1,
  });
  const mv = moveColors(m.colors);
  return (
    <div className="grid gap-4">
      <Segmented
        label="熱力圖"
        value={kind}
        onChange={(v) => {
          setKind(v);
          writeStorage(KIND_KEY, v);
        }}
        options={KINDS}
      />
      {q.isPending ? (
        <SkeletonRows count={6} />
      ) : q.isError ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.tiles.length === 0 ? (
        <ChartEmpty height={200}>{kind === "holdings" ? "還沒有夠多人持有的股票" : "這個清單還沒有報價"}</ChartEmpty>
      ) : (
        <Board map={q.data} colors={m.colors} onPick={onPick} />
      )}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: mv.up }} />▲ 漲
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: mv.down }} />▼ 跌
        </span>
        <span>{`${m.colors === "us" ? "綠漲紅跌(美股習慣)" : "紅漲綠跌(台股習慣)"};顏色是今天的漲跌,±3% 以上最深`}</span>
      </p>
      {q.data && <p className="text-xs text-muted-foreground">{q.data.footnote}</p>}
      {footer}
    </div>
  );
}
