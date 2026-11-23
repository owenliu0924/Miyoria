// What the exchange's member views share: the query keys and hooks, how a price, a share count and
// a move are written, the market's red and green under the member's own convention, the small
// print, and the facts and parts every view is built from. `Exchange.tsx` re-exports the helpers
// other pages and the tests use.

import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useSyncExternalStore } from "react";
import type { ExchangeLine, ExchangeMarket } from "@miyoria/contracts/api";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { fmtInt } from "@/lib/format";
import { WORLD } from "@/lib/world";
import { WALLET } from "../spend";

export const ROOT = ["member", "exchange"] as const;
export const MARKET = [...ROOT, "market"] as const;
export const ACCOUNT = [...ROOT, "account"] as const;
export const PORTFOLIO = [...ROOT, "portfolio"] as const;
export const BOARDS = [...ROOT, "boards"] as const;
const POLL_MS = 60_000;
export type Colors = ExchangeMarket["colors"];

export const retry = (n: number, e: Error) => !isNotProvided(e) && !(isApiError(e) && e.kind === "unavailable") && n < 2;
export const poll = (q: { state: { error: unknown } }) => (q.state.error ? false : POLL_MS);

/** Millionths of a share as drawn: whole shares plainly, else four places. */
export const shares = (qty: number) => {
  const s = qty / 1_000_000;
  return Number.isInteger(s) ? String(s) : s.toFixed(4);
};
/** A change with its arrow and sign: `▲ +1.2%`, `▼ −0.8%`. */
export function change(x: number | null): string {
  if (x === null) return "—";
  const v = Math.round(x * 1000) / 10;
  if (v > 0) return `▲ +${v.toFixed(1)}%`;
  if (v < 0) return `▼ −${Math.abs(v).toFixed(1)}%`;
  return "0.0%";
}
/** An amount of coins gained or lost with its arrow and sign: `▲ +120`, `▼ −35`. */
export function signed(x: number | null): string {
  if (x === null) return "—";
  const v = Math.round(x);
  if (v > 0) return `▲ +${fmtInt(v)}`;
  if (v < 0) return `▼ −${fmtInt(Math.abs(v))}`;
  return "0";
}
/** The market's red and green (the same as the pictures). */
const RED = "#ef5f5f";
const GREEN = "#3fc48a";
export const upColor = (c: Colors) => (c === "us" ? GREEN : RED);
export const downColor = (c: Colors) => (c === "us" ? RED : GREEN);
/** A move's colour (`undefined`: no move, the text's own). */
export const moveColor = (x: number | null, c: Colors) => (x === null || Math.round(x * 1000) === 0 ? undefined : x > 0 ? upColor(c) : downColor(c));
/** The ink on a solid button of the market's red or green: dark, as on the primary (about 6:1 and 9:1). */
export const MARKET_INK = "#14090c";
/** The two conventions in words, as every surface says them (`@miyoria/types` `EXCHANGE_COLOR_WORDS`). */
export const conventionWord = (c: Colors) => (c === "us" ? "綠漲紅跌(國際習慣)" : "紅漲綠跌(台股習慣)");
/** The coins' name and her pronoun in this profile (`lib/world.ts`). */
export const COIN = WORLD.currency;
export const HER = WORLD.pronoun;
export const coins = (x: number | null) => (x === null ? "—" : x >= 100 ? fmtInt(Math.round(x)) : String(Math.round(x * 100) / 100));
export const nativePrice = (l: ExchangeLine) =>
  l.price === null ? "—" : l.currency === "COIN" ? `${coins(l.price)} ${COIN}` : `${l.currency} ${l.price.toFixed(2)}`;

