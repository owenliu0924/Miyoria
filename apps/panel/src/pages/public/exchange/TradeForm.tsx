// The order ticket (owner 2026-11-23: "like a good trading app"), the same in the bottom sheet on a
// phone and in the panel beside the chart on a wide screen: buy or sell, 金額 or 股數 in one large
// field with the quick amounts (a share of what they may spend, or of what they hold), 1x or 2x where
// the ticker and the member allow it, and the numbers as they type: the local estimate at once,
// replaced by the Core's quote when it answers (debounced). The one button places exactly the
// order that quote priced, so the member always sees the final numbers before a charge whose price
// is not fixed and confirms them (the rule the old quote-then-confirm dialog kept); a new price or
// a changed amount asks again and holds the button until it answers. After it goes through, the
// same place says what happened: filled at what price, or waiting for the next valid quote.
// Every refusal is the Core's own sentence, said beside the control it is about.

import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import type { ExchangeAccount, ExchangeLine, ExchangeMarket, ExchangeOrder, ExchangeOrderRequest, ExchangeQuote } from "@miyoria/contracts/api";
import { isApiError } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { newKey } from "../spend";
import {
  COIN,
  type Colors,
  coins,
  downColor,
  fillsWhen,
  Gain,
  HER,
  MARKET_INK,
  Move,
  marketWord,
  nativePrice,
  ROOT,
  SmallPrint,
  shares,
  upColor,
  usePortfolio,
  useRefresh,
} from "./common";
import {
  buyBudget,
  chips,
  coinsForShares,
  type Estimate,
  estimate,
  fieldText,
  type Held,
  heldOf,
  type Mode,
  parseField,
  placeRefusal,
  QTY,
  type Side,
  sharesForBudget,
} from "./trade-math";

/** What the ticket opens on: a side, a 2x position to close, and (the demo) what is typed. */
export interface Ticket {
  side: Side;
  position: string | null;
  mode?: Mode;
  text?: string;
  lev?: 1 | 2;
}

/** What the 2× opt-in says, in full (owner 2026-11-21). */
export const LEVERAGE_RISKS = [
  "2 倍:放進去的保證金 M,可以買到 2M 的部位;漲跌都是兩倍。",
  "賠的可能超過保證金:不夠的部分先從你的錢包扣,再賣掉你其他的持股來補。最壞會賠光錢包和其他持股。",
  "不會欠錢:全部賠光時,剩下的由交易所吸收,你會進入破產冷靜期,所有持股結清,一段時間內不能買進。",
  "每一筆報價都會檢查;價格跳空時,可能沒有先通知就被自動賣出。",
  "只有一股夠貴、有前一天收盤價的股票才能用 2 倍;新手推薦的獨家股票不開放。",
  `這是市場的規則,不是${HER}做的決定;${HER}不會評論任何人的部位。`,
];

/** The 2x line said under the choice whenever 2 倍 is picked (kept word for word). */
export const LEVERAGE_LINE = "2 倍可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股。";

/** Why a side cannot be opened now, in two or three words (`null`: it can). */
export function sideBlocks(o: { m: ExchangeMarket; account: ExchangeAccount | undefined; held: Held; bankrupt: boolean }): Record<Side, string | null> {
  const off = o.m.enabled ? null : "還沒開放";
  const a = o.account;
  const buy = off ?? (a?.blocked ? "只能賣出" : o.bankrupt ? "冷靜期中" : o.m.house.buys_halted ? "今天停止買進" : null);
  const sell = off ?? (o.held.lots.length === 0 && o.held.levered.length === 0 ? "沒有持股" : null);
  return { buy, sell };
}

/** A side's colour: buying is up's, selling is down's, in the member's own convention. */
export const sideColor = (side: Side, colors: Colors) => (side === "buy" ? upColor(colors) : downColor(colors));

