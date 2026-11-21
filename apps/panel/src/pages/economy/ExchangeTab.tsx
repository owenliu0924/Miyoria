// 經濟 / 交易所: the deep-sea exchange as the owner sees it (docs/design/exchange.md). The state
// (`GET /api/exchange`: the vault and its rows, the level, what burned, what is owed, the rounds),
// the pause, every open position with a sale for cleanup (no fee, recorded in the audit log), and
// the parameters as they are in force, read-only: they change in 系統 / 交易所 or the file. No
// hidden value and no seed is ever sent here. The pause and the sale need `admin.economy.adjust`.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ExchangeAdmin } from "@miyoria/contracts/api";
import { isApiError } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";

const KEY = ["exchange", "admin"] as const;
const DENIED = "你的帳號沒有交易所的權限(需要 admin.economy.adjust)";
const isDenied = (e: unknown) => isApiError(e) && e.status === 403;

const STATUS: Record<string, string> = { held: "撮合", skipped: "跳過(停機)", halted: "熔斷", paused: "暫停" };

function useExchangeAdmin() {
  const api = useApi();
  return useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.rpc.exchangeAdmin.view(undefined, { signal }), refetchInterval: 60_000, retry: false });
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function State({ v }: { v: ExchangeAdmin }) {
  const books = v.vault_rows === null || v.vault_rows === v.vault ? "對得上" : `對不上(列 ${v.vault_rows})`;
  return (
    <Card aria-label="狀態">
      <CardHeader>
        <CardTitle>狀態</CardTitle>
      </CardHeader>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <Fact label="交易所">{!v.enabled ? "關(open = false)" : v.paused ? "暫停" : "開"}</Fact>
        <Fact label="FISH">{v.fish.toFixed(0)}</Fact>
        <Fact label="金庫">{fmtInt(v.vault)}</Fact>
        <Fact label="金庫的帳">{books}</Fact>
        <Fact label="持股市值">{fmtInt(Math.floor(v.obligations))}</Fact>
        <Fact label="水位">{v.level === null ? "—" : v.level.toFixed(2)}</Fact>
        <Fact label="本週燒掉">{fmtInt(v.burned_week)}</Fact>
        <Fact label="總共燒掉">{fmtInt(v.burned)}</Fact>
        <Fact label="開戶">{fmtInt(v.accounts)}</Fact>
        <Fact label="持股 / 委託">{`${v.positions} / ${v.open_orders}`}</Fact>
        <Fact label="還沒入帳">{fmtInt(v.pending_postings)}</Fact>
        <Fact label="金庫欠的">{v.owed.length === 0 ? "沒有" : v.owed.map((o) => `${o.name ?? o.person} ${o.gross}`).join("、")}</Fact>
      </dl>
    </Card>
  );
}

function Pause({ v, denied, onDenied }: { v: ExchangeAdmin; denied: boolean; onDenied: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.rpc.exchangeAdmin.pause({ body: { paused } }),
    onSuccess: (r) => {
      setOpen(false);
      notify.ok(r.paused ? `暫停了,退回 ${r.refunded} 筆委託` : "恢復了");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => {
      if (isDenied(e)) {
        onDenied();
        setOpen(false);
      }
      notify.error(e);
    },
  });
  return (
    <Card aria-label="暫停">
      <CardHeader>
        <CardTitle>暫停</CardTitle>
      </CardHeader>
      <Button variant="outline" writes disabled={denied || !v.enabled} title={denied ? DENIED : !v.enabled ? "交易所的開關關著" : undefined} className="justify-self-start" onClick={() => (v.paused ? pause.mutate(false) : setOpen(true))}>
        {v.paused ? "恢復交易" : "暫停交易"}
      </Button>
      {v.paused && v.paused_by && <p className="text-xs text-muted-foreground">{`${v.paused_by} 暫停的`}</p>}
      <ConfirmDialog open={open} title="暫停交易所" confirmLabel="暫停" busy={pause.isPending} onConfirm={() => pause.mutate(true)} onClose={() => setOpen(false)}>
        <p>暫停時不撮合、價格不動、不能下單;掛著的委託全部退回(買單連手續費)。持股和槓桿部位留著,暫停期間不會被強制賣出,也不收利息。</p>
      </ConfirmDialog>
    </Card>
  );
}

