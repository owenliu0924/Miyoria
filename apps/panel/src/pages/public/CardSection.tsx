import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Share2, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import type { IssuedCard, WalletView } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { cardFileName, cardPng, verifyUrl } from "./card";
import { HoloCard } from "./HoloCard";

const CARDS = ["member", "cards"] as const;
const WALLET = ["member", "wallet"] as const;

/** One fresh key per click: a retry of the same request is charged once. */
function newKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A choice that is on or off. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-7 rounded-md border px-2.5 text-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        on ? "border-primary bg-primary/15 text-foreground" : "border-border bg-control text-muted-foreground hover:bg-control-hover",
      )}
    >
      {children}
    </button>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Share sheet with the picture where the browser has one; otherwise the link to the check page. */
async function share(card: IssuedCard, blob: Blob) {
  const file = new File([blob], cardFileName(card), { type: "image/png" });
  const url = verifyUrl(card.serial);
  const data = { files: [file], title: "她給我的卡", url };
  if (navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
    return;
  }
  await navigator.clipboard.writeText(url);
  notify.ok("已複製這張卡的驗證連結");
}

/** Their newest card, a new one on request (a few a day), and the ways to take it with them. */
export function CardSection() {
  const api = useApi();
  const client = useQueryClient();
  const svg = useRef<SVGSVGElement>(null);
  const cards = useQuery({ queryKey: CARDS, queryFn: ({ signal }) => api.rpc.member.cards(undefined, { signal }) });
  // What they pay for on top of the next card: a foil finish.
  const [foil, setFoil] = useState(false);
  const done = (card: IssuedCard) => {
    client.setQueryData(CARDS, (old: typeof cards.data) =>
      old ? { ...old, latest: card, today: old.today + 1 } : old,
    );
    void client.invalidateQueries({ queryKey: CARDS });
    void client.invalidateQueries({ queryKey: WALLET });
  };
  const issue = useMutation({
    // A daily card is paid (the first of the day too), so every click carries its own key.
    mutationFn: () =>
      api.rpc.member.issueCard({ body: foil ? { foil: true } : {}, headers: { "idempotency-key": newKey() } }),
    onSuccess: (card) => {
      setFoil(false);
      done(card);
    },
    onError: (e) => notify.error(e),
  });
  const currency = client.getQueryData<WalletView>(WALLET)?.currency ?? "幣";
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const run = async (what: "download" | "share", card: IssuedCard) => {
    if (!svg.current) return;
    setBusy(what);
    try {
      const blob = await cardPng(svg.current);
      if (what === "download") download(blob, cardFileName(card));
      else await share(card, blob);
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card aria-label="她給你的卡">
      <CardHeader>
        <CardTitle>她給你的卡</CardTitle>
      </CardHeader>
      <QueryView query={cards} skeleton={<SkeletonRows count={3} />}>
        {(c) => {
          const left = Math.max(0, c.per_day - c.today);
          const prices = c.prices ?? { card: null, foil: null };
          const cost = (prices.card ?? 0) + (foil ? (prices.foil ?? 0) : 0);
          return (
            <div className="grid gap-3">
              {c.latest ? (
                <HoloCard card={c.latest} svgRef={svg} sway={false} zoom={1.03} />
              ) : (
                <EmptyLine>還沒有卡,抽一張看看她怎麼看你</EmptyLine>
              )}
              {left > 0 && prices.foil !== null && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    閃卡加工 · 另付 {prices.foil} {currency}
                  </p>
                  <Chip on={foil} onClick={() => setFoil(!foil)}>
                    閃卡
                  </Chip>
                </div>
              )}
              <Button busy={issue.isPending} disabled={left === 0} onClick={() => issue.mutate()}>
                <Sparkles aria-hidden />
                {left === 0
                  ? "今天的卡抽完了"
                  : `抽一張新卡(今天還有 ${left} 張${cost > 0 ? `,${cost} ${currency}` : ""})`}
              </Button>
              {c.latest && (
                <Button asChild variant="outline">
                  <a href={verifyUrl(c.latest.serial)} target="_blank" rel="noopener">
                    <ExternalLink aria-hidden />
                    打開數位卡面
                  </a>
                </Button>
              )}
              {c.latest && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    busy={busy === "download"}
                    onClick={() => c.latest && void run("download", c.latest)}
                  >
                    <Download aria-hidden />
                    下載
                  </Button>
                  <Button
                    variant="outline"
                    busy={busy === "share"}
                    onClick={() => c.latest && void run("share", c.latest)}
                  >
                    <Share2 aria-hidden />
                    分享
                  </Button>
                </div>
              )}
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}
