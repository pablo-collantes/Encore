import { Mic2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Art } from "../components/Art";
import { PageHeader } from "../components/PageHeader";
import { ErrorState, NoData, RowsSkeleton } from "../components/States";
import { usePodcasts } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtDate, fmtDuration, fmtInt } from "../lib/format";

export default function Podcasts() {
  const range = useRange();
  const q = usePodcasts(range);
  const shows = q.data?.shows ?? [];
  const episodes = q.data?.episodes ?? [];
  const max = Math.max(0, ...shows.map((s) => s.ms));
  const total = shows.reduce((s, x) => s + x.ms, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Podcasts & audiobooks"
        description={q.data ? `${fmtDuration(total)} across ${fmtInt(shows.length)} shows · ${range.label}` : range.label}
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <RowsSkeleton rows={8} />
      ) : shows.length === 0 ? (
        <NoData
          icon={<Mic2 />}
          title="No podcasts in this range"
          description="Podcast listening comes from data imports and from the live player sampler."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Shows</CardTitle>
              <CardDescription>By time listened</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="space-y-1">
                {shows.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                    <span className="w-6 shrink-0 text-right text-sm text-muted-foreground tabular">{i + 1}</span>
                    <Art src={s.imageUrl} alt={s.name} kind="show" className="size-10" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{s.name}</span>
                        {s.kind === "audiobook" && (
                          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                            Audiobook
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {fmtInt(s.episodes)} episodes · last {fmtDate(s.lastTs, range.tz)}
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-chart-2" style={{ width: `${max ? (s.ms / max) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular">{fmtDuration(s.ms)}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
          <Card className="py-2">
            <CardHeader className="pt-4">
              <CardTitle>Episodes</CardTitle>
              <CardDescription>Most listened</CardDescription>
            </CardHeader>
            <CardContent className="px-2 sm:px-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Episode</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Last</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {episodes.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="max-w-0 w-full">
                        <div className="truncate font-medium">{e.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{e.show ?? "—"}</div>
                      </TableCell>
                      <TableCell className="text-right tabular">{fmtDuration(e.ms)}</TableCell>
                      <TableCell className="hidden text-right text-muted-foreground sm:table-cell">{fmtDate(e.lastTs, range.tz)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