function Holders({ v, denied, onDenied }: { v: ExchangeAdmin; denied: boolean; onDenied: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
  const [note, setNote] = useState("");
  const sell = useMutation({
    mutationFn: () => api.rpc.exchangeAdmin.sell({ body: { position: target?.id ?? "", ...(note.trim() ? { note: note.trim() } : {}) } }),
    onSuccess: (r) => {
      setTarget(null);
      setNote("");
      notify.ok(`賣掉了,付給對方 ${r.paid}`);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => {
      if (isDenied(e)) {
        onDenied();
        setTarget(null);
      }
      notify.error(e);
    },
  });
  return (
    <Card aria-label="持股">
      <CardHeader>
        <CardTitle>持股</CardTitle>
      </CardHeader>
      {v.holders.length === 0 ? (
        <EmptyLine>沒有人持股</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {v.holders.flatMap((h) =>
            h.positions.map((p) => (
              <li key={p.id} className="flex items-baseline gap-3 py-(--row-y) text-sm">
                <span className="min-w-0 flex-1 truncate">{h.name ?? h.person}</span>
                <span className="w-12 shrink-0 font-mono text-[13px]">{p.code}</span>
                <span className="shrink-0 tabular-nums">{`${(p.qty / 1000).toFixed(3)} 股${p.leverage > 1 ? `・${p.leverage} 倍` : ""}・${fmtInt(Math.floor(p.leverage > 1 ? p.equity : p.value))}`}</span>
                <Button size="sm" variant="ghost" writes disabled={denied} title={denied ? DENIED : undefined} onClick={() => setTarget({ id: p.id, label: `${h.name ?? h.person} 的 ${p.code}` })}>
                  賣掉
                </Button>
              </li>
            )),
          )}
        </ul>
      )}
      <ConfirmDialog open={target !== null} title={`賣掉${target?.label ?? ""}`} confirmLabel="賣掉" busy={sell.isPending} onConfirm={() => sell.mutate()} onClose={() => setTarget(null)}>
        <div className="grid gap-2">
          <p>以最後一盤的價格馬上賣掉,不收手續費和稅,不看 T+1;錢付給持有的人。會記在稽核紀錄裡。金庫付不出來就不會賣。</p>
          <Input aria-label="為什麼" placeholder="為什麼(記在稽核紀錄)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </ConfirmDialog>
    </Card>
  );
}

function Rounds({ v }: { v: ExchangeAdmin }) {
  return (
    <Card aria-label="最近的盤">
      <CardHeader>
        <CardTitle>最近的盤</CardTitle>
      </CardHeader>
      {v.rounds.length === 0 ? (
        <EmptyLine>還沒有任何一盤</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {v.rounds.slice(0, 24).map((r) => (
            <li key={r.round} className="flex items-baseline gap-3 py-(--row-y) text-sm">
              <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{fmtDateTime(r.at)}</span>
              <span className="w-20 shrink-0">{STATUS[r.status] ?? r.status}</span>
              <span className="min-w-0 flex-1 truncate tabular-nums">{`FISH ${r.fish.toFixed(0)}・水位 ${r.level === null ? "—" : r.level.toFixed(2)}`}</span>
              <span className="shrink-0 tabular-nums">{`成交 ${fmtInt(r.volume)}・燒 ${fmtInt(r.burned)}・金庫 ${fmtInt(r.vault)}`}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Params({ v }: { v: ExchangeAdmin }) {
  return (
    <Card aria-label="參數">
      <CardHeader>
        <CardTitle>參數</CardTitle>
      </CardHeader>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        {Object.entries(v.params).map(([k, value]) => (
          <div key={k} className="grid min-w-0 gap-0.5">
            <dt className="truncate font-mono text-xs text-muted-foreground">{k}</dt>
            <dd className="truncate text-sm tabular-nums">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** The state, the pause, the holdings with a sale, the rounds, the parameters. */
export function ExchangeTab() {
  const q = useExchangeAdmin();
  const [denied, setDenied] = useState(false);
  return (
    <ModuleQuery query={q} module="交易所(exchange 模組)">
      {(v) => (
        <div className="grid gap-(--stage-gap)">
          <State v={v} />
          <div className="grid items-start gap-(--stage-gap) lg:grid-cols-2">
            <Pause v={v} denied={denied} onDenied={() => setDenied(true)} />
            <Holders v={v} denied={denied} onDenied={() => setDenied(true)} />
          </div>
          <Rounds v={v} />
          <Params v={v} />
        </div>
      )}
    </ModuleQuery>
  );
}