const WEEKDAY: Record<string, string> = { Sun: "日", Mon: "一", Tue: "二", Wed: "三", Thu: "四", Fri: "五", Sat: "六" };
const TAIPEI = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** `11/24(一)09:00` on Taipei's clock (the US open with its daylight saving comes from the Core). */
export function taipeiWhen(iso: string): string {
  const p = Object.fromEntries(TAIPEI.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day}(${WEEKDAY[p.weekday ?? ""] ?? ""})${p.hour}:${p.minute}`;
}
/** When an order fills: at the next valid quote, or after the next open (Taipei time). */
export const fillsWhen = (nextOpen: string | null) =>
  nextOpen === null ? "下一筆有效報價成交" : `休市中:下一個開盤 ${taipeiWhen(nextOpen)}(台北時間)後第一筆有效報價成交,之前可以取消`;
/** A price's word: 現價, or what it is (`收盤價(11/20)・休市中`, `開盤參考價…`). */
export const priceWord = (l: ExchangeLine) => (l.basis === "quote" ? "現價" : l.basis === null ? "價格" : (l.price_note ?? "價格"));
/** Its market in words: 開盤中, or closed with the next open. */
export const marketWord = (l: ExchangeLine) => (l.open ? "開盤中" : l.next_open ? `休市・下一個開盤 ${taipeiWhen(l.next_open)}` : "休市");
/** A cap as the rules say it: `0` is none. */
export const capText = (n: number, unit = "") => (n > 0 ? `${fmtInt(n)}${unit}` : "不限");

export function useMarket() {
  const api = useApi();
  return useQuery({ queryKey: MARKET, queryFn: ({ signal }) => api.rpc.exchange.market(undefined, { signal }), refetchInterval: poll, retry });
}
export function useAccount() {
  const api = useApi();
  return useQuery({ queryKey: ACCOUNT, queryFn: ({ signal }) => api.rpc.exchange.account(undefined, { signal }), refetchInterval: poll, retry });
}
/** Their own book; `fast` while an order they just placed waits to fill. */
export function usePortfolio(fast = false) {
  const api = useApi();
  return useQuery({
    queryKey: PORTFOLIO,
    queryFn: ({ signal }) => api.rpc.exchange.portfolio(undefined, { signal }),
    refetchInterval: (q) => (q.state.error ? false : fast ? 5_000 : POLL_MS),
    retry,
  });
}

/** After anything that moves coins or holdings: everything here, and the wallet. */
export function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ROOT });
    void client.invalidateQueries({ queryKey: WALLET });
  };
}

/** A media query, read again when it changes (`false` where there is no `matchMedia`). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}
/** Wide enough for the order panel beside the chart (Tailwind's `lg`). */
export const WIDE = "(min-width: 1024px)";

export function Loaded<T>({ query, rows = 3, children }: { query: UseQueryResult<T>; rows?: number; children: (data: T) => ReactNode }) {
  if (query.isPending) return <SkeletonRows count={rows} />;
  if (query.isError) return <ErrorLine error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

export function Fact({ label, children, className, wrap = false }: { label: string; children: ReactNode; className?: string; wrap?: boolean }) {
  return (
    <div className={`grid min-w-0 content-start gap-0.5 ${className ?? ""}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 text-sm font-medium tabular-nums ${wrap ? "" : "truncate"}`}>{children}</dd>
    </div>
  );
}

export function Move({ value, colors }: { value: number | null; colors: Colors }) {
  const color = value === null || value === 0 ? undefined : value > 0 ? upColor(colors) : downColor(colors);
  return (
    <span className="tabular-nums font-medium" style={color ? { color } : undefined}>
      {change(value)}
    </span>
  );
}

/** A gain or loss in coins and in percent of what it stands on: `▲ +120(+6.0%)`. */
export function Gain({ amount, base, colors, className }: { amount: number | null; base: number | null; colors: Colors; className?: string }) {
  const whole = amount === null ? 0 : Math.round(amount);
  const color = whole > 0 ? upColor(colors) : whole < 0 ? downColor(colors) : undefined;
  const pct = amount !== null && base !== null && base > 0 ? amount / base : null;
  return (
    <span className={`tabular-nums font-medium ${className ?? ""}`} style={color ? { color } : undefined}>
      {signed(amount)}
      {pct !== null && <span className="font-normal">{`(${change(pct).replace(/^[▲▼] /, "")})`}</span>}
    </span>
  );
}

export function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
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

/** The small print at the end of every section. */
export function SmallPrint({ m, real = true, leverage = false }: { m: ExchangeMarket; real?: boolean; leverage?: boolean }) {
  return (
    <p className="border-t border-line-soft pt-2 text-xs text-muted-foreground">
      {m.small_print.base}
      {real && m.small_print.real}
      {leverage && m.small_print.leverage}
    </p>
  );
}
