import { FlaskConical, Pause, Play, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { LlmKeyRow, LlmProviderKeyList } from "@miyoria/contracts/api";
import { useLlmKeyMutations, useLlmKeys } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions } from "@/components/controls";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtTime } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { ERROR_LABEL, KEY_STATE_TONE } from "./labels";

type Breaker = Pick<LlmKeyRow, "state" | "until">;

export function keyStateText(k: Breaker): string {
  switch (k.state) {
    case "ok":
      return "正常";
    case "disabled":
      return "停用";
    case "bad":
      return k.until ? `無效,${fmtTime(k.until)} 再試` : "無效,下一次呼叫再試";
    case "cooling":
      return k.until ? `冷卻到 ${fmtTime(k.until)}` : "試探中";
  }
}

const keyName = (k: LlmKeyRow) => (k.position === null ? (k.label ?? "停用的金鑰") : `#${k.position}`);

function AddKeyDialog({ provider, onClose }: { provider: string; onClose: () => void }) {
  const { add } = useLlmKeyMutations();
  const id = useId();
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const submit = () =>
    add.mutate(
      { provider, key, label: label.trim() || null },
      {
        onSuccess: (row) => {
          notify.ok(`已加入 ${provider} #${row.position}`);
          onClose();
        },
        onError: (e) => notify.error(e, "加不進去"),
      },
    );
  return (
    <Dialog open onOpenChange={(o) => !o && !add.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增 {provider} 的金鑰</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="金鑰" htmlFor={`${id}-k`}>
            <Input
              id={`${id}-k`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <Field label="名稱" htmlFor={`${id}-l`}>
            <Input id={`${id}-l`} autoComplete="off" maxLength={40} placeholder="例如:朋友的訂閱" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <p className="text-[13px] text-muted-foreground">存進去之後看不到原文,只會顯示位置、名稱和末四碼。下一個請求就會開始輪流用。</p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={add.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={add.isPending} disabled={key === ""}>
              新增
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KeyTable({ p, onDelete }: { p: LlmProviderKeyList; onDelete: (k: LlmKeyRow) => void }) {
  const { setDisabled, test } = useLlmKeyMutations();
  const r = "text-right tabular-nums";
  const runTest = (k: LlmKeyRow) =>
    test.mutate(
      { provider: p.provider, id: k.id },
      {
        onSuccess: (t) => {
          if (t.ok) notify.ok(`${p.provider} ${keyName(k)} 可以用(${t.model},${Math.round(t.ms)} ms)`);
          else notify.warn(`${p.provider} ${keyName(k)} 測試失敗:${t.kind ? (ERROR_LABEL[t.kind] ?? t.kind) : "錯誤"}${t.status !== null ? `(HTTP ${t.status})` : ""}`);
        },
        onError: (e) => notify.error(e, "測試不了"),
      },
    );
  const toggle = (k: LlmKeyRow) =>
    setDisabled.mutate(
      { provider: p.provider, id: k.id, disabled: k.state !== "disabled" },
      { onError: (e) => notify.error(e, k.state === "disabled" ? "啟用失敗" : "停用失敗") },
    );
  return (
    <Table aria-label={`${p.provider} 的金鑰`}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-14">位置</TableHead>
          <TableHead>名稱</TableHead>
          <TableHead>狀態</TableHead>
          <TableHead className="hidden md:table-cell">上次失敗</TableHead>
          <TableHead className="hidden sm:table-cell">加入時間</TableHead>
          <TableHead className={cn(r, "hidden sm:table-cell")}>末四碼</TableHead>
          <TableHead className="w-12 text-right">
            <span className="sr-only">動作</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {p.keys.map((k) => (
          <TableRow key={k.id}>
            <TableCell className="font-mono text-[12px]">{k.position === null ? "—" : `#${k.position}`}</TableCell>
            <TableCell className="max-w-48">
              <span className="flex items-center gap-2">
                <span className={cn("truncate", k.label === null && "text-muted-foreground")}>{k.label ?? "—"}</span>
                {k.source === "config" && <Badge variant="outline">設定檔</Badge>}
              </span>
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5">
                <Dot tone={KEY_STATE_TONE[k.state]} />
                <span className={cn(k.state !== "ok" && k.state !== "disabled" && "text-primary", k.state === "disabled" && "text-muted-foreground")}>{keyStateText(k)}</span>
              </span>
            </TableCell>
            <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
              {k.last_error ? `${ERROR_LABEL[k.last_error] ?? k.last_error}${k.last_error_at ? ` · ${fmtTime(k.last_error_at)}` : ""}` : "—"}
            </TableCell>
            <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{k.added_at ? fmtDateTime(k.added_at) : "設定檔"}</TableCell>
            <TableCell className={cn(r, "hidden font-mono text-[12px] text-muted-foreground sm:table-cell")}>{k.hint ?? "—"}</TableCell>
            <TableCell className="text-right">
              <RowActions label={`${p.provider} ${keyName(k)} 的動作`}>
                <DropdownMenuItem disabled={p.test_model === null || test.isPending} onSelect={() => runTest(k)}>
                  <FlaskConical />
                  測試
                </DropdownMenuItem>
                {k.source === "panel" && p.editable && (
                  <>
                    <DropdownMenuItem onSelect={() => toggle(k)}>
                      {k.state === "disabled" ? <Play /> : <Pause />}
                      {k.state === "disabled" ? "啟用" : "停用"}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => onDelete(k)}>
                      <Trash2 />
                      刪除
                    </DropdownMenuItem>
                  </>
                )}
              </RowActions>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Each provider's API keys: the config file's (read-only) and the ones added here, with what the
 * breaker knows of each. Adding, disabling and deleting take effect at the next request.
 */
export function ProviderKeysCard() {
  const keys = useLlmKeys();
  const { remove } = useLlmKeyMutations();
  const [adding, setAdding] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ provider: string; key: LlmKeyRow } | null>(null);
  const providers = keys.data?.providers ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>供應商與金鑰</CardTitle>
      </CardHeader>
      {keys.isPending ? (
        <SkeletonRows />
      ) : keys.isError ? (
        <ErrorLine error={keys.error} onRetry={() => void keys.refetch()} />
      ) : providers.length === 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">沒有設定供應商</p>
      ) : (
        <div className="grid gap-6">
          {providers.map((p) => (
            <section key={p.provider} aria-label={p.provider} className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <code className="text-[13px]">{p.provider}</code>
                  {p.breaker && (
                    <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                      <Dot tone={KEY_STATE_TONE[p.breaker.state]} />
                      不用金鑰 · {keyStateText(p.breaker)}
                    </span>
                  )}
                </h3>
                {p.editable && (
                  <Button writes size="sm" variant="outline" onClick={() => setAdding(p.provider)}>
                    <Plus />
                    新增金鑰
                  </Button>
                )}
              </div>
              {p.keys.length > 0 && <KeyTable p={p} onDelete={(key) => setDeleting({ provider: p.provider, key })} />}
            </section>
          ))}
        </div>
      )}
      {adding !== null && <AddKeyDialog provider={adding} onClose={() => setAdding(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `刪除 ${deleting.provider} 的「${deleting.key.label ?? keyName(deleting.key)}」?` : ""}
        confirmLabel="刪除"
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          remove.mutate(
            { provider: deleting.provider, id: deleting.key.id },
            {
              onSuccess: () => {
                notify.ok("已刪除");
                setDeleting(null);
              },
              onError: (e) => notify.error(e, "刪除失敗"),
            },
          )
        }
      >
        下一個請求起就不再用這把金鑰,刪掉之後要重新貼上才能再用。
      </ConfirmDialog>
    </Card>
  );
}
