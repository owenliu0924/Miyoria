// 我的: their own book. The summary in one strip (wallet, worth, cost, gain), then each holding as
// a row to scan (the ticker, its name and shares, its worth and gain with the arrow and sign) that
// opens the ticker, with 買 / 賣 beside it; the orders still waiting, each with 取消; the latest fills
// folded away until asked for; notices; the small print. Only they see any of it.

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { ExchangeMarket, ExchangePortfolio } from "@miyoria/contracts/api";
import { EmptyLine } from "@/components/query-state";
import { fmtDateTime, fmtInt, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { COIN, coins, Fact, Gain, HER, Loaded, Part, SmallPrint, shares, usePortfolio } from "./common";
import { useCancel, WaitingOrder } from "./Position";
import { heldOf, holdingGain, QTY, type Side } from "./trade-math";

type Holding = ExchangePortfolio["holdings"][number];

/** One row: the plain lots of a ticker together, or one 2x position. */
interface Line {
  key: string;
  code: string;
  name: string;
  qty: number;
  value: number | null;
  cost: number;
  gain: number | null;
  base: number;
  avg: number | null;
  position: Holding | null;
}

function linesOf(p: ExchangePortfolio): Line[] {
  const out: Line[] = [];
  const codes = [...new Set(p.holdings.map((h) => h.code))];
  for (const code of codes) {
    const held = heldOf(p, code);
    const first = p.holdings.find((h) => h.code === code);
    if (held.lots.length > 0)
      out.push({ key: `plain:${code}`, code, name: first?.name ?? code, qty: held.qty, value: held.value, cost: held.cost, gain: held.value === null ? null : held.value - held.cost, base: held.cost, avg: held.avg, position: null });
    for (const h of held.levered) {
      const g = holdingGain(h);
      out.push({ key: h.id, code, name: h.name, qty: h.qty, value: h.equity, cost: h.margin, gain: g.amount, base: g.base, avg: h.qty > 0 ? h.cost / (h.qty / QTY) : null, position: h });
    }
  }
  return out;
}

const small = "h-8 min-w-11 px-3 pointer-coarse:h-11 rounded-md bg-control text-[13px] font-medium outline-none transition-colors hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [text-shadow:none]";

function HoldingRow({ l, m, onOpen, onTrade }: { l: Line; m: ExchangeMarket; onOpen: (code: string) => void; onTrade: (code: string, side: Side, position: string | null) => void }) {
  const h = l.position;
  const canSell = h ? h.can_sell : true;
  return (
    <li className="flex items-center gap-2 py-(--row-y)">
      <button
        type="button"
        onClick={() => onOpen(l.code)}
        aria-label={`${l.code} ${l.name}`}
        className="-mx-1.5 grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-[13px] font-medium">{l.code}</span>
          {h && <span className="rounded-[4px] bg-control px-1 text-[11px] font-medium">2 倍</span>}
        </span>
        <span className="hidden text-right text-xs text-muted-foreground tabular-nums sm:block">{`均價 ${coins(l.avg)}`}</span>
        <span className="text-right text-sm font-medium tabular-nums">{l.value === null ? "—" : `${fmtInt(Math.floor(l.value))} ${COIN}`}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">{`${l.name}・${shares(l.qty)} 股`}</span>
        <span className="hidden text-right text-xs text-muted-foreground tabular-nums sm:block">{`${h ? "保證金" : "成本"} ${fmtInt(l.cost)}`}</span>
        <Gain amount={l.gain} base={l.base} colors={m.colors} className="text-right text-xs" />
        {h && (
          <span className="col-span-full text-xs text-muted-foreground tabular-nums">{`保證金 ${fmtInt(h.margin)}・剩 ${h.ratio === null ? "—" : fmtPct(Math.max(0, h.ratio))}・跌到 ${coins(h.line_price)} 自動賣出`}</span>
        )}
      </button>
      <button type="button" className={small} aria-label={`買進 ${l.code}`} onClick={() => onTrade(l.code, "buy", null)} disabled={!m.enabled}>
        買
      </button>
      <button type="button" className={small} aria-label={h ? `賣掉這筆 ${l.code} 2 倍` : `賣出 ${l.code}`} onClick={() => onTrade(l.code, "sell", h?.id ?? null)} disabled={!m.enabled || !canSell} title={canSell ? undefined : "這筆現在不能賣"}>
        賣
      </button>
    </li>
  );
}

function Fills({ p }: { p: ExchangePortfolio }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (p.fills.length === 0) return <Part title="成交"><EmptyLine>還沒有成交</EmptyLine></Part>;
  const shown = p.fills.slice(0, 10);
  return (
    <section className="grid min-w-0 content-start gap-2">
      <h3 className="text-[13px] font-medium">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="-mx-1.5 inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11">
          {`最近成交 ${shown.length} 筆`}
          <ChevronDown aria-hidden className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </h3>
      {open && (
        <ul id={id} className="divide-y divide-line-soft">
          {shown.map((f) => (
            <li key={f.id} className="flex flex-wrap items-baseline gap-3 py-(--row-y) text-sm">
              <span className="w-20 shrink-0 font-mono text-[13px]">{f.code}</span>
              <span className="min-w-0 flex-1 tabular-nums">{`${f.side === "sell" ? "賣出" : "買進"} ${shares(f.qty)} 股・每股 ${coins(f.price)}・手續費 ${f.fee}`}</span>
              <span className="font-mono text-xs text-muted-foreground">{fmtDateTime(f.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function MineTab({ m, onOpen, onTrade }: { m: ExchangeMarket; onOpen: (code: string) => void; onTrade: (code: string, side: Side, position: string | null) => void }) {
  const portfolio = usePortfolio();
  const cancel = useCancel(m);
  return (
    <Loaded query={portfolio} rows={4}>
      {(p) => {
        const leverage = p.holdings.some((h) => h.leverage > 1);
        const lines = linesOf(p);
        // What they put in, and what came of it: a plain lot on its cost, a 2x position on its margin.
        const base = lines.reduce((t, l) => t + l.base, 0);
        const gain = lines.some((l) => l.gain === null) ? null : lines.reduce((t, l) => t + (l.gain ?? 0), 0);
        const waiting = p.orders.filter((o) => o.status === "open");
        return (
          <div className="grid max-w-4xl gap-8">
            {p.bankrupt && (
              <p role="status" className="text-sm font-medium">
                {`破產冷靜期到 ${fmtDateTime(p.bankrupt.until)}:所有持股已經結清,不會欠錢(交易所吸收 ${fmtInt(p.bankrupt.written_off)} ${m.currency})。之前不能買進。`}
              </p>
            )}
            <div className="grid gap-2">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-10">
                <Fact label="錢包">{p.balance === null ? "—" : `${fmtInt(Math.floor(p.balance))} ${m.currency}`}</Fact>
                <Fact label="持股市值">{fmtInt(Math.floor(p.totals.value))}</Fact>
                <Fact label="成本">{fmtInt(base)}</Fact>
                <Fact label="損益">
                  <Gain amount={gain} base={base} colors={m.colors} />
                </Fact>
              </dl>
              <p className="text-xs text-muted-foreground">{`只有你自己看得到這裡;${HER}也看不到任何人的持股。`}</p>
            </div>
            <Part title="持股" aside={lines.length > 0 ? `${lines.length} 筆` : undefined}>
              {lines.length === 0 ? (
                <EmptyLine>沒有持股</EmptyLine>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {lines.map((l) => (
                    <HoldingRow key={l.key} l={l} m={m} onOpen={onOpen} onTrade={onTrade} />
                  ))}
                </ul>
              )}
            </Part>
            <Part title="委託">
              {waiting.length === 0 ? (
                <EmptyLine>沒有等待中的委託</EmptyLine>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {waiting.map((o) => (
                    <WaitingOrder key={o.id} o={o} m={m} cancel={cancel} />
                  ))}
                </ul>
              )}
            </Part>
            <Fills p={p} />
            {p.notices.length > 0 && (
              <Part title="通知">
                <ul className="divide-y divide-line-soft">
                  {p.notices.slice(0, 8).map((n) => (
                    <li key={n.id} className="py-(--row-y) text-sm">
                      {n.text}
                    </li>
                  ))}
                </ul>
              </Part>
            )}
            <SmallPrint m={m} leverage={leverage || p.bankrupt !== null} />
          </div>
        );
      }}
    </Loaded>
  );
}
