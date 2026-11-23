// Their own position on a ticker's page, right under the price: the plain shares with their
// average cost, worth and unrealised gain, each 2x position with its margin and selling line, a
// 賣出 shortcut, and the orders of this ticker still waiting, each with 取消. Nothing at all when
// they hold none and nothing waits.

import { useMutation } from "@tanstack/react-query";
import type { ExchangeMarket } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { Button } from "@/components/ui/button";
import { fmtInt, fmtPct } from "@/lib/format";
import { notify } from "@/lib/notify";
import { COIN, coins, Fact, fillsWhen, Gain, shares, useRefresh } from "./common";
import { type Held, holdingGain } from "./trade-math";

/** Cancels a waiting order; says what came back. */
export function useCancel(m: ExchangeMarket) {
  const api = useApi();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (order: string) => api.rpc.exchange.cancel({ body: { order } }),
    onSuccess: (r) => {
      notify.ok(r.refunded > 0 ? `取消了,退回 ${r.refunded} ${m.currency}` : "取消了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
}

/** A waiting order in one line: what it is and when it fills, then 取消. */
export function WaitingOrder({ o, m, cancel, code = true }: { o: Held["orders"][number]; m: ExchangeMarket; cancel: ReturnType<typeof useCancel>; code?: boolean }) {
  return (
    <li className="flex items-center gap-3 py-(--row-y) text-sm">
      {code && <span className="w-20 shrink-0 font-mono text-[13px]">{o.code}</span>}
      <span className="min-w-0 flex-1 tabular-nums">
        {o.side === "buy" ? `買進 ${fmtInt(o.coins)} ${m.currency}${o.leverage > 1 ? "・2 倍" : ""}` : `賣出 ${shares(o.qty)} 股`}
        <span className="block text-xs text-muted-foreground">{fillsWhen(o.next_open)}</span>
      </span>
      <Button size="sm" variant="outline" className="pointer-coarse:h-11" busy={cancel.isPending && cancel.variables === o.id} onClick={() => cancel.mutate(o.id)}>
        取消
      </Button>
    </li>
  );
}

export function Position({ m, held, onSell }: { m: ExchangeMarket; held: Held; onSell: (position: string | null) => void }) {
  const cancel = useCancel(m);
  if (held.lots.length === 0 && held.levered.length === 0 && held.orders.length === 0) return null;
  const canSellPlain = held.lots.some((h) => h.can_sell) && held.free > 0;
  return (
    <section aria-label="你的持股" className="grid gap-2 border-y border-line-soft py-3">
      {(held.lots.length > 0 || held.levered.length > 0) && (
        <h3 className="flex items-center justify-between gap-3 text-[13px] font-medium">
          你的持股
          {held.lots.length > 0 && (
            <Button size="sm" variant="outline" className="pointer-coarse:h-11" disabled={!canSellPlain} title={canSellPlain ? undefined : "這些股數現在不能賣"} onClick={() => onSell(null)}>
              賣出
            </Button>
          )}
        </h3>
      )}
      {held.lots.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:flex-wrap sm:gap-x-8">
          <Fact label="股數">{`${shares(held.qty)} 股`}</Fact>
          <Fact label={`平均成本(${COIN}一股)`}>{coins(held.avg)}</Fact>
          <Fact label="市值">{held.value === null ? "—" : `${fmtInt(Math.floor(held.value))} ${COIN}`}</Fact>
          <Fact label="未實現損益">
            <Gain amount={held.value === null ? null : held.value - held.cost} base={held.cost} colors={m.colors} />
          </Fact>
        </dl>
      )}
      {held.levered.length > 0 && (
        <ul className="divide-y divide-line-soft">
          {held.levered.map((h) => {
            const g = holdingGain(h);
            return (
              <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-(--row-y) text-sm">
                <span className="min-w-0 flex-1 tabular-nums">
                  {`2 倍 ${shares(h.qty)} 股・保證金 ${fmtInt(h.margin)}`}
                  <span className="block text-xs text-muted-foreground">{`剩 ${h.ratio === null ? "—" : fmtPct(Math.max(0, h.ratio))}・跌到 ${coins(h.line_price)} 自動賣出`}</span>
                </span>
                <Gain amount={g.amount} base={g.base} colors={m.colors} className="text-[13px]" />
                <Button size="sm" variant="outline" className="pointer-coarse:h-11" disabled={!h.can_sell} title={h.can_sell ? undefined : "這筆現在不能賣"} onClick={() => onSell(h.id)}>
                  賣掉這筆
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {held.orders.length > 0 && (
        <div className="grid gap-1">
          <h3 className="text-[13px] font-medium">等待中的委託</h3>
          <ul className="divide-y divide-line-soft">
            {held.orders.map((o) => (
              <WaitingOrder key={o.id} o={o} m={m} cancel={cancel} code={false} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
