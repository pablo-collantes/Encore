import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Art } from "../components/Art";
import { ArtistLinks } from "../components/ArtistLinks";
import { Pager, SearchBox, SortToggle } from "../components/ListToolbar";
import { PageHeader } from "../components/PageHeader";
import { RLink, trackHref } from "../components/RLink";
import { ErrorState, NoData, RowsSkeleton } from "../components/States";
import { useTopTracks } from "../hooks/queries";
import { useListParams } from "../hooks/useListParams";
import { useRange } from "../hooks/useRange";
import { fmtDate, fmtDuration, fmtInt } from "../lib/format";

export default function Tracks() {
  const range = useRange();
  const list = useListParams("ms");
  const q = useTopTracks(range, { limit: list.pageSize, offset: list.offset, q: list.q || undefined, sort: list.sort });
  const items = q.data?.items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tracks"
        description={q.data ? `${fmtInt(q.data.total)} tracks · ${range.label}` : range.label}
        actions={
          <>
            <SearchBox label="Search tracks" value={list.q} onChange={(v) => list.set({ q: v })} />
            <SortToggle
              value={list.sort}
              onChange={(v) => list.set({ sort: v })}
              options={[
                { value: "ms", label: "Time" },
                { value: "plays", label: "Plays" },
                { value: "skips", label: "Skips" },
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
            <NoData title={list.q ? "No tracks match" : undefined} />
          ) : (
            <TrackTable items={items} tz={range.tz} />
          )}
          <Pager page={list.page} pageSize={list.pageSize} total={q.data?.total ?? 0} onPage={(p) => list.set({ page: p })} />
        </CardContent>
      </Card>
    </div>
  );
}

export function TrackTable({
  items,
  tz,
  showRank = true,
}: {
  items: import("@shared/api").TrackStat[];
  tz: string;
  showRank?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showRank && <TableHead className="w-10 text-right">#</TableHead>}
          <TableHead>Track</TableHead>
          <TableHead className="text-right">Time</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Plays</TableHead>
          <TableHead className="hidden text-right md:table-cell">Skips</TableHead>
          <TableHead className="hidden text-right md:table-cell" title="Energy, 0–100">
            Energy
          </TableHead>
          <TableHead className="hidden text-right lg:table-cell">Last played</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((t) => (
          <TableRow key={t.id}>
            {showRank && <TableCell className="text-right text-muted-foreground tabular">{t.rank}</TableCell>}
            <TableCell className="max-w-0 w-full">
              <div className="flex items-center gap-3">
                <Art src={t.album?.imageUrl} alt="" className="size-9" />
                <div className="min-w-0">
                  <RLink to={trackHref(t.id)} className="block truncate font-medium hover:underline underline-offset-2">
                    {t.name}
                  </RLink>
                  <ArtistLinks artists={t.artists} className="block text-xs text-muted-foreground" />
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right font-medium tabular">{fmtDuration(t.ms)}</TableCell>
            <TableCell className="hidden text-right tabular sm:table-cell">{fmtInt(t.plays)}</TableCell>
            <TableCell className="hidden text-right tabular text-muted-foreground md:table-cell">{fmtInt(t.skips)}</TableCell>
            <TableCell className="hidden text-right tabular md:table-cell">{t.energy == null ? "—" : Math.round(t.energy * 100)}</TableCell>
            <TableCell className="hidden text-right text-muted-foreground lg:table-cell">{fmtDate(t.lastTs, tz)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
