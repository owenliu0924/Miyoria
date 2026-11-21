// 深海交易所 on the member page (docs/design/exchange.md): the market, a company with its line and
// its news, the order ticket with a confirmation in plain numbers, their own holdings (leveraged
// positions with the line where they are sold drawn on the chart), and the boards with the switch
// to stay off them. Everything is what `/api/member/exchange/*` answers; a refusal is the Core's
// own sentence. A Core without the routes leaves the block out; the module stopped is one line.
// Moves always carry their sign (+1.2% / −0.8%) and 漲停 / 跌停 in words, never colour alone.

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type {
  ExchangeAccount,
  ExchangeBoards,
  ExchangeCompany,
  ExchangeLeveraged,
  ExchangeMarket,
  ExchangeNews,
  ExchangeOrderRequest,
  ExchangePortfolio,
  ExchangeQuote,
} from "@miyoria/contracts/api";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ChartBlock, ChartEmpty, TimeChart } from "@/components/charts/charts";
import { ConfirmDialog } from "@/components/confirm";
import { OffLine } from "@/components/module-query";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Meter } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtDateTime, fmtInt, fmtPct } from "@/lib/format";
import { notify } from "@/lib/notify";
import { readStorage, writeStorage } from "@/lib/storage";
import { newKey, WALLET } from "./spend";

const ROOT = ["member", "exchange"] as const;
const MARKET = [...ROOT, "market"] as const;
const ACCOUNT = [...ROOT, "account"] as const;
const PORTFOLIO = [...ROOT, "portfolio"] as const;
const BOARDS = [...ROOT, "boards"] as const;
const POLL_MS = 60_000;
const TAB_KEY = "miyoria.exchange.tab";
const TABS = ["market", "company", "order", "mine", "boards"] as const;
type Tab = (typeof TABS)[number];

const retry = (n: number, e: Error) => !isNotProvided(e) && !(isApiError(e) && e.kind === "unavailable") && n < 2;
const poll = (q: { state: { error: unknown } }) => (q.state.error ? false : POLL_MS);

/** Cents as `123.45`. */
export const price = (cents: number) => (cents / 100).toFixed(2);
/** Thousandths of a share as `1.234`. */
export const shares = (qty: number) => (qty / 1000).toFixed(3);
/** A change with its sign: `+1.2%`, `−0.8%`. */
export function change(x: number): string {
  const v = Math.round(x * 1000) / 10;
  if (v > 0) return `+${v.toFixed(1)}%`;
  if (v < 0) return `−${Math.abs(v).toFixed(1)}%`;
  return "0.0%";
}
const limitWord = (l: "up" | "down" | null) => (l === "up" ? "漲停" : l === "down" ? "跌停" : null);
const moveClass = (x: number) => (x > 0 ? "text-primary" : x < 0 ? "text-[var(--secondary-line)]" : "text-muted-foreground");

function useMarket() {
  const api = useApi();
  return useQuery({ queryKey: MARKET, queryFn: ({ signal }) => api.rpc.exchange.market(undefined, { signal }), refetchInterval: poll, retry });
}
function useAccount() {
  const api = useApi();
  return useQuery({ queryKey: ACCOUNT, queryFn: ({ signal }) => api.rpc.exchange.account(undefined, { signal }), refetchInterval: poll, retry });
}
function usePortfolio() {
  const api = useApi();
  return useQuery({ queryKey: PORTFOLIO, queryFn: ({ signal }) => api.rpc.exchange.portfolio(undefined, { signal }), refetchInterval: poll, retry });
}
function useBoards() {
  const api = useApi();
  return useQuery({ queryKey: BOARDS, queryFn: ({ signal }) => api.rpc.exchange.boards(undefined, { signal }), refetchInterval: poll, retry });
}
function useCompany(code: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...ROOT, "company", code],
    queryFn: ({ signal }) => api.rpc.exchange.company({ params: { code } }, { signal }),
    refetchInterval: poll,
    retry,
  });
}

/** After anything that moves coins or holdings: everything here, and the wallet. */
function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ROOT });
    void client.invalidateQueries({ queryKey: WALLET });
  };
}

