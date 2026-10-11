import { useParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Art } from "../components/Art";
import { ClockHeatmap } from "../components/ClockHeatmap";
import { DetailHero } from "../components/DetailHero";
import { FeatureBars } from "../components/FeatureBars";
import { AlbumRankList, TrackRankList } from "../components/RankList";
import { RLink, trackHref } from "../components/RLink";
import { DurationHeadline, StatCard } from "../components/Stat";
import { ErrorState } from "../components/States";
import { TimelineChart } from "../components/TimelineChart";
import { useArtist, useClock, useTimeline, useTopAlbums, useTopTracks } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtDate, fmtDuration, fmtInt } from "../lib/format";
import { sumTimeline } from "../lib/totals";

export default function ArtistDetail() {
  const { id = "" } = useParams();
  const range = useRange();
  const q = useArtist(id);
  const tracks = useTopTracks(range, { artist: id, limit: 15 });
  const albums = useTopAlbums(range, { artist: id, limit: 8 });
  const clock = useClock(range, { artist: id });
  const inRange = sumTimeline(useTimeline(range, range.bucket, { artist: id }).data?.points);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isPending) return <DetailSkeleton round />;

  const { artist, totals, rankAllTime, firstListen, lastListen, features } = q.data;
  const genres = [...new Set([...artist.genres.deezer, ...artist.genres.musicbrainz])];

  return (
    <div className="space-y-6">
      <DetailHero
        eyebrow="Artist"
        title={artist.name}
        spotifyUrl={artist.spotifyUrl}
        art={<Art src={artist.imageUrl} alt={artist.name} kind="artist" className="size-28 shadow-xl sm:size-40" />}
        meta={rankAllTime ? `Your #${fmtInt(rankAllTime)} artist of all time` : undefined}
      >
        {genres.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {genres.slice(0, 10).map((g) => (
              <Badge key={g} variant="secondary" className="capitalize">
                {g}
              </Badge>
            ))}
          </div>
        )}
      </DetailHero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="col-span-2 gap-2 py-4">
          <CardContent className="space-y-1 px-4">
            <div className="text-xs font-medium text-muted-foreground">Time listened · all time</div>
            <DurationHeadline ms={totals.ms} />
            <div className="text-xs text-muted-foreground">
              {range.key === "all" ? (
                `${fmtInt(totals.plays)} plays`
              ) : (
                <>
                  {range.label}: <span className="font-medium text-foreground tabular">{fmtDuration(inRange.ms)}</span> ·{" "}
                  {fmtInt(inRange.plays)} plays
                </>
              )}
            </div>
          </CardContent>
        </Card>
        <StatCard label="Plays · all time" value={fmtInt(totals.plays)} sub={`${fmtInt(totals.streams)} streams · ${fmtInt(totals.skips)} skips`} />
        <StatCard label="Tracks heard" value={fmtInt(totals.tracks)} sub={`${fmtInt(totals.albums)} albums · ${fmtInt(totals.activeDays)} days`} />
        <Card className="col-span-2 gap-1 py-4">
          <CardContent className="px-4">
            <div className="text-xs font-medium text-muted-foreground">First heard</div>
            <div className="mt-1 font-medium">{fmtDate(firstListen?.ts, range.tz)}</div>
            {firstListen?.track && (
              <RLink to={trackHref(firstListen.track.id)} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
                {firstListen.track.name}
              </RLink>
            )}
          </CardContent>
        </Card>
        <Card className="col-span-2 gap-1 py-4">
          <CardContent className="px-4">
            <div className="text-xs font-medium text-muted-foreground">Last heard</div>
            <div className="mt-1 font-medium">{fmtDate(lastListen?.ts, range.tz)}</div>
            {lastListen?.track && (
              <RLink to={trackHref(lastListen.track.id)} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
                {lastListen.track.name}
              </RLink>
            )}
          </CardContent>
        </Card>
      </div>

      <TimelineChart range={range} filter={{ artist: id }} title={`${artist.name} over time`} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top tracks</CardTitle>
            <CardDescription>{range.label}</CardDescription>
          </CardHeader>
          <CardContent>
            {tracks.isError ? (
              <ErrorState error={tracks.error} />
            ) : tracks.data?.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No plays in this range.</p>
            ) : (
              <TrackRankList items={tracks.data?.items} loading={tracks.isPending} />
            )}
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Albums</CardTitle>
              <CardDescription>{range.label}</CardDescription>
            </CardHeader>
            <CardContent>
              {albums.isError ? (
                <ErrorState error={albums.error} />
              ) : albums.data?.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No albums in this range.</p>
              ) : (
                <AlbumRankList items={albums.data?.items} loading={albums.isPending} />
              )}
            </CardContent>
          </Card>
          {features && (
            <Card>
              <CardHeader>
                <CardTitle>Sound</CardTitle>
                <CardDescription>Average audio features, weighted by your listening</CardDescription>
              </CardHeader>
              <CardContent>
                <FeatureBars features={features} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>When you listen to {artist.name}</CardTitle>
          <CardDescription>{range.label}</CardDescription>
        </CardHeader>
        <CardContent>
          <ClockHeatmap data={clock.data} loading={clock.isPending} />
        </CardContent>
      </Card>
    </div>
  );
}

export function DetailSkeleton({ round }: { round?: boolean }) {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-end gap-5 rounded-2xl border p-6">
        <Skeleton className={round ? "size-32 rounded-full" : "size-32 rounded-md"} />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
