import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Art } from "../components/Art";
import { Pager, SearchBox, SortToggle } from "../components/ListToolbar";
import { PageHeader } from "../components/PageHeader";
import { artistHref, RLink } from "../components/RLink";
import { ErrorState, NoData, RowsSkeleton } from "../components/States";
import { useTopArtists } from "../hooks/queries";
import { useListParams } from "../hooks/useListParams";
import { useRange } from "../hooks/useRange";
import { fmtDate, fmtDuration, fmtInt } from "../lib/format";

export default function Artists() {
  const range = useRange();
  const list = useListParams("ms");
  const q = useTopArtists(range, { limit: list.pageSize, offset: list.offset, q: list.q || undefined, sort: list.sort });
  const items = q.data?.items ?? [];
  const max = Math.max(0, ...items.map((a) => a.ms));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Artists"
        description={q.data ? `${fmtInt(q.data.total)} artists · ${range.label}` : range.label}
        actions={
          <>
            <SearchBox label="Search artists" value={list.q} onChange={(v) => list.set({ q: v })} />
            <SortToggle
              value={list.sort}
              onChange={(v) => list.set({ sort: v })}
              options={[
                { value: "ms", label: "Time" },
                { value: "plays", label: "Plays" },
              ]}
            />
          </>
        }
      />
      <Card className="py-2">
        <CardContent className="px-2 sm:px-4">
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : q.isPending ? (
            <RowsSkeleton rows={10} />
          ) : items.length === 0 ? (
            <NoData title={list.q ? "No artists match" : undefined} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-right">#</TableHead>
                  <TableHead>Artist</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Plays</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Tracks</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">First heard</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Last heard</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-right text-muted-foreground tabular">{a.rank}</TableCell>
                    <TableCell className="max-w-0 w-full">
                      <div className="flex items-center gap-3">
                        <Art src={a.imageUrl} alt={a.name} kind="artist" className="size-9" />
                        <div className="min-w-0 flex-1">
                          <RLink to={artistHref(a.id)} className="block truncate font-medium hover:underline underline-offset-2">
                            {a.name}
                          </RLink>
                          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary/70" style={{ width: `${max ? (a.ms / max) * 100 : 0}%` }} />
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular">{fmtDuration(a.ms)}</TableCell>
                    <TableCell className="hidden text-right tabular sm:table-cell">{fmtInt(a.plays)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{fmtInt(a.tracks)}</TableCell>
                    <TableCell className="hidden text-right text-muted-foreground lg:table-cell">{fmtDate(a.firstTs, range.tz)}</TableCell>
                    <TableCell className="hidden text-right text-muted-foreground lg:table-cell">{fmtDate(a.lastTs, range.tz)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pager page={list.page} pageSize={list.pageSize} total={q.data?.total ?? 0} onPage={(p) => list.set({ page: p })} />
        </CardContent>
      </Card>
    </div>
  );
}
