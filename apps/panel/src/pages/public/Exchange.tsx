// 深海交易所 on the member page (docs/design/exchange.md), v1: paper trading of real Taiwan and US
// stocks and the five local stocks with fish coins. The market's lists as tabs (新手推薦 · 這裡獨家
// first), a search box with the same suggestions as Discord, sortable columns, the watch list, the
// 熱力圖 tab (the server's holdings and the 熱門 lists as treemaps), a ticker's page (the price, their
// own position and waiting orders right under it, the candle chart: 當日 / 日線 / 週線 / 月線,
// MA5/20/60, volume, their own cost line) with buying and selling one tap away (a bar at the bottom
// and a bottom sheet on a phone, the order panel beside the chart on a wide screen, `exchange/
// TradeForm.tsx`; 2× only where allowed, with the honest warning), their own book (`exchange/
// Mine.tsx`), the bankruptcy status, the rich list with the switch to stay off it (one server's
// members or everyone, `board-scope.tsx`; prices and holdings are global either way), and the
// rules. Every section ends with the exchange's small print. Everything is what
// `/api/member/exchange/*` answers; a refusal is the Core's own sentence. Moves always carry an
// arrow and a sign, never colour alone, and the colours are the member's own choice (紅漲綠跌 or
// 綠漲紅跌, the switch above the table, kept with the person), else the install's default.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { type FormEvent, lazy, type RefObject, Suspense, useId, useMemo, useRef, useState } from "react";
import type { ExchangeAccount, ExchangeLine, ExchangeMarket } from "@miyoria/contracts/api";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { pushable, usePushed } from "@/app/push";
import { ChartEmpty } from "@/components/charts/charts";
import { OffLine } from "@/components/module-query";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtDateTime, fmtInt, fmtPct } from "@/lib/format";
import { notify } from "@/lib/notify";
import { readStorage, writeStorage } from "@/lib/storage";
import { WORLD } from "@/lib/world";
import { BoardScopePicker, useBoardScope } from "./board-scope";
import {
  BOARDS,
  COIN,
  type Colors,
  capText,
  coins,
  conventionWord,
  downColor,
  Fact,
  HER,
  Loaded,
  MARKET,
  Move,
  marketWord,
  nativePrice,
  Part,
  poll,
  priceWord,
  ROOT,
  retry,
  SmallPrint,
  taipeiWhen,
  upColor,
  useAccount,
  useMarket,
  useMedia,
  usePortfolio,
  useRefresh,
  WIDE,
} from "./exchange/common";
import { MineTab } from "./exchange/Mine";
import { Position } from "./exchange/Position";
import { OpenAccount, sideBlocks, type Ticket, TradeForm, TradeHeader } from "./exchange/TradeForm";
import { TradeBar, TradeSheet } from "./exchange/TradeSheet";
import { heldOf, type Side } from "./exchange/trade-math";

export { change, conventionWord, downColor, fillsWhen, SmallPrint, shares, signed, taipeiWhen, upColor } from "./exchange/common";
export { LEVERAGE_LINE, LEVERAGE_RISKS } from "./exchange/TradeForm";

// The candle chart (lightweight-charts) and the heat map (d3-hierarchy) load only when someone
// opens a ticker or the 熱力圖 tab: the page's own bundle does not carry either library.
const CandleChart = lazy(() => import("./exchange/CandleChart"));
const HeatMap = lazy(() => import("./exchange/HeatMap"));

const TAB_KEY = "miyoria.exchange.tab";
const TABS = ["market", "map", "mine", "boards", "rules"] as const;
type Tab = (typeof TABS)[number];
type ListKind = ExchangeMarket["default_list"];

/** One colour as a small square beside its word (never the only carrier: the word says it too). */
function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: color }} />;
}

/** A convention as its option: the two colours, then the words (`紅漲綠跌`) and whose habit it is. */
function ConventionLabel({ c }: { c: Colors }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5">
        <Swatch color={upColor(c)} />
        <Swatch color={downColor(c)} />
      </span>
      {c === "us" ? "綠漲紅跌(國際)" : "紅漲綠跌(台股)"}
    </span>
  );
}

