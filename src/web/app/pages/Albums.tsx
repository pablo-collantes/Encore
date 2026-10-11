import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Art } from "../components/Art";
import { ArtistLinks } from "../components/ArtistLinks";
import { Pager, SearchBox, SortToggle } from "../components/ListToolbar";
import { PageHeader } from "../components/PageHeader";
import { albumHref, RLink } from "../components/RLink";
import { ErrorState, NoData } from "../components/States";
import { useTopAlbums } from "../hooks/queries";
import { useListParams } from "../hooks/useListParams";
import { useRange } from "../hooks/useRange";
import { fmtDuration, fmtInt } from "../lib/format";

export default function Albums() {
  const range = useRange();
  const list = useListParams("ms", 48);
  const q = useTopAlbums(range, { limit: list.pageSize, offset: list.offset, q: list.q || undefined, sort: list.sort });
  const items = q.data?.items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Albums"
        description={q.data ? `${fmtInt(q.data.total)} albums · ${range.label}` : range.label}
        actions={
          <>
            <SearchBox label="Search albums" value={list.q} onChange={(v) => list.set({ q: v })} />
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
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <NoData title={list.q ? "No albums match" : undefined} />
      ) : (
        <ol className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {items.map((a) => (
            <li key={a.id}>
              <Card className="h-full gap-0 overflow-hidden p-0 transition-colors hover:bg-muted/40">
                <RLink to={albumHref(a.id)} className="relative block" aria-label={a.name}>
                  <Art src={a.imageUrl} alt="" kind="album" className="w-full rounded-none" />
                  <span className="absolute top-2 left-2 rounded-md bg-background/80 px-1.5 py-0.5 text-xs font-semibold backdrop-blur tabular">
                    {a.rank}
                  </span>
                </RLink>
                <CardContent className="space-y-0.5 p-3">
                  <RLink to={albumHref(a.id)} className="block truncate text-sm font-medium hover:underline underline-offset-2">
                    {a.name}
                  </RLink>
                  <ArtistLinks artists={a.artists} className="block text-xs text-muted-foreground" max={2} />
                  <div className="pt-1 text-xs text-muted-foreground tabular">
                    <span className="font-medium text-foreground">{fmtDuration(a.ms)}</span> · {fmtInt(a.plays)} plays
                    {a.releaseYear ? ` · ${a.releaseYear}` : ""}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      )}
      <Pager page={list.page} pageSize={list.pageSize} total={q.data?.total ?? 0} onPage={(p) => list.set({ page: p })} />
    </div>
  );
}
