import { Fragment, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { Download } from "lucide-react";
import type { ListenRow } from "@shared/api";
import { HISTORY_MAX_ROWS } from "@shared/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ListenItem } from "../components/ListenItem";
import { SearchBox } from "../components/ListToolbar";
import { PageHeader } from "../components/PageHeader";
import { ErrorState, NoData, RowsSkeleton } from "../components/States";
import { useHistory, type HistoryFilters } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtDuration, fmtInt, fmtWeekdayDate } from "../lib/format";
import { localDateKey } from "../lib/time";

export default function History() {
  const range = useRange();
  const [search, setSearch] = useSearchParams();
  const filters: HistoryFilters = {
    q: search.get("q") || undefined,
    kind: search.get("kind") || undefined,
    source: search.get("source") || undefined,
    skipped: search.get("skipped") === "1" || undefined,
    includeDuplicates: search.get("dups") === "1" || undefined,
  };
  const setParam = (key: string, value: string | null) => {
    const s = new URLSearchParams(search);
    if (value) s.set(key, value);
    else s.delete(key);
    setSearch(s, { replace: true });
  };

  const q = useHistory(range, filters);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const capped = Boolean(q.data?.pages[q.data.pages.length - 1]?.capped);
  const groups = useMemo(() => groupByDay(rows, range.tz), [rows, range.tz]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage, groups.length]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="History"
        description={`Newest first, up to ${HISTORY_MAX_ROWS} listens · ${range.label}`}
        actions={
          <Button asChild variant="outline" size="sm">
            {/* The whole history is a download, not an endless scroll: one pass over the timeline instead of one per visit. */}
            <a href="/api/history/export" download>
              <Download aria-hidden="true" />
              Download everything (CSV)
            </a>
          </Button>
        }
      />

      <Card className="py-3">
        <CardContent className="flex flex-wrap items-center gap-3 px-3 sm:px-4">
          <SearchBox label="Search track, artist or album" value={filters.q ?? ""} onChange={(v) => setParam("q", v || null)} />
          <Select value={filters.kind ?? "all"} onValueChange={(v) => setParam("kind", v === "all" ? null : v)}>
            <SelectTrigger size="sm" className="w-36" aria-label="Type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everything</SelectItem>
              <SelectItem value="track">Music</SelectItem>
              <SelectItem value="episode">Podcasts</SelectItem>
              <SelectItem value="audiobook">Audiobooks</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.source ?? "all"} onValueChange={(v) => setParam("source", v === "all" ? null : v)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="extended">Extended history</SelectItem>
              <SelectItem value="account">Account data</SelectItem>
              <SelectItem value="live">Live collection</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Switch id="h-skipped" checked={Boolean(filters.skipped)} onCheckedChange={(c) => setParam("skipped", c ? "1" : null)} />
            <Label htmlFor="h-skipped" className="text-sm">
              Skipped only
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="h-dups" checked={Boolean(filters.includeDuplicates)} onCheckedChange={(c) => setParam("dups", c ? "1" : null)} />
            <Label htmlFor="h-dups" className="text-sm">
              Show hidden duplicates
            </Label>
          </div>
        </CardContent>
      </Card>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <Card>
          <CardContent>
            <RowsSkeleton rows={12} />
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <NoData title="No listens match" />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`day-${g.key}`}>
              <div className="sticky top-14 z-10 -mx-1 flex items-baseline justify-between gap-2 bg-background/90 px-1 py-2 backdrop-blur">
                <h2 id={`day-${g.key}`} className="text-sm font-semibold">
                  {fmtWeekdayDate(g.firstTs, range.tz)}
                </h2>
                <span className="text-xs text-muted-foreground tabular">
                  {fmtInt(g.rows.length)} {g.rows.length === 1 ? "listen" : "listens"} · {fmtDuration(g.ms)}
                </span>
              </div>
              <Card className="py-1.5">
                <CardContent className="px-1.5 sm:px-3">
                  <ul className="flex flex-col">
                    {g.rows.map((r) => (
                      <Fragment key={r.id}>
                        <ListenItem row={r} tz={range.tz} />
                      </Fragment>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </section>
          ))}
          <div ref={sentinel} className="flex justify-center py-4">
            {q.isFetchingNextPage ? (
              <Spinner />
            ) : q.hasNextPage ? (
              <Button variant="outline" size="sm" onClick={() => void q.fetchNextPage()}>
                Load more
              </Button>
            ) : capped ? (
              <span className="text-xs text-muted-foreground">
                That's the latest {HISTORY_MAX_ROWS} here.{" "}
                <a href="/api/history/export" download className="underline underline-offset-2">
                  Download everything as a CSV
                </a>{" "}
                for the rest.
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">That's everything in this range.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function groupByDay(rows: ListenRow[], tz: string) {
  const out: { key: string; firstTs: number; ms: number; rows: ListenRow[] }[] = [];
  for (const r of rows) {
    const key = localDateKey(r.ts, tz);
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, firstTs: r.ts, ms: 0, rows: [] };
      out.push(g);
    }
    g.rows.push(r);
    if (r.dupOf == null) g.ms += r.msPlayed;
  }
  return out;
}