/**
 * Their own colours of up and down (owner 2026-11-22): kept with the person, so every server,
 * device and picture they ask for follows it; until they choose, the install's default.
 */
function ColorChoice({ m }: { m: ExchangeMarket }) {
  const api = useApi();
  const client = useQueryClient();
  const set = useMutation({
    mutationFn: (colors: Colors) => api.rpc.exchange.colors({ body: { colors } }),
    onSuccess: (r) => {
      client.setQueryData<ExchangeMarket>(MARKET, (old) => (old ? { ...old, colors: r.colors, colors_chosen: r.chosen } : old));
      void client.invalidateQueries({ queryKey: MARKET });
    },
    onError: (e) => notify.error(e),
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Segmented
        label="漲跌顏色"
        value={m.colors}
        disabled={set.isPending}
        onChange={(v) => set.mutate(v)}
        options={(["tw", "us"] as const).map((c) => ({ value: c, label: <ConventionLabel c={c} />, title: conventionWord(c) }))}
      />
      <span className="text-xs text-muted-foreground">
        {`漲跌顏色・${m.colors_chosen === null ? "預設" : "你選的"};漲跌也一律標 ▲▼ 和正負號`}
      </span>
    </div>
  );
}

// ---- 市場: lists, search, a ticker -----------------------------------------------------------

type SortKey = "code" | "price" | "coin" | "change";

function ListTable({ rows, colors, onPick, holders }: { rows: (ExchangeLine & { holders: number | null })[]; colors: Colors; onPick: (code: string) => void; holders: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "code", desc: false });
  const sorted = useMemo(() => {
    const v = (r: ExchangeLine) =>
      sort.key === "code" ? r.code : sort.key === "price" ? (r.price ?? -1) : sort.key === "coin" ? (r.coin_price ?? -1) : Math.abs(r.change ?? 0);
    return [...rows].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [rows, sort]);
  const head = (key: SortKey, label: string, className = "") => (
    <th scope="col" className={`py-1 font-normal ${className}`} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="hover:text-foreground" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "code" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  if (rows.length === 0) return <EmptyLine>這個清單還沒有東西</EmptyLine>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          {head("code", "代號")}
          <th scope="col" className="py-1 font-normal">名稱</th>
          {head("price", "價格", "text-right")}
          {head("coin", `${COIN}一股`, "text-right")}
          {head("change", "漲跌", "text-right")}
          {holders && <th scope="col" className="py-1 text-right font-normal">持有人數</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-line-soft">
        {sorted.map((r) => (
          <tr key={r.code} className="hover:bg-hover">
            <td className="py-(--row-y)">
              <button type="button" className="font-mono text-[13px] font-medium underline-offset-2 hover:underline" onClick={() => onPick(r.code)}>
                {r.code}
              </button>
            </td>
            <td className="max-w-40 truncate py-(--row-y)">{r.name}</td>
            <td className="py-(--row-y) text-right tabular-nums">
              {nativePrice(r)}
              {r.basis !== null && r.basis !== "quote" && (
                <span className="block text-[11px] text-muted-foreground" title={r.price_note ?? undefined}>
                  {r.basis === "close" ? `收盤 ${r.price_date ? r.price_date.slice(5).replace("-", "/").replace(/^0/, "") : ""}` : "開盤參考價"}
                </span>
              )}
            </td>
            <td className="py-(--row-y) text-right tabular-nums">{r.currency === "COIN" ? "—" : coins(r.coin_price)}</td>
            <td className="py-(--row-y) text-right">
              <Move value={r.change} colors={colors} />
            </td>
            {holders && <td className="py-(--row-y) text-right tabular-nums">{r.holders ?? 0}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Search({ onPick }: { onPick: (code: string) => void }) {
  const api = useApi();
  const [q, setQ] = useState("");
  const id = useId();
  const typed = q.trim().slice(0, 24);
  const suggest = useQuery({
    queryKey: [...ROOT, "suggest", typed.toUpperCase()],
    queryFn: ({ signal }) => api.rpc.exchange.suggest({ query: { q: typed } }, { signal }),
    enabled: typed.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const lookup = useMutation({
    mutationFn: (code: string) => api.rpc.exchange.lookup({ body: { code } }),
    onSuccess: (r) => {
      setQ("");
      onPick(r.instrument.code);
    },
    onError: (e) => notify.error(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed) lookup.mutate(typed);
  };
  return (
    <form className="grid gap-1" onSubmit={submit} role="search">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        找股票:台股代號(2330、0050)、美股代號(AAPL)或名稱
      </label>
      <div className="flex gap-2">
        <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <Button type="submit" variant="outline" busy={lookup.isPending}>
          查詢
        </Button>
      </div>
      {typed && (suggest.data?.items.length ?? 0) > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="建議">
          {suggest.data?.items.slice(0, 10).map((s) => (
            <li key={s.code}>
              <Button type="button" variant="outline" size="sm" onClick={() => lookup.mutate(s.code)}>
                {`${s.code} ${s.name}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** A ticker opened with a ticket: from 我的's 買 / 賣, or the demo's scenes. */
export interface Opening {
  code: string;
  ticket: Ticket | null;
}

/**
 * Where the ticket is: the order panel beside the chart on a wide screen, else the bar at the
 * bottom of the viewport and the sheet it opens. Whether they may trade at all is read once here.
 */
function TradeArea({ m, line, ticket, onTicket, open, onOpen, onClose, onShowMine, wide, nonce, opener }: {
  m: ExchangeMarket;
  line: ExchangeLine;
  ticket: Ticket;
  onTicket: (t: Ticket) => void;
  open: boolean;
  onOpen: (side: Side) => void;
  onClose: () => void;
  onShowMine: () => void;
  wide: boolean;
  nonce: number;
  opener?: RefObject<HTMLElement | null>;
}) {
  const account = useAccount();
  const portfolio = usePortfolio();
  const held = heldOf(portfolio.data, line.code);
  const blocks = sideBlocks({ m, account: account.data, held, bankrupt: portfolio.data?.bankrupt != null });
  // The panel is always there: it opens on the side that can be used.
  const other: Side = ticket.side === "buy" ? "sell" : "buy";
  const shown: Ticket = wide && blocks[ticket.side] !== null && blocks[other] === null ? { side: other, position: null } : ticket;
  const body = (layout: "sheet" | "panel", focus?: RefObject<HTMLInputElement | null>) => {
    const pad = layout === "sheet" ? "px-4 pb-5" : "";
    if (account.isPending) return <SkeletonRows count={4} className={pad} />;
    if (account.isError)
      return (
        <div className={pad}>
          <ErrorLine error={account.error} onRetry={() => void account.refetch()} />
        </div>
      );
    if (!account.data.opened)
      return (
        <div className={pad}>
          <OpenAccount account={account.data} />
        </div>
      );
    return (
      <TradeForm
        key={`${shown.side}:${shown.position ?? ""}:${nonce}`}
        m={m}
        line={line}
        account={account.data}
        ticket={shown}
        onTicket={onTicket}
        onShowMine={onShowMine}
        inputRef={focus}
        layout={layout}
      />
    );
  };
  if (wide)
    return (
      <aside aria-label="買賣" className="sticky top-4 grid max-h-[calc(100dvh-2rem)] content-start gap-4 overflow-y-auto border-l border-line-soft pl-8">
        <TradeHeader
          line={line}
          colors={m.colors}
          title={
            <h3 className="flex min-w-0 items-baseline gap-2 text-[15px] font-semibold">
              <span className="font-mono text-[14px]">{line.code}</span>
              <span className="truncate">{line.name}</span>
            </h3>
          }
        />
        {body("panel")}
      </aside>
    );
  return (
    <>
      <TradeBar colors={m.colors} blocks={account.data && !account.data.opened ? { buy: null, sell: null } : blocks} onOpen={onOpen} />
      <TradeSheet open={open} onOpenChange={(o) => !o && onClose()} line={line} colors={m.colors} opener={opener}>
        {(focus) => body("sheet", focus)}
      </TradeSheet>
    </>
  );
}

function Ticker({ m, code, ticket: asked, onBack, onShowMine }: { m: ExchangeMarket; code: string; ticket: Ticket | null; onBack: () => void; onShowMine: () => void }) {
  const api = useApi();
  const refresh = useRefresh();
  const wide = useMedia(WIDE);
  // Its price by push while a stream is there (a minute's quotes show within seconds), else polled.
  const key = [...ROOT, "ticker", code] as const;
  const pushed = usePushed("exchange_ticker", code, key, pushable(code));
  const ticker = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.rpc.exchange.ticker({ params: { code } }, { signal }),
    refetchInterval: pushed ? false : poll,
    retry,
  });
  const portfolio = usePortfolio();
  const held = heldOf(portfolio.data, code);
  const [ticket, setTicket] = useState<Ticket>(asked ?? { side: "buy", position: null });
  const [open, setOpen] = useState(asked !== null);
  const [nonce, setNonce] = useState(0);
  // Where focus goes back to when the sheet closes: what opened it.
  const opener = useRef<HTMLElement | null>(null);
  const start = (side: Side, position: string | null = null) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTicket({ side, position });
    setNonce((x) => x + 1);
    setOpen(true);
  };
  const watch = useMutation({
    mutationFn: (on: boolean) => api.rpc.exchange.watch({ body: { code, on } }),
    onSuccess: (r) => {
      notify.ok(r.watching ? "加入觀察了" : "取消觀察了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  return (
    <Loaded query={ticker} rows={5}>
      {(t) => (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start lg:gap-0">
          <div className="grid min-w-0 gap-6 lg:pr-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" className="-ml-2 pointer-coarse:h-11" onClick={onBack}>
                <ChevronLeft />
                回清單
              </Button>
              <Button variant="outline" size="sm" className="pointer-coarse:h-11" busy={watch.isPending} onClick={() => watch.mutate(!t.watching)}>
                {t.watching ? "取消觀察" : "加入觀察"}
              </Button>
            </div>
            <div className="grid gap-3">
              <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[15px] font-semibold">
                <span className="font-mono text-[14px]">{t.line.code}</span>
                <span className="min-w-0 truncate">{t.line.name}</span>
              </h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
                <Fact label={priceWord(t.line)} wrap>
                  {nativePrice(t.line)}
                </Fact>
                <Fact label="漲跌">
                  <Move value={t.line.change} colors={m.colors} />
                </Fact>
                {t.line.currency !== "COIN" && <Fact label={`約${COIN}一股`}>{coins(t.line.coin_price)}</Fact>}
                <Fact label="市場" wrap>
                  {marketWord(t.line)}
                </Fact>
                <Fact className="col-span-2" label={t.line.basis === "close" ? "收盤時間" : "報價時間"}>
                  {t.line.basis === "reference" ? "還沒有第一筆價格" : t.line.at ? `${fmtDateTime(t.line.at)}${t.line.age_minutes !== null ? `(約 ${t.line.age_minutes} 分鐘前)` : ""}` : "還沒有報價"}
                </Fact>
              </dl>
            </div>
            <Position m={m} held={held} onSell={(position) => (wide ? setTicket({ side: "sell", position }) : start("sell", position))} />
            <Suspense fallback={<ChartEmpty height={288}>載入 K 線…</ChartEmpty>}>
              <CandleChart code={t.line.code} title={`${t.line.code} ${t.line.name}`} colors={m.colors} open={t.line.open} move={<Move value={t.line.change} colors={m.colors} />} />
            </Suspense>
            {t.line.stale && <p className="text-[13px] text-muted-foreground">報價太舊,暫停成交;持股不會因為沒有報價被賣出。</p>}
            {t.line.basis !== null && t.line.basis !== "quote" && (
              <p className="text-[13px] text-muted-foreground">
                {`${t.line.price_note ?? ""}:這是最後知道的價格,只用來顯示和估算持股市值;下單會在${t.line.next_open ? `下一個開盤 ${taipeiWhen(t.line.next_open)}(台北時間)後` : "下一筆有效報價"}成交。`}
              </p>
            )}
            <p className="text-[13px] text-muted-foreground">{t.line.local ? t.line.local.what_moves : t.line.source}</p>
            {t.line.local?.today && <p className="text-[13px] tabular-nums">{t.line.local.today}</p>}
            <SmallPrint m={m} real={t.line.local === null} />
            {!wide && (
              <TradeArea
                m={m}
                line={t.line}
                ticket={ticket}
                onTicket={(x) => {
                  setTicket(x);
                  setNonce((v) => v + 1);
                }}
                open={open}
                onOpen={(side) => start(side)}
                onClose={() => setOpen(false)}
                onShowMine={() => {
                  setOpen(false);
                  onShowMine();
                }}
                wide={false}
                nonce={nonce}
                opener={opener}
              />
            )}
          </div>
          {wide && (
            <TradeArea
              m={m}
              line={t.line}
              ticket={ticket}
              onTicket={(x) => {
                setTicket(x);
                setNonce((v) => v + 1);
              }}
              open={false}
              onOpen={(side) => setTicket({ side, position: null })}
              onClose={() => {}}
              onShowMine={onShowMine}
              wide
              nonce={nonce}
            />
          )}
        </div>
      )}
    </Loaded>
  );
}

function MarketTab({ m, opening, open, onShowMine }: { m: ExchangeMarket; opening: (Opening & { n: number }) | null; open: (code: string | null) => void; onShowMine: () => void }) {
  const code = opening?.code ?? null;
  const api = useApi();
  const [list, setList] = useState<ListKind>(m.default_list);
  const key = [...ROOT, "list", list] as const;
  const pushed = usePushed("exchange_list", list, key, code === null);
  const rows = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.rpc.exchange.list({ params: { kind: list } }, { signal }),
    refetchInterval: pushed ? false : poll,
    retry,
  });
  if (opening !== null) return <Ticker key={`${opening.code}:${opening.n}`} m={m} code={opening.code} ticket={opening.ticket} onBack={() => open(null)} onShowMine={onShowMine} />;
  return (
    <div className="grid gap-6">
      {list === "local" && m.default_list === "local" && (
        <div className="grid gap-1 text-[13px]">
          <p className="font-medium">{`第一次來?這裡用${COIN}買賣股票,只是遊戲:`}</p>
          <p className="text-muted-foreground">{`・新手推薦的五檔是這裡獨家,一股約 100 ${COIN}、單日漲跌最多 ±10%、不開放槓桿`}</p>
          <p className="text-muted-foreground">・台股和美股照真實報價,可以買零股;每筆收 {fmtPct(m.rules.fee, 1)} 手續費,燒掉</p>
        </div>
      )}
      <Search onPick={(c) => open(c)} />
      <Tabs value={list} onValueChange={(v) => setList(v as ListKind)} className="gap-3">
        <TabsList variant="inline" aria-label="清單">
          {m.lists.map((l) => (
            <TabsTrigger key={l.kind} value={l.kind}>
              {l.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <ColorChoice m={m} />
      <Loaded query={rows} rows={5}>
        {(l) => <ListTable rows={l.rows} colors={m.colors} onPick={(c) => open(c)} holders={l.kind === "popular"} />}
      </Loaded>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        {m.sessions.map((s) => (
          <Fact key={s.market} label={s.market === "tw" ? "台股" : s.market === "us" ? "美股" : s.market}>
            {`${s.hours} ${s.open ? "開盤中" : "休市"}${s.stale ? "・報價停滯" : ""}`}
          </Fact>
        ))}
        <Fact label="固定匯率">{`1 ${COIN} = NT$${m.rates.twd_per_coin}・1 美元 = NT$${m.rates.twd_per_usd}`}</Fact>
      </dl>
      {m.house.buys_halted && <p className="text-[13px] text-muted-foreground">{`今天交易所發出的${COIN}到上限了,今天停止買進(賣出照常)。`}</p>}
      <SmallPrint m={m} real={list !== "local"} />
    </div>
  );
}

// ---- 排行榜 ------------------------------------------------------------------------------------

function Visibility({ account }: { account: ExchangeAccount }) {
  const api = useApi();
  const refresh = useRefresh();
  const boardId = useId();
  const showId = useId();
  const set = useMutation({
    mutationFn: (patch: { hide_boards?: boolean; show_holdings?: boolean }) => api.rpc.exchange.visibility({ body: patch }),
    onSuccess: () => refresh(),
    onError: (e) => notify.error(e),
  });
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Switch id={boardId} checked={!account.hide_boards} disabled={set.isPending} onCheckedChange={(on) => set.mutate({ hide_boards: !on })} />
        <label htmlFor={boardId} className="text-sm">
          我要上榜
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{`預設會上榜。關掉之後你不會出現在富人榜上,${HER}也不會提到你在交易所的事。`}</p>
      <div className="flex items-center gap-2">
        <Switch id={showId} checked={account.show_holdings} disabled={set.isPending} onCheckedChange={(on) => set.mutate({ show_holdings: on })} />
        <label htmlFor={showId} className="text-sm">
          在富人榜上公開我持有哪幾檔
        </label>
      </div>
    </div>
  );
}

function BoardsTab({ m }: { m: ExchangeMarket }) {
  const api = useApi();
  const scope = useBoardScope();
  const boards = useQuery({
    queryKey: [...BOARDS, ...scope.key],
    queryFn: ({ signal }) => api.rpc.exchange.boards({ query: scope.query }, { signal }),
    enabled: !scope.loading,
    refetchInterval: poll,
    retry,
  });
  const account = useAccount();
  return (
    <div className="grid gap-8">
      {account.data?.opened && <Visibility account={account.data} />}
      <BoardScopePicker scope={scope} />
      <Loaded query={boards} rows={5}>
        {(b) => (
          <Part title="富人榜" aside="錢包加持股市值">
            {b.rich.length === 0 ? (
              <EmptyLine>還沒有人上榜</EmptyLine>
            ) : (
              <ol className="divide-y divide-line-soft">
                {b.rich.map((r) => (
                  <li key={r.rank} className={`flex items-baseline gap-3 py-(--row-y) text-sm ${r.me ? "font-medium" : ""}`}>
                    <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{r.rank}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.name}
                      {r.me && <span className="ml-1 text-xs text-primary">你</span>}
                      {r.holdings && <span className="ml-2 font-mono text-xs text-muted-foreground">{r.holdings.map((h) => h.code).join(" ")}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">{`${fmtInt(r.worth)} ${b.currency}`}</span>
                  </li>
                ))}
              </ol>
            )}
            {b.me && <p className="text-[13px] text-muted-foreground">{b.me.hidden ? "你設定了不上榜。" : b.me.rich === null ? "你還沒有名次。" : `你是第 ${b.me.rich} 名。`}</p>}
          </Part>
        )}
      </Loaded>
      <SmallPrint m={m} />
    </div>
  );
}

// ---- 規則 --------------------------------------------------------------------------------------

function RulesTab({ m }: { m: ExchangeMarket }) {
  const r = m.rules;
  return (
    <div className="grid gap-6">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        <Fact label="委託">市價,以下一筆有效報價成交</Fact>
        <Fact label="手續費">{`每筆 ${fmtPct(r.fee, 1)},最少 ${r.fee_min},燒掉`}</Fact>
        <Fact label="買進後">{`${r.min_hold_minutes} 分鐘才能賣`}</Fact>
        <Fact label="一筆">{r.order_max > 0 ? `${r.order_min} 到 ${r.order_max}` : `至少 ${r.order_min}`}</Fact>
        <Fact label="一天">{`${r.orders_per_day} 筆、買 ${capText(r.buy_per_day)}`}</Fact>
        <Fact label="持有上限">{r.limit_total > 0 ? `成本合計 ${fmtInt(r.limit_total)} 起` : "不限"}</Fact>
        <Fact label="開戶">{`認識滿 ${r.account_min_days} 天、${r.account_min_tier}以上`}</Fact>
        <Fact label="2 倍">{r.leverage ? `認識滿 ${r.leverage_min_days} 天、${r.leverage_min_tier}以上;保證金合計 ${capText(r.margin_cap)}` : "沒有開放"}</Fact>
        <Fact label="每天最多淨發出">{r.payout_cap_daily > 0 ? `${fmtInt(r.payout_cap_daily)},到了當天停止買進` : "不限"}</Fact>
        <Fact label="破產冷靜期">{`${r.bankrupt_cooling_days} 天`}</Fact>
        <Fact label="報價最舊">{`${Math.round(r.quote_max_age_seconds / 60)} 分鐘`}</Fact>
        <Fact label="觀察清單">{`最多 ${r.watch_max} 檔`}</Fact>
      </dl>
      <ul className="grid list-disc gap-1 pl-5 text-[13px]">
        <li>{m.no_dividends}</li>
        <li>{m.no_exchange}</li>
        <li>{`交易所是對手方:買進的${COIN}燒掉,賣出時重新發出;價格照真實報價,固定匯率換成${COIN}。`}</li>
        <li>報價太舊或看起來不對,就不成交也不自動賣出。</li>
      </ul>
      <SmallPrint m={m} leverage={r.leverage} />
    </div>
  );
}

// ---- the block ---------------------------------------------------------------------------------

/**
 * 深海交易所: the market and its lists, the heat maps, their own book, the rich list, the rules.
 * `initialCode` opens a ticker at once, `initialTicket` with its ticket open, `initialTab` on
 * another tab (the dev-only demo uses them).
 */
export function Exchange({ initialCode = null, initialTicket = null, initialTab }: { initialCode?: string | null; initialTicket?: Ticket | null; initialTab?: Tab } = {}) {
  const market = useMarket();
  const stored = readStorage(TAB_KEY);
  const [tab, setTab] = useState<Tab>(initialTab ?? (initialCode !== null ? "market" : TABS.includes(stored as Tab) ? (stored as Tab) : "market"));
  const [opening, setOpening] = useState<(Opening & { n: number }) | null>(initialCode === null ? null : { code: initialCode, ticket: initialTicket, n: 0 });
  const pick = (v: string) => {
    if (!TABS.includes(v as Tab)) return;
    setTab(v as Tab);
    writeStorage(TAB_KEY, v);
  };
  /** A ticker on the market tab, with its ticket open when one is given. */
  const open = (code: string | null, ticket: Ticket | null = null) => {
    setOpening((o) => (code === null ? null : { code, ticket, n: (o?.n ?? 0) + 1 }));
    if (code !== null) pick("market");
  };
  if (market.isError && isNotProvided(market.error)) return null;
  const off = market.isError && isApiError(market.error) && market.error.kind === "unavailable";
  return (
    <Card aria-label={WORLD.exchange_name}>
      <CardHeader>
        <CardTitle>{WORLD.exchange_name}</CardTitle>
      </CardHeader>
      {off ? (
        <OffLine title="交易所現在沒有開" onRetry={() => void market.refetch()} />
      ) : market.isError ? (
        <ErrorLine error={market.error} onRetry={() => void market.refetch()} />
      ) : market.isPending ? (
        <SkeletonRows count={6} />
      ) : (
        <Tabs value={tab} onValueChange={pick} className="gap-4">
          <TabsList variant="inline" aria-label={WORLD.exchange_name}>
            <TabsTrigger value="market">市場</TabsTrigger>
            <TabsTrigger value="map">熱力圖</TabsTrigger>
            <TabsTrigger value="mine">我的</TabsTrigger>
            <TabsTrigger value="boards">富人榜</TabsTrigger>
            <TabsTrigger value="rules">規則</TabsTrigger>
          </TabsList>
          {!market.data.enabled && <p className="text-[13px] text-muted-foreground">交易所還沒開放,下面是規則和目前的價格。</p>}
          <TabsContent value="market">
            <MarketTab m={market.data} opening={opening} open={open} onShowMine={() => pick("mine")} />
          </TabsContent>
          <TabsContent value="map">
            {/* Mounted only while this tab is open: its map is polled only then. */}
            {tab === "map" && (
              <Suspense fallback={<SkeletonRows count={6} />}>
                <HeatMap m={market.data} onPick={(c) => open(c)} footer={<SmallPrint m={market.data} />} />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="mine">
            <MineTab m={market.data} onOpen={(c) => open(c)} onTrade={(c, side, position) => open(c, { side, position })} />
          </TabsContent>
          <TabsContent value="boards">
            <BoardsTab m={market.data} />
          </TabsContent>
          <TabsContent value="rules">
            <RulesTab m={market.data} />
          </TabsContent>
        </Tabs>
      )}
    </Card>
  );
}
