import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from "recharts";
import type { MoodTrack } from "@shared/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Art } from "../components/Art";
import { BarList } from "../components/BarList";
import { PageHeader } from "../components/PageHeader";
import { RLink, trackHref } from "../components/RLink";
import { StatCard } from "../components/Stat";
import { CoverageNote, ErrorState, NoData } from "../components/States";
import { useMood } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtBucket, fmtDuration, fmtInt } from "../lib/format";

const pct = (v: number | null | undefined) => (v == null ? "—" : String(Math.round(v * 100)));

export default function Mood() {
  const range = useRange();
  const q = useMood(range);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const m = q.data;
  const noFeatures = m && m.coverage === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mood & energy"
        description="How your music sounds, weighted by how long you listened. Audio features come from ReccoBeats, or are analysed from 30-second previews."
      />
      {!m ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : noFeatures ? (
        <NoData
          title="No audio features yet"
          description="Energy, happiness and tempo are looked up for each track in the background. They'll appear here as the lookups complete."
        />
      ) : (
        <>
          <CoverageNote share={m.coverage} what="Audio features" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <FeatureStat label="Energy" value={m.averages.energy} hint="Intensity and activity" />
            <FeatureStat label="Happiness" value={m.averages.valence} hint="Musical positivity (valence)" />
            <FeatureStat label="Danceability" value={m.averages.danceability} hint="How suitable for dancing" />
            <FeatureStat label="Acousticness" value={m.averages.acousticness} hint="Acoustic vs. electronic" />
            <StatCard label="Tempo" value={m.averages.tempo == null ? "—" : `${fmtInt(m.averages.tempo)} BPM`} sub="Average beats per minute" />
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Mood map</CardTitle>
                <CardDescription>Your top tracks by energy and happiness; bigger dots = more listening</CardDescription>
              </CardHeader>
              <CardContent className="px-2 sm:px-6">
                <MoodScatter tracks={m.tracks} />
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Where your listening sits</CardTitle>
                <CardDescription>Time by mood</CardDescription>
              </CardHeader>
              <CardContent>
                <BarList
                  format={fmtDuration}
                  items={[
                    { key: "energetic", label: <MoodLabel color="var(--chart-1)">Energetic & upbeat</MoodLabel>, value: m.quadrants.energetic },
                    { key: "happy", label: <MoodLabel color="var(--chart-4)">Happy & relaxed</MoodLabel>, value: m.quadrants.happy },
                    { key: "tense", label: <MoodLabel color="var(--chart-5)">Intense & dark</MoodLabel>, value: m.quadrants.tense },
                    { key: "calm", label: <MoodLabel color="var(--chart-2)">Calm & mellow</MoodLabel>, value: m.quadrants.calm },
                    { key: "sad", label: <MoodLabel color="var(--chart-3)">Sad & low</MoodLabel>, value: m.quadrants.sad },
                  ].sort((a, b) => b.value - a.value)}
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <ByHour data={m.byHour} />
            <OverTime data={m.byPeriod} bucket={m.bucket} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Histogram
              title="Energy distribution"
              description="Listening time by track energy"
              data={m.energyHistogram.map((ms, i) => ({ label: `${i * 10}–${i * 10 + 10}`, ms }))}
            />
            <Histogram
              title="Tempo"
              description="Listening time by BPM"
              data={m.tempoHistogram.map((b) => ({ label: String(b.bpm), ms: b.ms }))}
              color="var(--chart-2)"
            />
          </div>

          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            <Extremes title="Most energetic" items={m.extremes.mostEnergetic} metric="energy" />
            <Extremes title="Calmest" items={m.extremes.calmest} metric="energy" />
            <Extremes title="Happiest" items={m.extremes.happiest} metric="valence" />
            <Extremes title="Saddest" items={m.extremes.saddest} metric="valence" />
          </div>
        </>
      )}
    </div>
  );
}

function MoodLabel({ color, children }: { color: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden />
      {children}
    </span>
  );
}

function FeatureStat({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <StatCard
      label={label}
      value={
        <span>
          {pct(value)}
          <span className="ml-0.5 text-sm font-normal text-muted-foreground">/100</span>
        </span>
      }
      sub={
        <span className="block">
          <span className="mb-1 block h-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${(value ?? 0) * 100}%` }} />
          </span>
          {hint}
        </span>
      }
    />
  );
}

const scatterConfig = { tracks: { label: "Tracks", color: "var(--chart-1)" } } satisfies ChartConfig;