/** The ticker, its live price and today's move: the top of the sheet and of the panel. */
export function TradeHeader({ line, colors, title }: { line: ExchangeLine; colors: Colors; title: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      {title}
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] tabular-nums">
        <span className="font-medium">{line.currency === "COIN" ? `${coins(line.coin_price)} ${COIN}` : `${coins(line.coin_price)} ${COIN}・${nativePrice(line)}`}</span>
        <Move value={line.change} colors={colors} />
        <span className="text-xs text-muted-foreground">{marketWord(line)}</span>
      </p>
    </div>
  );
}

/** 買進 / 賣出 as one radio group, the picked side solid in its colour; a side that cannot be used says why. */
function SideSwitch({ side, onSide, colors, blocks }: { side: Side; onSide: (s: Side) => void; colors: Colors; blocks: Record<Side, string | null> }) {
  const refs = useRef<Record<Side, HTMLButtonElement | null>>({ buy: null, sell: null });
  const sides: Side[] = ["buy", "sell"];
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const other: Side = side === "buy" ? "sell" : "buy";
    if (blocks[other]) return;
    e.preventDefault();
    refs.current[other]?.focus();
    onSide(other);
  };
  return (
    <div role="radiogroup" aria-label="買或賣" className="grid grid-cols-2 gap-1 rounded-[9px] bg-well p-1">
      {sides.map((s) => {
        const on = s === side;
        const why = blocks[s];
        return (
          <button
            key={s}
            ref={(el) => {
              refs.current[s] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={why !== null && !on}
            onClick={() => !on && onSide(s)}
            onKeyDown={key}
            className={cn(
              "inline-flex h-10 items-center justify-center gap-1.5 rounded-[6px] text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11",
              on ? "[text-shadow:none]" : "text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            )}
            style={on ? { background: sideColor(s, colors), color: MARKET_INK } : undefined}
          >
            {s === "buy" ? "買進" : "賣出"}
            {why && !on && <span className="text-xs font-normal">{`・${why}`}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function OpenAccount({ account }: { account: ExchangeAccount }) {
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

/** The one-time 2x consent, its risks in full and the box to tick, as before. */
export function LeverageOptIn({ m, account }: { m: ExchangeMarket; account: ExchangeAccount }) {
  const api = useApi();
  const refresh = useRefresh();
  const [asking, setAsking] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const id = useId();
  const opt = useMutation({
    mutationFn: () => api.rpc.exchange.leverage({ body: { accept: true } }),
    onSuccess: () => {
      setAsking(false);
      notify.ok("可以用 2 倍了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  if (!m.rules.leverage || account.leverage.opted_in) return null;
  if (!account.leverage.allowed) return account.leverage.why ? <p className="text-xs text-muted-foreground">2 倍:{account.leverage.why}</p> : null;
  return (
    <>
      <Button variant="outline" size="sm" className="justify-self-start pointer-coarse:h-11" onClick={() => setAsking(true)}>
        開啟 2 倍
      </Button>
      <ConfirmDialog open={asking} title="開啟 2 倍之前" confirmLabel="我了解,開啟" busy={opt.isPending} confirmDisabled={!agreed} onConfirm={() => opt.mutate()} onClose={() => setAsking(false)}>
        <div className="grid gap-2">
          <ul className="grid list-disc gap-1 pl-5">
            {LEVERAGE_RISKS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <SmallPrint m={m} leverage />
          <div className="flex items-center gap-2">
            <Checkbox id={id} checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
            <label htmlFor={id}>我看過了,知道可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股</label>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

/** A value that settles `ms` after it last changed. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The quote's numbers in the estimate's shape (a sale's gain on the same cost as the estimate's). */
function quoted(q: ExchangeQuote, local: Estimate, held: Held, balance: number | null): Estimate {
  if (q.side === "buy")
    return { ...local, qty: q.qty, price: q.price, fee: q.fee, paid: q.coins, margin: q.margin, exposure: q.exposure, line: q.line_price, leverage: q.leverage, after: balance === null ? null : balance - q.coins };
  const basis = local.pnlBase !== null && local.qty ? (local.pnlBase * q.qty) / local.qty : held.avg === null ? null : (q.qty / QTY) * held.avg;
  return { ...local, qty: q.qty, price: q.price, gross: q.gross, fee: q.fee, net: q.net, pnl: basis === null ? null : q.net - basis, pnlBase: basis, after: balance === null ? null : balance + q.net };
}

/** The button's words: what will happen, from the Core's quote (`委託…` while its market is closed). */
export function confirmWords(q: ExchangeQuote): string {
  const wait = q.open ? "" : "委託";
  if (q.side === "sell") return `${wait}賣出 ${shares(q.qty)} 股・約 ${fmtInt(q.net)} ${COIN}`;
  if (q.leverage > 1) return `${wait}2 倍買進 ${shares(q.qty)} 股・付 ${fmtInt(q.coins)} ${COIN}`;
  return `${wait}買進 ${shares(q.qty)} 股・約 ${fmtInt(q.coins)} ${COIN}`;
}

function Row({ label, children, strong = false }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className={cn("text-[13px]", strong ? "text-foreground" : "text-muted-foreground")}>{label}</dt>
      <dd className={cn("text-right tabular-nums", strong ? "text-sm font-semibold" : "text-[13px]")}>{children}</dd>
    </div>
  );
}

const n = (x: number | null, unit = "") => (x === null ? "—" : `${fmtInt(Math.round(x))}${unit}`);

/** The order's numbers. The rows are fixed for a side and a leverage, so nothing moves as they type. */
function Numbers({ e, priceLabel, colors, position }: { e: Estimate; priceLabel: string; colors: Colors; position: boolean }) {
  const qty = e.qty === null || (e.side === "buy" && e.paid === null) ? "—" : `${shares(e.qty)} 股`;
  const price = e.price === null ? "—" : coins(e.price);
  if (e.side === "buy")
    return (
      <dl className="divide-y divide-line-soft">
        <Row label="約買到">{qty}</Row>
        <Row label={priceLabel}>{price}</Row>
        {e.leverage > 1 && <Row label="保證金">{n(e.margin)}</Row>}
        {e.leverage > 1 && <Row label="2 倍的部位">{n(e.exposure)}</Row>}
        <Row label="手續費(燒掉)">{n(e.fee)}</Row>
        {e.leverage > 1 && <Row label="跌到這裡自動賣出">{e.line === null ? "—" : coins(e.line)}</Row>}
        <Row label="付出(含手續費)" strong>
          {n(e.paid, ` ${COIN}`)}
        </Row>
        <Row label="下單後錢包">{e.after !== null && e.after < 0 ? <span className="text-primary">不夠</span> : n(e.after, ` ${COIN}`)}</Row>
      </dl>
    );
  return (
    <dl className="divide-y divide-line-soft">
      <Row label="賣出">{e.qty === null || e.qty <= 0 ? "—" : `${shares(e.qty)} 股`}</Row>
      <Row label={priceLabel}>{price}</Row>
      <Row label="約收到">{n(e.gross)}</Row>
      {position && <Row label="先還 2 倍借的">{e.loan > 0 ? fmtInt(e.loan) : "—"}</Row>}
      <Row label="手續費(燒掉)">{n(e.fee)}</Row>
      <Row label="約拿回" strong>
        {n(e.net, ` ${COIN}`)}
      </Row>
      <Row label="約實現損益">{e.pnl === null ? "—" : <Gain amount={e.pnl} base={e.pnlBase} colors={colors} />}</Row>
      <Row label="成交後錢包">{n(e.after, ` ${COIN}`)}</Row>
    </dl>
  );
}

/** After the order went through: what it was, then filled at what price or what it waits for. */
function Placed({ order, quote, onShowMine, onAgain }: { order: ExchangeOrder; quote: ExchangeQuote; onShowMine: () => void; onAgain: () => void }) {
  const waiting = useRef(true);
  const portfolio = usePortfolio(waiting.current);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  const now = portfolio.data?.orders.find((o) => o.id === order.id);
  const status = now?.status ?? order.status;
  const fill =
    status === "filled"
      ? portfolio.data?.fills
          .filter((f) => f.code === order.code && f.side === order.side && f.at >= order.at)
          .sort((a, b) => b.at.localeCompare(a.at))[0]
      : undefined;
  waiting.current = status === "open" || status === "charging";
  const what =
    quote.side === "sell"
      ? `賣出 ${shares(quote.qty)} 股・約拿回 ${fmtInt(quote.net)} ${COIN}`
      : `${quote.leverage > 1 ? "2 倍" : ""}買進約 ${shares(quote.qty)} 股・付 ${fmtInt(quote.coins)} ${COIN}`;
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3">
        <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-foreground" />
        <div className="grid gap-1">
          <h3 ref={title} tabIndex={-1} className="text-[15px] font-semibold outline-none">
            {status === "filled" ? "成交了" : status === "cancelled" ? "沒有成交" : "委託送出了"}
          </h3>
          <p className="text-[13px] tabular-nums">{what}</p>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            {status === "filled"
              ? fill
                ? `成交價每股 ${coins(fill.price)} ${COIN}・${fill.side === "sell" ? `收到 ${fmtInt(fill.gross)}` : `${shares(fill.qty)} 股`}・手續費 ${fmtInt(fill.fee)}`
                : "成交了,明細在「我的」"
              : status === "cancelled"
                ? (now?.why ?? "這筆沒有成交")
                : `等成交:${fillsWhen(now?.next_open ?? order.next_open)}`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" className="h-11" onClick={onShowMine}>
          查看持股
        </Button>
        <Button variant="outline" className="h-11" onClick={onAgain}>
          再下一筆
        </Button>
      </div>
    </div>
  );
}

export interface TradeFormProps {
  m: ExchangeMarket;
  line: ExchangeLine;
  account: ExchangeAccount;
  ticket: Ticket;
  onTicket: (t: Ticket) => void;
  onShowMine: () => void;
  /** The amount field, focused when the sheet opens. */
  inputRef?: Ref<HTMLInputElement>;
  /** `sheet`: the body scrolls and the button stays at the bottom; `panel`: one column. */
  layout: "sheet" | "panel";
}

/** The ticket itself. Its parent keys it by side and position, so switching starts afresh. */
export function TradeForm({ m, line, account, ticket, onTicket, onShowMine, inputRef, layout }: TradeFormProps) {
  const api = useApi();
  const refresh = useRefresh();
  const portfolio = usePortfolio();
  const id = useId();
  const local = line.local !== null;
  const side = ticket.side;
  const held = heldOf(portfolio.data, line.code);
  const position = ticket.position ? ([...held.levered, ...held.lots].find((h) => h.id === ticket.position) ?? null) : null;
  const levOffered = side === "buy" && !local && m.rules.leverage && account.leverage.opted_in;
  const [lev, setLev] = useState<1 | 2>(levOffered ? (ticket.lev ?? 1) : 1);
  const [mode, setMode] = useState<Mode>(ticket.mode ?? (side === "sell" || local ? "shares" : "coins"));
  const [text, setText] = useState(ticket.text ?? "");
  const [all, setAll] = useState(false);
  const [round, setRound] = useState(0);
  const [placed, setPlaced] = useState<{ order: ExchangeOrder; quote: ExchangeQuote } | null>(null);
  const price = line.coin_price;
  const balance = account.balance;
  const budget = buyBudget(account, m.rules);
  const unit: Mode = lev === 2 ? "coins" : mode;
  const blocks = sideBlocks({ m, account, held, bankrupt: portfolio.data?.bankrupt != null });

  // What the field asks for, or why it cannot be asked yet.
  const parsed = parseField(text, unit, COIN);
  let request: ExchangeOrderRequest | null = null;
  let problem: string | null = null;
  if (side === "sell" && position) request = { side, code: line.code, position: position.id };
  else if (side === "sell" && all) request = { side, code: line.code, all: true };
  else if (parsed.ok) {
    request = unit === "coins" ? { side, code: line.code, coins: parsed.value } : { side, code: line.code, shares: parsed.value };
    if (side === "buy" && lev === 2) request.leverage = 2;
    if (side === "sell" && unit === "shares" && Math.round(parsed.value * QTY) > held.free) problem = `最多可賣 ${shares(held.free)} 股`;
    if (side === "sell" && unit === "coins" && price !== null && parsed.value > Math.floor((held.free / QTY) * price)) problem = `最多約可賣 ${fmtInt(Math.floor((held.free / QTY) * price))} ${COIN}`;
    if (problem) request = null;
  } else problem = parsed.message;

  // The Core's quote of exactly this request, asked once typing settles, and again on a new price.
  const asking = request ? JSON.stringify(request) : null;
  const settled = useSettled(asking, 400);
  const ready = m.enabled && placed === null && !(side === "buy" && blocks.buy !== null);
  const quote = useQuery({
    queryKey: [...ROOT, "quote", settled, line.at, price],
    queryFn: ({ signal }) => api.rpc.exchange.quote({ body: JSON.parse(settled as string) as ExchangeOrderRequest }, { signal }),
    enabled: ready && settled !== null && settled === asking,
    retry: false,
    staleTime: 20_000,
    gcTime: 60_000,
  });
  const fresh = quote.isSuccess && !quote.isFetching && settled === asking && asking !== null;
  // One key per priced request and round: a retry of the same click is charged once.
  const keyOf = useRef({ for: "", key: newKey() });
  const keyFor = `${round}:${asking ?? ""}`;
  if (keyOf.current.for !== keyFor) keyOf.current = { for: keyFor, key: newKey() };
  const place = useMutation({
    mutationFn: (body: ExchangeOrderRequest) => api.rpc.exchange.order({ headers: { "idempotency-key": keyOf.current.key }, body }),
    onSuccess: (order) => {
      if (quote.data) setPlaced({ order, quote: quote.data });
      refresh();
    },
    onError: () => void quote.refetch(),
  });
  const refusal = (() => {
    const e = place.error ?? (settled === asking ? quote.error : null);
    if (!e) return null;
    if (isApiError(e) && e.status >= 400 && e.status < 500) return { place: placeRefusal(e.message), text: e.message };
    return { place: "general" as const, text: `試算沒有回應:${e.message}`, retry: true };
  })();

  const guess = estimate(request, price, m.rules, held, balance, side);
  const shown = fresh && quote.data ? quoted(quote.data, guess, held, balance) : guess;
  const leverage = side === "buy" ? lev : position ? position.leverage : 1;
  shown.leverage = leverage;
  const note = fresh && quote.data ? quote.data.price_note : line.basis === "quote" ? null : line.price_note;
  const priceLabel = note ? `${note.split("・")[0]}(${COIN}一股)` : `現價(${COIN}一股)`;
  const nextOpen = fresh && quote.data ? quote.data.next_open : line.next_open;
  const quick = chips({ side, mode: unit, budget, free: held.free, price, rules: m.rules });
  const ordersLeft = account.today.orders_left;

  const setUnit = (next: Mode) => {
    if (parsed.ok && price) {
      const v = parsed.value;
      if (next === "shares") setText(fieldText(side === "buy" ? sharesForBudget(v, price, m.rules) : Math.floor((v / price) * 10_000) / 10_000));
      else setText(String(side === "buy" ? coinsForShares(v, price, m.rules) : Math.floor(v * price)));
    }
    setMode(next);
  };
  const setLeverage = (next: 1 | 2) => {
    if (next === 2 && mode === "shares") setUnit("coins");
    setLev(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (fresh && request && !refusal) place.mutate(request);
  };
  const again = () => {
    setPlaced(null);
    setText("");
    setAll(false);
    setRound((r) => r + 1);
    place.reset();
  };

  const sheet = layout === "sheet";
  if (placed)
    return (
      <div className={sheet ? "px-4 pt-2 pb-5" : ""}>
        <Placed order={placed.order} quote={placed.quote} onShowMine={onShowMine} onAgain={again} />
      </div>
    );

  const amountError = problem ?? (refusal?.place === "amount" ? refusal.text : null);
  const busy = request !== null && !fresh && !refusal;
  const label = !request
    ? side === "sell" && position
      ? "賣出"
      : unit === "coins"
        ? "輸入金額"
        : "輸入股數"
    : fresh && quote.data
      ? confirmWords(quote.data)
      : refusal
        ? side === "buy"
          ? "買進"
          : "賣出"
        : "試算中…";
  const can = fresh && !refusal && !place.isPending && ready;
  const color = sideColor(side, m.colors);

  return (
    <form aria-label="下單" onSubmit={submit} className={cn("flex min-h-0 flex-col", sheet && "flex-1")}>
      <div className={cn("grid content-start gap-4", sheet && "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-4")}>
        <SideSwitch side={side} onSide={(s) => onTicket({ side: s, position: null })} colors={m.colors} blocks={blocks} />
        {side === "buy" && account.blocked && <p className="text-[13px] text-muted-foreground">你現在只能賣出手上的持股,不能買進。</p>}
        {side === "sell" && held.levered.length + (held.lots.length > 0 ? 1 : 0) > 1 && (
          <Segmented
            label="賣哪一筆"
            size="lg"
            className="justify-self-start"
            value={position?.id ?? "plain"}
            onChange={(v) => onTicket({ side: "sell", position: v === "plain" ? null : v })}
            options={[
              ...(held.lots.length > 0 ? [{ value: "plain", label: `一般持股 ${shares(held.qty)} 股` }] : []),
              ...held.levered.map((h) => ({ value: h.id, label: `2 倍 ${shares(h.qty)} 股`, disabled: !h.can_sell, title: h.can_sell ? undefined : "這筆現在不能賣" })),
            ]}
          />
        )}
        {position ? (
          <p className="text-[13px]">{`整筆賣出 ${shares(position.qty)} 股${position.leverage > 1 ? `・保證金 ${fmtInt(position.margin)}` : ""}`}</p>
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <Segmented
                label="用什麼下單"
                size="lg"
                value={unit}
                onChange={setUnit}
                options={[
                  { value: "coins", label: "金額" },
                  { value: "shares", label: "股數", disabled: lev === 2, title: lev === 2 ? "2 倍只能用金額下單" : undefined },
                ]}
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                {side === "buy" ? (budget === null ? "" : `最多可投入 ${fmtInt(budget)} ${COIN}`) : `可賣 ${shares(held.free)} 股`}
              </span>
            </div>
            <label htmlFor={`${id}-amount`} className="sr-only">
              {`${side === "buy" ? "買" : "賣"}多少${unit === "coins" ? COIN : "股"}`}
            </label>
            <div className="relative">
              <Input
                ref={inputRef}
                id={`${id}-amount`}
                inputMode="decimal"
                enterKeyHint="done"
                autoComplete="off"
                placeholder="0"
                value={all ? (unit === "shares" ? fieldText(held.free / QTY, 6) : String(Math.floor((held.free / QTY) * (price ?? 0)))) : text}
                aria-invalid={amountError !== null}
                aria-describedby={`${id}-help`}
                onChange={(e) => {
                  setText(e.target.value);
                  setAll(false);
                }}
                className="h-14 pr-16 text-2xl font-semibold tabular-nums placeholder:text-muted-foreground/60"
              />
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-sm text-muted-foreground">
                {unit === "coins" ? COIN : "股"}
              </span>
            </div>
            <p id={`${id}-help`} role={amountError ? "alert" : undefined} className={cn("min-h-4 text-xs", amountError ? "text-primary" : "text-muted-foreground")}>
              {amountError ?? (side === "sell" && all ? "全部賣出" : unit === "shares" ? "可以買零股,最多到小數點後 6 位" : `${COIN}只能是整數,含手續費`)}
            </p>
            <div role="group" aria-label="快速數量" className={cn("grid gap-2", quick.length === 4 ? "grid-cols-4" : "grid-cols-3")}>
              {quick.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  disabled={c.disabled}
                  aria-pressed={c.all ? all : !all && text === c.text && text !== ""}
                  onClick={() => {
                    setText(c.all ? "" : c.text);
                    setAll(c.all);
                  }}
                  className="h-9 rounded-md bg-control text-[13px] font-medium tabular-nums outline-none transition-colors hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 aria-pressed:bg-control-hover aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-line-strong pointer-coarse:h-11 [text-shadow:none]"
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {levOffered && (
          <div className="grid gap-1.5">
            <Segmented
              label="倍數"
              size="lg"
              className="justify-self-start"
              value={String(lev) as "1" | "2"}
              onChange={(v) => setLeverage(v === "2" ? 2 : 1)}
              options={[
                { value: "1", label: "1 倍" },
                { value: "2", label: "2 倍" },
              ]}
            />
            {lev === 2 && <p className="text-[13px] font-medium">{LEVERAGE_LINE}</p>}
            {refusal?.place === "leverage" && (
              <p role="alert" className="text-xs text-primary">
                {refusal.text}
              </p>
            )}
          </div>
        )}
        {side === "buy" && !local && !levOffered && <LeverageOptIn m={m} account={account} />}
        {!levOffered && refusal?.place === "leverage" && (
          <p role="alert" className="text-xs text-primary">
            {refusal.text}
          </p>
        )}
        <section aria-label="試算" className="grid gap-1">
          <h3 className="flex items-baseline justify-between text-[13px] font-medium">
            試算
            <span className="text-xs font-normal text-muted-foreground">{fresh ? "交易所試算" : busy ? "估計・等交易所試算" : ""}</span>
          </h3>
          <Numbers e={shown} priceLabel={priceLabel} colors={m.colors} position={position !== null && position.leverage > 1} />
          <p className="sr-only" aria-live="polite">
            {fresh && quote.data ? `交易所試算:${confirmWords(quote.data)}` : ""}
          </p>
        </section>
        {fresh && quote.data && <p className="text-[13px] text-muted-foreground">{quote.data.sentence}</p>}
        {fresh && quote.data?.warning && <p className="text-[13px] font-medium text-foreground">{quote.data.warning}</p>}
        {line.stale && <p className="text-[13px] text-muted-foreground">報價太舊,暫停成交;持股不會因為沒有報價被賣出。</p>}
        <p className="text-xs">{`${fillsWhen(nextOpen)};實際的數字可能不同。`}</p>
        <SmallPrint m={m} leverage={leverage > 1} />
      </div>
      <div className={cn("grid gap-2", sheet ? "border-t border-line-soft px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "pt-4")}>
        {refusal?.place === "general" && (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-primary">
            {refusal.text}
            {"retry" in refusal && (
              <Button type="button" size="sm" variant="outline" onClick={() => void quote.refetch()}>
                再試算
              </Button>
            )}
          </p>
        )}
        <button
          type="submit"
          data-confirm
          disabled={!can}
          aria-busy={place.isPending || undefined}
          className="inline-flex h-12 w-full items-center justify-center rounded-md px-4 text-[15px] font-semibold tabular-nums outline-none transition-[filter,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring enabled:hover:brightness-110 disabled:bg-control disabled:text-muted-foreground [text-shadow:none]"
          style={can ? { background: color, color: MARKET_INK } : undefined}
        >
          {place.isPending ? "送出中…" : label}
        </button>
        {ordersLeft <= 3 && <p className="text-center text-xs text-muted-foreground tabular-nums">{`今天還能下 ${ordersLeft} 筆`}</p>}
      </div>
    </form>
  );
}
