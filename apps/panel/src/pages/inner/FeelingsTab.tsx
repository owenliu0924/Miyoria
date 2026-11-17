import { Link } from "@tanstack/react-router";
import type { SelfView } from "@miyoria/contracts/api";
import { EmptyLine } from "@/components/query-state";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { PersonCards } from "./PersonCards";

export function FeelingsTab({ self }: { self: SelfView }) {
  return (
    <div className="grid gap-(--stage-gap)">
      <PersonCards />
      <FeelingNotes self={self} />
    </div>
  );
}

/** Her impression of each person, from their heart row. */
function FeelingNotes({ self }: { self: SelfView }) {
  return (
    <Card>
      {self.feelings.length === 0 ? (
        <EmptyLine>還沒有對任何人的印象</EmptyLine>
      ) : (
        <Table aria-label="感情">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-40">人</TableHead>
              <TableHead>她的感覺</TableHead>
              <TableHead className="w-24">更新</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {self.feelings.map((f) => (
              <TableRow key={f.person}>
                <TableCell className="align-top">
                  <Link
                    to="/character"
                    search={{ tab: "people", person: f.person }}
                    className="rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {f.display_name ?? <span className="font-mono text-xs">{f.person}</span>}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[60ch] whitespace-pre-wrap leading-relaxed">{f.text}</TableCell>
                <TableCell className="align-top text-muted-foreground">
                  <time dateTime={f.updated_at} title={fmtDateTime(f.updated_at)} className="whitespace-nowrap">
                    {fmtRelative(f.updated_at)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
