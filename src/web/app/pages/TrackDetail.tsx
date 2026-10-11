import { useParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Art } from "../components/Art";
import { ArtistLinks } from "../components/ArtistLinks";
import { ClockHeatmap } from "../components/ClockHeatmap";
import { DetailHero } from "../components/DetailHero";
import { FeatureBars } from "../components/FeatureBars";
import { albumHref, RLink, trackHref } from "../components/RLink";
import { DurationHeadline, StatCard } from "../components/Stat";
import { ErrorState } from "../components/States";
import { TimelineChart } from "../components/TimelineChart";
import { useClock, useTimeline, useTrack } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtClock, fmtDate, fmtDuration, fmtInt, fmtPct, fmtReason } from "../lib/format";
import { sumTimeline } from "../lib/totals";
import { DetailSkeleton } from "./ArtistDetail";

export default function TrackDetail() {
  const { id = "" } = useParams();
  const range = useRange();
  const q = useTrack(id);
  const clock = useClock(range, { track: id });
  const inRange = sumTimeline(useTimeline(range, range.bucket, { track: id }).data?.points);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isPending) return <DetailSkeleton />;

  const { track, totals, rankAllTime, firstListen, lastListen, features, featuresSource, reasonsEnd, versions } = q.data;
  const reasonTotal = reasonsEnd.reduce((s, r) => s + r.streams, 0);

  return (
    <div className="space-y-6">
      <DetailHero
        eyebrow="Track"
        title={track.name}
        spotifyUrl={track.spotifyUrl}
        art={<Art src={track.album?.imageUrl} alt={track.album?.name ?? track.name} className="size-32 shadow-xl sm:size-44" />}
        meta={
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <ArtistLinks artists={track.artists} max={6} className="font-medium text-foreground" />
            {track.album && (
              <>
                <span aria-hidden>·</span>
                <RLink to={albumHref(track.album.id)} className="hover:text-foreground hover:underline">
                  {track.album.name}
                </RLink>
              </>
            )}
            {track.releaseDate && <span>· {track.releaseDate.slice(0, 4)}</span>}
            {track.durationMs != null && <span>· {fmtClock(track.durationMs)}</span>}
          </span>
        }
      >
        <div className="flex flex-wrap gap-1.5 pt-1">
          {track.explicit && <Badge variant="outline">Explicit</Badge>}
          {track.genres.map((g) => (
            <Badge key={g} variant="secondary" className="capitalize">
              {g}
            </Badge>
          ))}
        </div>
      </DetailHero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="col-span-2 gap-2 py-4">
          <CardContent className="space-y-1 px-4">
            <div className="text-xs font-medium text-muted-foreground">Time listened · all time</div>
            <DurationHeadline ms={totals.ms} />
            {range.key !== "all" && (
              <div className="text-xs text-muted-foreground">
                {range.label}: <span className="font-medium text-foreground tabular">{fmtDuration(inRange.ms)}</span> ·{" "}
                {fmtInt(inRange.plays)} plays
              </div>
            )}
          </CardContent>
        </Card>
        <StatCard
          label="Plays · all time"
          value={fmtInt(totals.plays)}
          sub={rankAllTime ? `#${fmtInt(rankAllTime)} of all your tracks` : `${fmtInt(totals.streams)} streams`}
        />
        <StatCard
          label="Skips"
          value={fmtInt(totals.skips)}
          sub={totals.streams > 0 ? `${fmtPct(totals.skips / totals.streams)} of streams` : undefined}
        />
        <StatCard label="First played" value={<span className="text-lg">{fmtDate(firstListen, range.tz)}</span>} className="col-span-1" />
        <StatCard label="Last played" value={<span className="text-lg">{fmtDate(lastListen, range.tz)}</span>} className="col-span-1" />
        <StatCard label="Days played" value={fmtInt(totals.activeDays)} />
        <StatCard label="ISRC" value={<span className="font-mono text-base">{track.isrc ?? "—"}</span>} />
      </div>

      <TimelineChart range={range} filter={{ track: id }} title="Plays over time" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Sound</CardTitle>
            <CardDescription>
              {features
                ? featuresSource === "analysis"
                  ? "Analysed from a 30-second preview"
                  : "Audio features from ReccoBeats"
                : "Audio features haven't been found for this track yet."}
            </CardDescription>
          </CardHeader>
          {features && (
            <CardContent>
              <FeatureBars features={features} />
            </CardContent>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>How plays ended</CardTitle>
            <CardDescription>From Extended streaming history imports</CardDescription>
          </CardHeader>
          <CardContent>
            {reasonsEnd.length === 0 ? (
              <p className="text-sm text-muted-foreground">No detailed play data for this track.</p>
            ) : (
              <ul className="space-y-2.5">
                {reasonsEnd.map((r) => (
                  <li key={r.reason}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span>{fmtReason(r.reason)}</span>
                      <span className="text-muted-foreground tabular">{fmtInt(r.streams)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-chart-2" style={{ width: `${reasonTotal ? (r.streams / reasonTotal) * 100 : 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>When you play it</CardTitle>
            <CardDescription>{range.label}</CardDescription>
          </CardHeader>
          <CardContent>
            <ClockHeatmap data={clock.data} loading={clock.isPending} />
          </CardContent>
        </Card>
        {versions.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Other versions</CardTitle>
              <CardDescription>Same recording on other releases — counted together here</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center gap-3">
                    <Art src={v.album?.imageUrl} alt="" className="size-9" />
                    <div className="min-w-0">
                      <RLink to={trackHref(v.id)} className="block truncate text-sm font-medium hover:underline">
                        {v.name}
                      </RLink>
                      <div className="truncate text-xs text-muted-foreground">{v.album?.name}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
