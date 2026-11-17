import { Link } from "@tanstack/react-router";
import type { PersonCard } from "@miyoria/contracts/api";
import { useAffectPeople } from "@/app/queries";
import { BondBar, Meter, StatusBadge, type Tone } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";

/**
 * The tone of a tier: the two names for someone she dislikes, the two before 朋友, 朋友 and 好朋友,
 * and every closer tier. The names come from the API (one list, in `@miyoria/types`), never a
 * copy here.
 */
export function labelTone(label: string): Tone {
  if (label === "很討厭" || label === "討厭") return "danger";
  if (label === "陌生人" || label === "認識") return "neutral";
  if (label === "朋友" || label === "好朋友") return "success";
  return "brand";
}

/** How she acts with them, one line she wrote in her reflection; `null`: none yet. */
export function stanceText(card: Pick<PersonCard, "stance">): string | null {
  return card.stance?.trim() || null;
}

function Gauge({ children, label, value }: { children: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <Meter value={value} tone="brand" label={label} />
      <span className="font-mono text-xs tabular-nums">{children}</span>
    </div>
  );
}

/**
 * One card per person with a heart row: how she feels about them (the numbers, the label and
 * level, her words and how she acts with them).
 */
export function PersonCards() {
  const cards = useAffectPeople();
  if (cards.isPending || cards.isError) return null;
  const list = cards.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>人物卡</CardTitle>
        <span className="text-sm text-muted-foreground tabular-nums">{list.length}</span>
      </CardHeader>
      {list.length === 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">還沒有任何人物卡</p>
      ) : (
        <Table aria-label="人物卡">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-36">人</TableHead>
              <TableHead className="hidden w-28 md:table-cell">羈絆</TableHead>
              <TableHead className="hidden w-24 lg:table-cell">信任</TableHead>
              <TableHead className="hidden w-24 lg:table-cell">熟悉</TableHead>
              <TableHead>她的感覺</TableHead>
              <TableHead className="w-24">最後見到</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((c) => {
              const stance = stanceText(c);
              return (
                <TableRow key={c.person}>
                  <TableCell className="align-top">
                    <span className="grid gap-1">
                      <Link
                        to="/character"
                        search={{ tab: "people", person: c.person }}
                        className="w-fit rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {c.call_name ?? c.handle}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusBadge tone={labelTone(c.label)}>{c.label}</StatusBadge>
                        {typeof c.level === "number" && (
                          <Badge variant="outline" className="font-mono tabular-nums" title="羈絆等級(每 1 點一級,上限 1000)">
                            Lv.{c.level}
                          </Badge>
                        )}
                        {c.owner && <Badge variant="brand">主人</Badge>}
                        {c.blocked && <Badge variant="destructive">封鎖</Badge>}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden align-top md:table-cell">
                    <div className="flex items-center gap-2">
                      <BondBar value={c.affinity} label={`${c.handle} 羈絆 ${c.affinity}`} />
                      <span className="w-8 text-right font-mono text-xs tabular-nums">{Math.round(c.affinity)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden align-top lg:table-cell">
                    <Gauge label={`${c.handle} 信任 ${Math.round(c.trust)}`} value={c.trust / 100}>
                      {String(Math.round(c.trust))}
                    </Gauge>
                  </TableCell>
                  <TableCell className="hidden align-top lg:table-cell">
                    <Gauge label={`${c.handle} 熟悉 ${Math.round(c.familiarity)}`} value={c.familiarity / 100}>
                      {String(Math.round(c.familiarity))}
                    </Gauge>
                  </TableCell>
                  <TableCell className="max-w-[48ch] align-top whitespace-pre-wrap leading-relaxed">
                    {c.feeling || <span className="text-muted-foreground">—</span>}
                    {stance && (
                      <span className="mt-1 block text-[13px]">
                        <span className="text-muted-foreground">相處方式:</span>
                        {stance}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground">
                    {c.last_seen ? (
                      <time dateTime={c.last_seen} title={fmtDateTime(c.last_seen)} className="whitespace-nowrap">
                        {fmtRelative(c.last_seen)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
