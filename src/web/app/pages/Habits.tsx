import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Flame, Shuffle, SkipForward, Timer, WifiOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarList } from "../components/BarList";
import { shortPlatform } from "../components/ListenItem";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/Stat";
import { ErrorState } from "../components/States";
import { useHabits } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtBucket, fmtDate, fmtDuration, fmtInt, fmtPct, fmtReason } from "../lib/format";
import { parseDateKey } from "../lib/time";

const countryNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();
const countryName = (code: string) => {
  try {
    return countryNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

const yearConfig = { hours: { label: "Hours", color: "var(--chart-1)" } } satisfies ChartConfig;
const discoveryConfig = {
  newArtists: { label: "New artists", color: "var(--chart-1)" },
  newTracks: { label: "New tracks", color: "var(--chart-3)" },
} satisfies ChartConfig;

function fmtDayKey(key: string): string {
  const p = parseDateKey(key);
  return p ? fmtDate(Date.UTC(p.year, p.month - 1, p.day, 12), "UTC") : key;
}

export default function Habits() {
  const range = useRange();
  const q = useHabits(range);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isPending)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );

  const h = q.data;
  const detailed = h.detailedCoverage > 0;
  const years = [...h.byYear].sort((a, b) => a.year - b.year);

  return (
    <div className="space-y-6">
      <PageHeader title="Habits" description={range.label} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Longest streak"
          icon={<Flame />}
          value={h.streaks.longest ? `${fmtInt(h.streaks.longest.days)} days` : "—"}
          sub={h.streaks.longest && `${fmtDayKey(h.streaks.longest.from)} – ${fmtDayKey(h.streaks.longest.to)}`}
        />
        <StatCard
          label="Current streak"
          icon={<Flame />}
          value={h.streaks.current ? `${fmtInt(h.streaks.current.days)} days` : "—"}
          sub={h.streaks.current ? `Since ${fmtDayKey(h.streaks.current.from)}` : "Listen today to start one"}
        />
        <StatCard
          label="Listening sessions"
          icon={<Timer />}
          value={fmtInt(h.sessions.count)}
          sub={h.sessions.count > 0 ? `${fmtDuration(h.sessions.avgMs)} on average` : undefined}
        />
        <StatCard
          label="Longest session"
          icon={<Timer />}
          value={h.sessions.longest ? fmtDuration(h.sessions.longest.ms) : "—"}
          sub={h.sessions.longest && fmtDate(h.sessions.longest.start, range.tz)}
        />
        <StatCard label="Skip rate" icon={<SkipForward />} value={fmtPct(h.skipRate)} sub="Streams you skipped" />
        <StatCard label="On shuffle" icon={<Shuffle />} value={fmtPct(h.shuffleShare)} sub="Share of streams" />
        <StatCard label="Offline" icon={<WifiOff />} value={fmtPct(h.offlineShare)} sub="Played from downloads" />
        <StatCard label="Detailed data" value={fmtPct(h.detailedCoverage)} sub="of listening has device & skip info" />
      </div>

      {!detailed && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          Devices, countries, shuffle, skips and why plays started or ended only come from <span className="text-foreground">Extended streaming history</span>{" "}
          imports. Live collection and Account data don't include them.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Year by year</CardTitle>
            <CardDescription>Hours listened per calendar year</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-2 sm:px-6">
            {years.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data.</p>
            ) : (
              <>
                <ChartContainer config={yearConfig} className="aspect-auto h-48 w-full">
                  <BarChart data={years.map((y) => ({ year: String(y.year), hours: y.ms / 3_600_000, ms: y.ms }))} margin={{ left: 0, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="year" tickLine={false} axisLine={false} />
                    <YAxis width={40} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${fmtInt(v)}h`} />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          hideIndicator
                          formatter={(_v, _n, item) => <span className="font-mono tabular">{fmtDuration((item.payload as { ms: number }).ms)}</span>}
                        />
                      }
                    />
                    <Bar dataKey="hours" fill="var(--color-hours)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ChartContainer>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Year</TableHead>
                      <TableHead className="text-right">Time</TableHead>
                      <TableHead className="text-right">Plays</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Artists</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Tracks</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...years].reverse().map((y) => (
                      <TableRow key={y.year}>
                        <TableCell className="font-medium tabular">{y.year}</TableCell>
                        <TableCell className="text-right tabular">{fmtDuration(y.ms)}</TableCell>
                        <TableCell className="text-right tabular">{fmtInt(y.plays)}</TableCell>
                        <TableCell className="hidden text-right tabular sm:table-cell">{fmtInt(y.artists)}</TableCell>
                        <TableCell className="hidden text-right tabular sm:table-cell">{fmtInt(y.tracks)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Discoveries</CardTitle>
            <CardDescription>Artists and tracks you heard for the first time ever</CardDescription>
          </CardHeader>
          <CardContent className="px-2 sm:px-6">
            <ChartContainer config={discoveryConfig} className="aspect-auto h-72 w-full">
              <BarChart data={h.discoveries} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={24} tickFormatter={(t: string) => fmtBucket(t, h.bucket)} />
                <YAxis width={36} tickLine={false} axisLine={false} />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, p) => {
                        const t = p?.[0]?.payload?.t as string | undefined;
                        return t ? fmtBucket(t, h.bucket, true) : "";
                      }}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="newTracks" fill="var(--color-newTracks)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="newArtists" fill="var(--color-newArtists)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Devices & platforms</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              format={fmtDuration}
              empty="No device data in this range."
              items={h.platforms.slice(0, 12).map((p) => ({
                key: p.name,
                label: <span title={p.name}>{shortPlatform(p.name)}</span>,
                value: p.ms,
                extra: `${fmtInt(p.streams)} streams`,
              }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Countries</CardTitle>
            <CardDescription>Where you were connected from</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList
              format={fmtDuration}
              color="bg-chart-2"
              empty="No country data in this range."
              items={h.countries.slice(0, 12).map((c) => ({ key: c.code, label: countryName(c.code), value: c.ms, extra: c.code }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>How plays started</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              format={fmtInt}
              color="bg-chart-3"
              empty="No data in this range."
              items={h.reasonsStart.slice(0, 10).map((r) => ({ key: r.reason, label: fmtReason(r.reason), value: r.streams }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>How plays ended</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              format={fmtInt}
              color="bg-chart-4"
              empty="No data in this range."
              items={h.reasonsEnd.slice(0, 10).map((r) => ({ key: r.reason, label: fmtReason(r.reason), value: r.streams }))}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