function MoodScatter({ tracks }: { tracks: MoodTrack[] }) {
  const data = tracks.map((t) => ({ ...t, x: t.valence, y: t.energy, z: t.ms }));
  return (
    <div className="space-y-2">
    <div className="relative">
    <ChartContainer config={scatterConfig} className="aspect-square max-h-[28rem] w-full sm:aspect-[4/3]">
      <ScatterChart margin={{ top: 12, right: 12, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          type="number"
          dataKey="x"
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          tickFormatter={(v: number) => String(Math.round(v * 100))}
          tickLine={false}
        />
        <YAxis
          type="number"
          dataKey="y"
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          width={32}
          tickFormatter={(v: number) => String(Math.round(v * 100))}
          tickLine={false}
        />
        <ZAxis type="number" dataKey="z" range={[24, 420]} />
        <ReferenceLine x={0.5} stroke="var(--border)" />
        <ReferenceLine y={0.5} stroke="var(--border)" />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            const p = active ? (payload?.[0]?.payload as (MoodTrack & { z: number }) | undefined) : undefined;
            if (!p) return null;
            return (
              <div className="flex max-w-60 items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                <Art src={p.imageUrl} alt="" className="size-8" />
                <div className="min-w-0">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="truncate text-muted-foreground">{p.artist}</div>
                  <div className="text-muted-foreground tabular">
                    Energy {pct(p.energy)} · Happiness {pct(p.valence)} · {fmtDuration(p.ms)}
                  </div>
                </div>
              </div>
            );
          }}
        />
        <Scatter data={data} fill="var(--color-tracks)" fillOpacity={0.55} stroke="var(--color-tracks)" />
      </ScatterChart>
    </ChartContainer>
      {/* Quadrant names, inside the plot area (left edge clears the Y axis). */}
      <div className="pointer-events-none absolute inset-0 text-[10px] font-medium tracking-wide text-muted-foreground/80 uppercase" aria-hidden>
        <span className="absolute top-3 left-10">Tense</span>
        <span className="absolute top-3 right-4">Energetic</span>
        <span className="absolute bottom-9 left-10">Sad</span>
        <span className="absolute right-4 bottom-9">Calm &amp; happy</span>
      </div>
    </div>
      <p className="text-center text-xs text-muted-foreground">Across: happiness (valence) · Up: energy</p>
    </div>
  );
}

const hourConfig = {
  energy: { label: "Energy", color: "var(--chart-1)" },
  valence: { label: "Happiness", color: "var(--chart-4)" },
} satisfies ChartConfig;

function ByHour({ data }: { data: { hour: number; energy: number | null; valence: number | null; ms: number }[] }) {
  const rows = data.map((d) => ({
    hour: d.hour,
    energy: d.energy == null ? null : Math.round(d.energy * 100),
    valence: d.valence == null ? null : Math.round(d.valence * 100),
  }));
  const fmtHour = (h: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(Date.UTC(2020, 0, 1, h));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Through the day</CardTitle>
        <CardDescription>Average energy and happiness by hour, in your time zone</CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        <ChartContainer config={hourConfig} className="aspect-auto h-60 w-full">
          <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="hour" tickLine={false} axisLine={false} interval={2} tickFormatter={fmtHour} />
            <YAxis width={32} tickLine={false} axisLine={false} domain={[0, 100]} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => fmtHour(Number(p?.[0]?.payload?.hour ?? 0))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Line dataKey="energy" type="monotone" stroke="var(--color-energy)" strokeWidth={2} dot={false} connectNulls />
            <Line dataKey="valence" type="monotone" stroke="var(--color-valence)" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const periodConfig = {
  energy: { label: "Energy", color: "var(--chart-1)" },
  valence: { label: "Happiness", color: "var(--chart-4)" },
  danceability: { label: "Danceability", color: "var(--chart-3)" },
} satisfies ChartConfig;

function OverTime({
  data,
  bucket,
}: {
  data: { t: string; energy: number | null; valence: number | null; danceability: number | null }[];
  bucket: import("@shared/api").Bucket;
}) {
  const rows = data.map((d) => ({
    t: d.t,
    energy: d.energy == null ? null : Math.round(d.energy * 100),
    valence: d.valence == null ? null : Math.round(d.valence * 100),
    danceability: d.danceability == null ? null : Math.round(d.danceability * 100),
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Over time</CardTitle>
        <CardDescription>How your music's mood has shifted</CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        <ChartContainer config={periodConfig} className="aspect-auto h-60 w-full">
          <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={28} tickFormatter={(t: string) => fmtBucket(t, bucket)} />
            <YAxis width={32} tickLine={false} axisLine={false} domain={[0, 100]} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, p) => {
                    const t = p?.[0]?.payload?.t as string | undefined;
                    return t ? fmtBucket(t, bucket, true) : "";
                  }}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Line dataKey="energy" type="monotone" stroke="var(--color-energy)" strokeWidth={2} dot={false} connectNulls />
            <Line dataKey="valence" type="monotone" stroke="var(--color-valence)" strokeWidth={2} dot={false} connectNulls />
            <Line dataKey="danceability" type="monotone" stroke="var(--color-danceability)" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function Histogram({
  title,
  description,
  data,
  color = "var(--chart-1)",
}: {
  title: string;
  description: string;
  data: { label: string; ms: number }[];
  color?: string;
}) {
  const config = { hours: { label: "Listening", color } } satisfies ChartConfig;
  const rows = data.map((d) => ({ label: d.label, hours: d.ms / 3_600_000, ms: d.ms }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        <ChartContainer config={config} className="aspect-auto h-52 w-full">
          <BarChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis width={36} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${Math.round(v)}h`} />
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
      </CardContent>
    </Card>
  );
}

function Extremes({ title, items, metric }: { title: string; items: MoodTrack[]; metric: "energy" | "valence" }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ol className="space-y-2">
            {items.slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-center gap-2.5">
                <Art src={t.imageUrl} alt="" className="size-9" />
                <div className="min-w-0 flex-1">
                  <RLink to={trackHref(t.id)} className="block truncate text-sm font-medium hover:underline">
                    {t.name}
                  </RLink>
                  <div className="truncate text-xs text-muted-foreground">{t.artist}</div>
                </div>
                <span className="text-xs font-medium tabular">{pct(t[metric])}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