function Loaded<T>({ query, rows = 3, children }: { query: UseQueryResult<T>; rows?: number; children: (data: T) => ReactNode }) {
  if (query.isPending) return <SkeletonRows count={rows} />;
  if (query.isError) return <ErrorLine error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function Move({ value, limit }: { value: number; limit?: "up" | "down" | null }) {
  const word = limit === undefined ? null : limitWord(limit);
  return (
    <span className={`tabular-nums font-medium ${moveClass(value)}`}>
      {change(value)}
      {word && <span className="ml-1 text-xs">{word}</span>}
    </span>
  );
}

function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 content-start gap-2">
      <h3 className="flex items-baseline justify-between gap-3 text-[13px] font-medium">
        {title}
        {aside && <span className="text-xs font-normal text-muted-foreground">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

// ---- 行情 --------------------------------------------------------------------------------------

function NewsList({ news, max = 8 }: { news: ExchangeNews[]; max?: number }) {
  if (news.length === 0) return <EmptyLine>最近沒有消息</EmptyLine>;
  return (
    <ul className="divide-y divide-line-soft">
      {news.slice(0, max).map((n) => (
        <li key={n.id} className="grid gap-0.5 py-(--row-y)">
          <p className="flex items-baseline gap-2 text-sm">
            <span className={`shrink-0 text-xs font-medium ${n.direction === "up" ? "text-primary" : "text-[var(--secondary-line)]"}`}>
              {n.direction === "up" ? "利多" : "利空"}
            </span>
            <span className="min-w-0 flex-1 font-medium">{n.headline}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{fmtDateTime(n.at)}</span>
          </p>
          <p className="text-[13px] text-muted-foreground">{n.body}</p>
        </li>
      ))}
    </ul>
  );
}

function Companies({ companies, onPick }: { companies: ExchangeCompany[]; onPick: (code: string) => void }) {
  return (
    <ul className="divide-y divide-line-soft">
      {companies.map((c) => (
        <li key={c.code}>
          <button type="button" onClick={() => onPick(c.code)} className="flex w-full items-baseline gap-3 py-(--row-y) text-left hover:bg-hover">
            <span className="w-12 shrink-0 font-mono text-[13px] font-medium">{c.code}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
            <span className="shrink-0 text-sm tabular-nums">{price(c.price)}</span>
            <span className="w-24 shrink-0 text-right text-[13px]">
              <Move value={c.change} limit={c.limit} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RulesFacts({ m }: { m: ExchangeMarket }) {
  const r = m.rules;
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
      <Fact label="開盤">{`${r.first_hour}:00–${r.first_hour + r.rounds_per_day - 1}:00 每小時一盤`}</Fact>
      <Fact label="單日漲跌">±{fmtPct(r.daily_limit)}</Fact>
      <Fact label="每盤最多動">±{fmtPct(r.round_limit)}</Fact>
      <Fact label="熔斷">大盤 −{fmtPct(r.breaker)}</Fact>
      <Fact label="手續費">{`買賣各 ${fmtPct(r.fee_buy, 1)}`}</Fact>
      <Fact label="交易稅">{`賣出 ${fmtPct(r.tax_sell)}`}</Fact>
      <Fact label="一筆">{`${r.order_min} 到 ${r.order_max}`}</Fact>
      <Fact label="一天">{`${r.orders_per_day} 筆、買 ${r.buy_per_day}`}</Fact>
      <Fact label="持有上限">{`每家 ${r.limit_company}、合計 ${r.limit_total} 起`}</Fact>
      <Fact label="開戶">{`認識滿 ${r.account_min_days} 天、${r.account_min_tier}以上`}</Fact>
      <Fact label="槓桿">{r.leverage.enabled ? `最多 ${r.leverage.max} 倍` : "沒有開放"}</Fact>
      <Fact label="燒掉">手續費、稅、利息全部燒掉</Fact>
    </dl>
  );
}

function MarketTab({ m, onPick }: { m: ExchangeMarket; onPick: (code: string) => void }) {
  const delta = m.fish_ref > 0 ? m.fish / m.fish_ref - 1 : 0;
  const status = !m.enabled ? "還沒開放" : m.paused ? "暫停中" : m.halted ? "今天熔斷,不再撮合" : "開盤中";
  return (
    <div className="grid gap-8">
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <Fact label="魚市指數 FISH">
          {m.fish.toFixed(0)} <Move value={delta} />
        </Fact>
        <Fact label="狀態">{status}</Fact>
        <Fact label="下一盤">{m.next_round_at ? fmtDateTime(m.next_round_at) : "—"}</Fact>
        <Fact label="金庫">{`${fmtInt(m.vault)} ${m.currency}`}</Fact>
        <Fact label="水位(金庫 ÷ 持股市值)">{m.level === null ? "—" : m.level.toFixed(2)}</Fact>
        <Fact label="本週燒掉">{`${fmtInt(m.burned_week)} ${m.currency}`}</Fact>
      </dl>
      {m.her && <blockquote className="max-w-prose border-l-2 border-primary/60 pl-3 text-sm">{m.her.text}</blockquote>}
      <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-x-(--stage-gap)">
        <Part title="八家公司" aside="漲跌對昨天收盤">
          <Companies companies={m.companies} onPick={onPick} />
        </Part>
        <Part title="新聞" aside="種類和大小由程式抽,她只寫字">
          <NewsList news={m.news} />
        </Part>
      </div>
      {m.rating && (
        <Part title="她這週的評等" aside="是她的意見,她也會錯">
          <ul className="divide-y divide-line-soft">
            {m.rating.items.map((r) => (
              <li key={r.code} className="flex items-baseline gap-3 py-(--row-y) text-sm">
                <span className="w-12 shrink-0 font-mono text-[13px]">{r.code}</span>
                <span className="w-12 shrink-0 font-medium">{r.rating}</span>
                <span className="min-w-0 flex-1 text-muted-foreground">{r.reason}</span>
              </li>
            ))}
          </ul>
        </Part>
      )}
      <Part title="規則">
        <RulesFacts m={m} />
      </Part>
    </div>
  );
}

// ---- 個股 --------------------------------------------------------------------------------------

/** A price line; with `line`, the price at which a leveraged position is sold, drawn across. */
function PriceChart({ history, line, title, aside }: { history: { at: string; price: number }[]; line?: number | null; title: string; aside?: ReactNode }) {
  const times = history.map((h) => Date.parse(h.at));
  const series = [{ key: "p", label: "價格", color: "var(--chart-1)", values: history.map((h) => h.price / 100) }];
  if (line !== undefined && line !== null) series.push({ key: "l", label: "自動賣出價", color: "var(--chart-2)", values: history.map(() => line / 100) });
  const last = history.at(-1);
  return (
    <ChartBlock title={title} value={last ? price(last.price) : "—"} aside={aside}>
      {history.length < 2 ? (
        <ChartEmpty height={168}>還沒有走勢</ChartEmpty>
      ) : (
        <TimeChart times={times} series={series} label={`${title}(價格)`} height={168} format={(v) => v.toFixed(2)} area />
      )}
    </ChartBlock>
  );
}

function CompanyTab({ code, setCode, companies }: { code: string; setCode: (c: string) => void; companies: ExchangeCompany[] }) {
  const page = useCompany(code);
  return (
    <div className="grid gap-6">
      <Segmented label="哪一家" value={code} onChange={setCode} options={companies.map((c) => ({ value: c.code, label: c.code }))} />
      <Loaded query={page} rows={5}>
        {(p) => (
          <div className="grid gap-8">
            <PriceChart history={p.history} title={`${p.company.code} ${p.company.name}`} aside={<Move value={p.company.change} limit={p.company.limit} />} />
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Fact label="類股">{p.company.sector}</Fact>
              <Fact label="參考價(昨天收盤)">{price(p.company.ref)}</Fact>
              <Fact label="漲跌">
                <Move value={p.company.change} limit={p.company.limit} />
              </Fact>
              {p.mine && <Fact label="你的持股">{`${shares(p.mine.qty)} 股・市值 ${fmtInt(Math.floor(p.mine.value))}`}</Fact>}
            </dl>
            <p className="max-w-prose text-[13px] text-muted-foreground">{p.company.blurb}</p>
            <Part title="新聞">
              <NewsList news={p.news} max={12} />
            </Part>
          </div>
        )}
      </Loaded>
    </div>
  );
}

// ---- 下單 --------------------------------------------------------------------------------------

function OpenAccount({ account }: { account: ExchangeAccount }) {
  const api = useApi();
  const refresh = useRefresh();
  const open = useMutation({
    mutationFn: () => api.rpc.exchange.open(),
    onSuccess: () => {
      notify.ok("開好戶了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  return (
    <div className="grid gap-2">
      <p className="text-sm">還沒開戶。開戶不花錢;開了之後才能買賣。</p>
      {account.cannot_open ? (
        <p role="alert" className="text-[13px] text-primary">
          {account.cannot_open}
        </p>
      ) : (
        <Button className="justify-self-start" busy={open.isPending} onClick={() => open.mutate()}>
          開戶
        </Button>
      )}
    </div>
  );
}

const LEVERAGE_RISKS = [
  "槓桿 2 倍:放進去的保證金 M,可以買到 2M 的部位;漲跌都是兩倍。",
  "每個槓桿部位分開算。最多賠掉那個部位的保證金,不會動到你錢包裡其他的魚幣和持股,也不會欠錢。",
  "保證金剩一半時通知你一次,接近自動賣出時再通知一次;跌到自動賣出的價格,那一盤會依規則自動賣出,剩下的退給你(扣掉手續費和稅)。",
  "借的那一半每個交易日收一點利息,從保證金扣,燒掉。",
  "這是市場的規則,不是她做的決定;她不會評論任何人的部位。",
];

function LeverageOptIn({ account }: { account: ExchangeAccount }) {
  const api = useApi();
  const refresh = useRefresh();
  const [asking, setAsking] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const id = useId();
  const opt = useMutation({
    mutationFn: () => api.rpc.exchange.leverage({ body: { accept: true } }),
    onSuccess: () => {
      setAsking(false);
      notify.ok("可以用槓桿了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  if (account.leverage.opted_in) return null;
  if (!account.leverage.allowed) return account.leverage.why ? <p className="text-xs text-muted-foreground">槓桿:{account.leverage.why}</p> : null;
  return (
    <>
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAsking(true)}>
        開啟槓桿
      </Button>
      <ConfirmDialog open={asking} title="開啟槓桿之前" confirmLabel="我了解,開啟" busy={opt.isPending} confirmDisabled={!agreed} onConfirm={() => opt.mutate()} onClose={() => setAsking(false)}>
        <div className="grid gap-2">
          <ul className="grid list-disc gap-1 pl-5">
            {LEVERAGE_RISKS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Checkbox id={id} checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
            <label htmlFor={id}>我看過了,知道最多會賠掉保證金</label>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

function QuoteBody({ q, currency }: { q: ExchangeQuote; currency: string }) {
  return (
    <div className="grid gap-3">
      <p className="font-medium text-foreground">{q.sentence}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-foreground">
        <Fact label="公司">{q.code}</Fact>
        <Fact label="現價">{price(q.price)}</Fact>
        {q.side === "buy" ? (
          <>
            <Fact label="付出">{`${fmtInt(q.coins)} ${currency}`}</Fact>
            <Fact label="手續費(燒掉)">{fmtInt(q.fee)}</Fact>
            <Fact label={q.leverage > 1 ? "保證金" : "成本"}>{fmtInt(q.margin)}</Fact>
            <Fact label="部位">{`${fmtInt(q.exposure)}(約 ${shares(q.qty)} 股)`}</Fact>
            {q.max_loss !== null && <Fact label="最多賠掉">{`${fmtInt(q.max_loss)} ${currency}`}</Fact>}
            {q.line_price !== null && <Fact label="跌到這裡自動賣出">{price(q.line_price)}</Fact>}
            {q.warn_half_price !== null && <Fact label="第一次通知">{price(q.warn_half_price)}</Fact>}
            {q.warn_near_price !== null && <Fact label="第二次通知">{price(q.warn_near_price)}</Fact>}
          </>
        ) : (
          <>
            <Fact label="股數">{shares(q.qty)}</Fact>
            <Fact label="約收到">{fmtInt(q.gross)}</Fact>
            <Fact label="手續費 / 交易稅">{`${q.fee} / ${q.tax}`}</Fact>
            <Fact label="約拿回">{`${fmtInt(q.net)} ${currency}`}</Fact>
          </>
        )}
      </dl>
      <p className="text-xs">下一盤以那時的價格成交,實際的數字可能不同。</p>
    </div>
  );
}

function OrderTicket({ m, account, preset }: { m: ExchangeMarket; account: ExchangeAccount; preset: string }) {
  const api = useApi();
  const refresh = useRefresh();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [code, setCode] = useState(preset);
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [coins, setCoins] = useState("100");
  const [qty, setQty] = useState("");
  const [all, setAll] = useState(true);
  const [limit, setLimit] = useState("");
  const [days, setDays] = useState("1");
  const [lev, setLev] = useState<"1" | "2">("1");
  const [quote, setQuote] = useState<ExchangeQuote | null>(null);
  const [key, setKey] = useState(newKey);
  const allId = useId();
  const request = (): ExchangeOrderRequest => {
    const r: ExchangeOrderRequest = { side, company: code };
    if (side === "buy") {
      r.coins = Number(coins);
      if (lev === "2") r.leverage = 2;
    } else if (all) r.all = true;
    else r.shares = Number(qty);
    if (kind === "limit") {
      r.limit = Number(limit);
      r.days = Number(days);
    }
    return r;
  };
  const ask = useMutation({
    mutationFn: () => api.rpc.exchange.quote({ body: request() }),
    onSuccess: (q) => {
      setKey(newKey());
      setQuote(q);
    },
    onError: (e) => notify.error(e),
  });
  const place = useMutation({
    mutationFn: () => api.rpc.exchange.order({ headers: { "idempotency-key": key }, body: request() }),
    onSuccess: () => {
      setQuote(null);
      notify.ok("委託送出了,下一盤成交");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask.mutate();
  };
  const canLev = account.leverage.opted_in && m.rules.leverage.enabled;
  const closed = !m.enabled || m.paused;
  return (
    <form className="grid max-w-xl gap-4" onSubmit={submit}>
      <Segmented label="買或賣" value={side} onChange={setSide} options={[{ value: "buy", label: "買進" }, { value: "sell", label: "賣出" }]} />
      <Segmented label="哪一家" value={code} onChange={setCode} options={m.companies.map((c) => ({ value: c.code, label: c.code }))} />
      <Segmented label="市價或限價" value={kind} onChange={setKind} options={[{ value: "market", label: "市價(下一盤)" }, { value: "limit", label: "限價" }]} />
      {side === "buy" ? (
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor={`${allId}-coins`}>{`花多少魚幣(含手續費,${m.rules.order_min} 到 ${m.rules.order_max})`}</label>
          <Input id={`${allId}-coins`} inputMode="numeric" value={coins} onChange={(e) => setCoins(e.target.value)} />
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Checkbox id={allId} checked={all} onCheckedChange={(v) => setAll(v === true)} />
            <label htmlFor={allId} className="text-sm">賣掉這一家可以賣的全部</label>
          </div>
          {!all && <Input aria-label="股數" inputMode="decimal" placeholder="股數(到小數三位)" value={qty} onChange={(e) => setQty(e.target.value)} />}
        </div>
      )}
      {kind === "limit" && (
        <div className="grid grid-cols-2 gap-3">
          <Input aria-label="限價" inputMode="decimal" placeholder="限價(例如 98.50)" value={limit} onChange={(e) => setLimit(e.target.value)} />
          <Input aria-label="放幾天" inputMode="numeric" placeholder="放幾個交易日" value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
      )}
      {side === "buy" && canLev && <Segmented label="槓桿" value={lev} onChange={setLev} options={[{ value: "1", label: "不用槓桿" }, { value: "2", label: "2 倍" }]} />}
      <p className="text-xs text-muted-foreground">
        {`今天還能下 ${account.today.orders_left} 筆、買 ${fmtInt(account.today.buy_left)};可以投入 ${account.investable === null ? "—" : fmtInt(account.investable)} ${m.currency}`}
      </p>
      <Button type="submit" className="justify-self-start" busy={ask.isPending} disabled={closed}>
        試算並確認
      </Button>
      {closed && <p className="text-[13px] text-muted-foreground">交易所現在不能下單</p>}
      <ConfirmDialog
        open={quote !== null}
        title={quote?.side === "sell" ? "確認賣出" : quote && quote.leverage > 1 ? "確認槓桿買進" : "確認買進"}
        confirmLabel="送出委託"
        busy={place.isPending}
        onConfirm={() => place.mutate()}
        onClose={() => setQuote(null)}
      >
        {quote && <QuoteBody q={quote} currency={m.currency} />}
      </ConfirmDialog>
    </form>
  );
}

function OrderTab({ m, preset }: { m: ExchangeMarket; preset: string }) {
  const account = useAccount();
  return (
    <Loaded query={account} rows={3}>
      {(a) =>
        !a.opened ? (
          <OpenAccount account={a} />
        ) : (
          <div className="grid gap-4">
            {a.blocked && <p className="text-[13px] text-muted-foreground">你現在只能賣出手上的持股,不能買進。</p>}
            <OrderTicket m={m} account={a} preset={preset} />
            <LeverageOptIn account={a} />
          </div>
        )
      }
    </Loaded>
  );
}

// ---- 我的 --------------------------------------------------------------------------------------

function LeveragedRow({ p, currency }: { p: ExchangeLeveraged; currency: string }) {
  const api = useApi();
  const refresh = useRefresh();
  const history = useCompany(p.code);
  const [coins, setCoins] = useState("");
  const [closing, setClosing] = useState(false);
  const [key] = useState(newKey);
  const add = useMutation({
    mutationFn: () => api.rpc.exchange.margin({ headers: { "idempotency-key": `${key}:${coins}` }, body: { position: p.id, coins: Number(coins) } }),
    onSuccess: (r) => {
      setCoins("");
      notify.ok(`加了 ${r.added} ${currency} 保證金`);
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  const close = useMutation({
    mutationFn: () => api.rpc.exchange.order({ headers: { "idempotency-key": `${key}:close` }, body: { side: "sell", company: p.code, position: p.id } }),
    onSuccess: () => {
      setClosing(false);
      notify.ok("賣單送出了,下一盤成交");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  const ratio = Math.max(0, Math.min(1, p.ratio));
  return (
    <li className="grid gap-3 py-4">
      <PriceChart history={history.data?.history ?? []} line={p.line_price} title={`${p.code} ${p.name}・${p.leverage} 倍`} aside={`跌到 ${price(p.line_price)} 自動賣出`} />
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        <Fact label="保證金">{fmtInt(p.margin)}</Fact>
        <Fact label="部位">{`${fmtInt(p.exposure)}(${shares(p.qty)} 股)`}</Fact>
        <Fact label="現在剩">{`${fmtInt(Math.max(0, Math.floor(p.equity)))}(${fmtPct(ratio)})`}</Fact>
        <Fact label="借的 / 利息">{`${fmtInt(p.loan)} / ${fmtInt(p.carry)}`}</Fact>
        <Fact label="現價">{price(p.price)}</Fact>
        <Fact label="第一次通知">{price(p.warn_half_price)}</Fact>
        <Fact label="第二次通知">{price(p.warn_near_price)}</Fact>
        <Fact label="自動賣出">{price(p.line_price)}</Fact>
      </dl>
      <Meter value={ratio} tone={ratio <= 0.5 ? "brand" : "neutral"} label={`保證金剩 ${fmtPct(ratio)}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="加多少保證金" className="w-32" inputMode="numeric" placeholder="加保證金" value={coins} onChange={(e) => setCoins(e.target.value)} />
        <Button size="sm" variant="outline" busy={add.isPending} disabled={!(Number(coins) > 0) || p.loan <= 0} onClick={() => add.mutate()}>
          加保證金
        </Button>
        <Button size="sm" variant="outline" disabled={!p.can_close} title={p.can_close ? undefined : "今天買的明天才能賣,或已經有一筆賣單在等"} onClick={() => setClosing(true)}>
          賣掉整個部位
        </Button>
      </div>
      <ConfirmDialog open={closing} title="賣掉這個槓桿部位" confirmLabel="送出賣單" busy={close.isPending} onConfirm={() => close.mutate()} onClose={() => setClosing(false)}>
        <p>{`下一盤以那時的價格賣出 ${p.code} 的整個部位;現價算,大約拿回 ${fmtInt(Math.max(0, Math.floor(p.equity)))} ${currency},再扣手續費和稅。`}</p>
      </ConfirmDialog>
    </li>
  );
}

function MineTab({ currency }: { currency: string }) {
  const api = useApi();
  const refresh = useRefresh();
  const portfolio = usePortfolio();
  const cancel = useMutation({
    mutationFn: (order: string) => api.rpc.exchange.cancel({ body: { order } }),
    onSuccess: (r) => {
      notify.ok(r.refunded > 0 ? `取消了,退回 ${r.refunded} ${currency}` : "取消了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  return (
    <Loaded query={portfolio} rows={4}>
      {(p: ExchangePortfolio) =>
        !p.account.opened ? (
          <EmptyLine>還沒開戶</EmptyLine>
        ) : (
          <div className="grid gap-8">
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Fact label="總資產(錢包加持股市值)">{p.totals.worth === null ? "—" : `${fmtInt(Math.floor(p.totals.worth))} ${currency}`}</Fact>
              <Fact label="持股市值">{fmtInt(Math.floor(p.totals.value))}</Fact>
              <Fact label="成本">{fmtInt(p.totals.cost)}</Fact>
              <Fact label="持有上限">{`每家 ${p.account.limits.company}、合計 ${p.account.limits.total}`}</Fact>
            </dl>
            <p className="text-xs text-muted-foreground">只有你自己看得到這裡;她也看不到任何人的持股。</p>
            <Part title="持股">
              {p.holdings.length === 0 ? (
                <EmptyLine>沒有持股</EmptyLine>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {p.holdings.map((h) => (
                    <li key={h.code} className="flex items-baseline gap-3 py-(--row-y) text-sm">
                      <span className="w-12 shrink-0 font-mono text-[13px]">{h.code}</span>
                      <span className="min-w-0 flex-1 truncate tabular-nums">{`${shares(h.qty)} 股(今天可賣 ${shares(h.sellable)})`}</span>
                      <span className="shrink-0 tabular-nums">{`成本 ${fmtInt(h.cost)}・市值 ${fmtInt(Math.floor(h.value))}`}</span>
                      <span className="w-16 shrink-0 text-right text-[13px]">
                        <Move value={h.cost > 0 ? h.value / h.cost - 1 : 0} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Part>
            {p.leveraged.length > 0 && (
              <Part title="槓桿部位" aside="最多賠掉保證金,不會欠錢">
                <ul className="divide-y divide-line-soft">
                  {p.leveraged.map((l) => (
                    <LeveragedRow key={l.id} p={l} currency={currency} />
                  ))}
                </ul>
              </Part>
            )}
            <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-x-(--stage-gap)">
              <Part title="委託">
                {p.orders.length === 0 ? (
                  <EmptyLine>還沒有委託</EmptyLine>
                ) : (
                  <ul className="divide-y divide-line-soft">
                    {p.orders.slice(0, 12).map((o) => (
                      <li key={o.id} className="flex items-baseline gap-3 py-(--row-y) text-sm">
                        <span className="w-12 shrink-0 font-mono text-[13px]">{o.code}</span>
                        <span className="min-w-0 flex-1 truncate">
                          {o.side === "buy" ? `買 ${fmtInt(o.coins)}${o.leverage > 1 ? `(${o.leverage} 倍)` : ""}` : `賣 ${shares(o.qty)} 股`}
                          {o.limit !== null && `・限價 ${price(o.limit)}`}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{o.status === "open" ? "等下一盤" : (o.why ?? o.status)}</span>
                        {o.status === "open" && (
                          <Button size="sm" variant="ghost" busy={cancel.isPending && cancel.variables === o.id} onClick={() => cancel.mutate(o.id)}>
                            取消
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Part>
              <Part title="成交">
                {p.fills.length === 0 ? (
                  <EmptyLine>還沒有成交</EmptyLine>
                ) : (
                  <ul className="divide-y divide-line-soft">
                    {p.fills.slice(0, 12).map((f) => (
                      <li key={f.id} className="flex items-baseline gap-3 py-(--row-y) text-sm">
                        <span className="w-12 shrink-0 font-mono text-[13px]">{f.code}</span>
                        <span className="min-w-0 flex-1 truncate tabular-nums">
                          {f.side === "buy" ? `買 ${shares(f.qty)} 股 @ ${price(f.price)}` : `${f.kind === "liquidation" ? "自動賣出" : "賣"} ${shares(f.qty)} 股 @ ${price(f.price)}`}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {f.side === "buy" ? `手續費 ${f.fee}` : `拿回 ${fmtInt(f.paid)}(燒 ${f.fee + f.tax + f.carry})`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Part>
            </div>
            {p.notices.length > 0 && (
              <Part title="通知">
                <ul className="divide-y divide-line-soft">
                  {p.notices.slice(0, 10).map((n) => (
                    <li key={n.id} className="grid gap-0.5 py-(--row-y) text-sm">
                      <span>{n.text}</span>
                      <span className="font-mono text-xs text-muted-foreground">{fmtDateTime(n.at)}</span>
                    </li>
                  ))}
                </ul>
              </Part>
            )}
          </div>
        )
      }
    </Loaded>
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
      <p className="text-xs text-muted-foreground">預設會上榜(富人榜和本週交易量)。關掉之後你不會出現在任何一個榜上,只有你自己看得到你的名次。</p>
      <div className="flex items-center gap-2">
        <Switch id={showId} checked={account.show_holdings} disabled={set.isPending} onCheckedChange={(on) => set.mutate({ show_holdings: on })} />
        <label htmlFor={showId} className="text-sm">
          在富人榜上公開我持有哪幾家
        </label>
      </div>
      <p className="text-xs text-muted-foreground">預設不公開;打開也只列公司和市值,不列股數和成本。</p>
    </div>
  );
}

function BoardsTab({ currency }: { currency: string }) {
  const boards = useBoards();
  const account = useAccount();
  return (
    <div className="grid gap-8">
      {account.data?.opened && <Visibility account={account.data} />}
      <Loaded query={boards} rows={5}>
        {(b: ExchangeBoards) => (
          <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-x-(--stage-gap)">
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
                      <span className="shrink-0 tabular-nums">{`${fmtInt(r.worth)} ${currency}`}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Part>
            <Part title="本週交易量" aside={`${b.week_start} 起,不排賺賠`}>
              {b.volume.length === 0 ? (
                <EmptyLine>這週還沒有人交易</EmptyLine>
              ) : (
                <ol className="divide-y divide-line-soft">
                  {b.volume.map((r) => (
                    <li key={r.rank} className={`flex items-baseline gap-3 py-(--row-y) text-sm ${r.me ? "font-medium" : ""}`}>
                      <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{r.rank}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {r.name}
                        {r.me && <span className="ml-1 text-xs text-primary">你</span>}
                      </span>
                      <span className="shrink-0 tabular-nums">{`${fmtInt(r.volume)}・${r.trades} 筆`}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Part>
            {b.me && (
              <p className="text-[13px] text-muted-foreground lg:col-span-2">
                {b.me.hidden ? `你設定了不上榜。` : ""}
                {`你在富人榜${b.me.rich === null ? "還沒有名次" : `第 ${b.me.rich} 名`},本週交易量${b.me.volume === null ? "還沒有名次" : `第 ${b.me.volume} 名`}。`}
              </p>
            )}
          </div>
        )}
      </Loaded>
    </div>
  );
}

// ---- the block ---------------------------------------------------------------------------------

/** 深海交易所: the market, a company, the ticket, their own book, the boards. */
export function Exchange() {
  const market = useMarket();
  const stored = readStorage(TAB_KEY);
  const [tab, setTab] = useState<Tab>(TABS.includes(stored as Tab) ? (stored as Tab) : "market");
  const [code, setCode] = useState("DPSK");
  const pick = (v: string) => {
    if (!TABS.includes(v as Tab)) return;
    setTab(v as Tab);
    writeStorage(TAB_KEY, v);
  };
  const openCompany = (c: string) => {
    setCode(c);
    pick("company");
  };
  if (market.isError && isNotProvided(market.error)) return null;
  const off = market.isError && isApiError(market.error) && market.error.kind === "unavailable";
  const currency = market.data?.currency ?? "魚幣";
  return (
    <Card aria-label="深海交易所">
      <CardHeader>
        <CardTitle>深海交易所</CardTitle>
      </CardHeader>
      {off ? (
        <OffLine title="交易所現在沒有開" onRetry={() => void market.refetch()} />
      ) : market.isError ? (
        <ErrorLine error={market.error} onRetry={() => void market.refetch()} />
      ) : market.isPending ? (
        <SkeletonRows count={6} />
      ) : (
        <Tabs value={tab} onValueChange={pick} className="gap-4">
          <TabsList variant="inline" aria-label="深海交易所">
            <TabsTrigger value="market">行情</TabsTrigger>
            <TabsTrigger value="company">個股</TabsTrigger>
            <TabsTrigger value="order">下單</TabsTrigger>
            <TabsTrigger value="mine">我的</TabsTrigger>
            <TabsTrigger value="boards">排行榜</TabsTrigger>
          </TabsList>
          {!market.data.enabled && <p className="text-[13px] text-muted-foreground">交易所還沒開放,下面是規則和目前的價格。</p>}
          <TabsContent value="market">
            <MarketTab m={market.data} onPick={openCompany} />
          </TabsContent>
          <TabsContent value="company">
            <CompanyTab code={code} setCode={setCode} companies={market.data.companies} />
          </TabsContent>
          <TabsContent value="order">
            <OrderTab m={market.data} preset={code} />
          </TabsContent>
          <TabsContent value="mine">
            <MineTab currency={currency} />
          </TabsContent>
          <TabsContent value="boards">
            <BoardsTab currency={currency} />
          </TabsContent>
        </Tabs>
      )}
    </Card>
  );
}
