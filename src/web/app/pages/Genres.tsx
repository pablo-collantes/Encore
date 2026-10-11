import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useSearchParams } from "react-router";
import type { Bucket, GenreSource } from "@shared/api";
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/components/ui/avatar";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BucketToggle } from "../components/BucketToggle";
import { GenreDonut, SERIES_COLORS } from "../components/GenreDonut";
import { SortToggle } from "../components/ListToolbar";
import { PageHeader } from "../components/PageHeader";
import { artistHref, RLink } from "../components/RLink";
import { CoverageNote, ErrorState, NoData, RowsSkeleton } from "../components/States";
import { useGenreTimeline, useTopGenres } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmt1, fmtBucket, fmtDuration, fmtInt, fmtPct, hours, initials } from "../lib/format";

export default function Genres() {
  const range = useRange();
  const [search, setSearch] = useSearchParams();
  const source: GenreSource = search.get("source") === "musicbrainz" ? "musicbrainz" : "deezer";
  const setSource = (s: string) => {
    const next = new URLSearchParams(search);
    if (s === "musicbrainz") next.set("source", s);
    else next.delete("source");
    setSearch(next, { replace: true });
  };
  const genres = useTopGenres(range, source, 40);
  const items = genres.data?.items ?? [];
  const total = items.reduce((s, g) => s + g.ms, 0);
  const max = Math.max(0, ...items.map((g) => g.ms));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Genres"
        description={
          source === "deezer"
            ? "Broad genres (from Deezer's album genres), split evenly across a track's genres."
            : "Detailed genres from MusicBrainz, attributed through each artist."
        }
        actions={
          <SortToggle
            value={source}
            onChange={setSource}
            options={[
              { value: "deezer", label: "Broad" },
              { value: "musicbrainz", label: "Detailed" },
            ]}
          />
        }
      />

      {genres.isError ? (
        <ErrorState error={genres.error} onRetry={() => genres.refetch()} />
      ) : genres.isPending ? (
        <RowsSkeleton rows={8} art={false} />
      ) : items.length === 0 ? (
        <NoData
          title="No genres yet"
          description="Genres are looked up in the background after listening is collected or imported. Check back in a little while."
        />
      ) : (
        <>
          <CoverageNote share={genres.data.coverage} what="Genres" />
          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Ranking</CardTitle>
                <CardDescription>{range.label}</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3">
                  {items.map((g, i) => (
                    <li key={g.genre} className="flex items-center gap-3">
                      <span className="w-6 shrink-0 text-right text-sm text-muted-foreground tabular">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium capitalize">{g.genre}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular">
                            {fmtPct(total ? g.ms / total : 0)} · <span className="font-medium text-foreground">{fmtDuration(g.ms)}</span>
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-3">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${max ? (g.ms / max) * 100 : 0}%`, background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                            />
                          </div>
                          <AvatarGroup className="hidden sm:flex">
                            {g.topArtists.slice(0, 4).map((a) => (
                              <RLink key={a.id} to={artistHref(a.id)} title={a.name}>
                                <Avatar className="size-6">
                                  {a.imageUrl && <AvatarImage src={a.imageUrl} alt={a.name} />}
                                  <AvatarFallback className="text-[9px]">{initials(a.name)}</AvatarFallback>
                                </Avatar>
                              </RLink>
                            ))}
                          </AvatarGroup>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {fmtInt(g.plays)} plays · {fmtInt(g.artists)} artists
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2 lg:self-start">
              <CardHeader>
                <CardTitle>Share of listening</CardTitle>
              </CardHeader>
              <CardContent>
                <GenreDonut items={items} top={8} />
              </CardContent>
            </Card>
          </div>
          <GenreTimeline source={source} />
        </>
      )}
    </div>
  );
}

function GenreTimeline({ source }: { source: GenreSource }) {
  const range = useRange();
  const [override, setOverride] = useState<Bucket | null>(null);
  const [mode, setMode] = useState<"share" | "hours">("share");
  const bucket = override ?? (range.bucket === "day" ? "week" : range.bucket);
  const q = useGenreTimeline(range, source, bucket, 8);
  const genres = q.data?.genres ?? [];
  const config: ChartConfig = Object.fromEntries([
    ...genres.map((g, i) => [`g${i}`, { label: g, color: SERIES_COLORS[i % SERIES_COLORS.length]! }]),
    ["other", { label: "Other", color: "var(--muted-foreground)" }],
  ]);
  const data = (q.data?.points ?? []).map((p) => {
    const row: Record<string, number | string> = { t: p.t };
    genres.forEach((g, i) => {
      row[`g${i}`] = hours(p.values[g] ?? 0);
    });
    row.other = hours(p.otherMs);
    return row;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Genres over time</CardTitle>
        <CardDescription>Top {genres.length || 8} genres, everything else as “Other”</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-2">
          <ToggleGroup type="single" size="sm" variant="outline" spacing={0} value={mode} onValueChange={(v) => v && setMode(v as "share" | "hours")} aria-label="Scale">
            <ToggleGroupItem value="share" className="px-2.5 text-xs">
              Share
            </ToggleGroupItem>
            <ToggleGroupItem value="hours" className="px-2.5 text-xs">
              Hours
            </ToggleGroupItem>
          </ToggleGroup>
          <BucketToggle value={bucket} onChange={setOverride} />
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isPending ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <ChartContainer config={config} className="aspect-auto h-72 w-full">
            <AreaChart data={data} stackOffset={mode === "share" ? "expand" : "none"} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={(t: string) => fmtBucket(t, bucket)} />
              <YAxis
                width={40}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (mode === "share" ? `${Math.round(v * 100)}%` : `${fmt1(v)}h`)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(_, payload) => {
                      const t = payload?.[0]?.payload?.t as string | undefined;
                      return t ? fmtBucket(t, bucket, true) : "";
                    }}
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="capitalize text-muted-foreground">{config[String(name)]?.label}</span>
                        <span className="font-mono tabular">{fmtDuration(Number(value) * 3_600_000)}</span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {[...genres.map((_, i) => `g${i}`), "other"].map((k) => (
                <Area key={k} dataKey={k} type="monotone" stackId="1" stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.55} />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
