// Economy 2.0 on the member page (docs/design/v5-architecture.md §9.4): today's three quests in the
// rail. Everything is what `/api/member/quests` answers. Nothing here ticks a quest: a game, a song
// or she does. A Core without the route or the economy leaves the block out, and someone she does
// not know gets no quests (the wallet already says why).

import { useQuery } from "@tanstack/react-query";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtInt } from "@/lib/format";

export const QUESTS = ["member", "quests"] as const;
const POLL_MS = 60_000;

/** An older Core has no such route, and a stopped module stays stopped: asking again will not change either. */
const gone = (e: unknown) => isNotProvided(e) || (isApiError(e) && e.kind === "unavailable");

export function useQuests() {
  const api = useApi();
  return useQuery({
    queryKey: QUESTS,
    queryFn: ({ signal }) => api.rpc.wallet.quests(undefined, { signal }),
    refetchInterval: (q) => (q.state.error ? false : POLL_MS),
    retry: (n, e) => !gone(e) && n < 2,
  });
}

const OPEN_DOT = "[&>span]:bg-transparent [&>span]:ring-[1.5px] [&>span]:ring-inset [&>span]:ring-muted-foreground/70";

/** Today's three quests: what each is, how it gets done, and what they paid. */
export function QuestsCard() {
  const q = useQuests();
  if (q.isError && gone(q.error)) return null;
  if (q.isSuccess && q.data.quests.length === 0) return null;
  return (
    <Card aria-label="今天的任務">
      <CardHeader>
        <CardTitle>今天的任務</CardTitle>
      </CardHeader>
      {q.isPending ? (
        <SkeletonRows count={3} />
      ) : q.isError ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <ul className="divide-y divide-line-soft">
            {q.data.quests.map((x) => (
              <li key={x.id} className="flex items-start gap-3 py-(--row-y)">
                <Dot tone={x.done ? "success" : "neutral"} className={x.done ? "mt-1.5" : `mt-1.5 ${OPEN_DOT}`} />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className={x.done ? "text-sm text-muted-foreground" : "text-sm"}>{x.label}</span>
                  <span className="text-xs text-muted-foreground">{x.hint}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{x.done ? "完成" : `+${fmtInt(q.data.reward)}`}</span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            三個都完成再加 {fmtInt(q.data.bonus)}
            {q.data.bonus_done ? "(已拿到)" : ""} · 今天 {fmtInt(q.data.earned_today)} / {fmtInt(q.data.cap)} {q.data.currency}
          </p>
        </>
      )}
    </Card>
  );
}
