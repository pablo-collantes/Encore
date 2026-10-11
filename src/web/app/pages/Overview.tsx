import { CalendarDays, Disc3, Headphones, MicVocal, Music, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtistRankList, TrackRankList } from "../components/RankList";
import { ClockHeatmap } from "../components/ClockHeatmap";
import { GenreDonut } from "../components/GenreDonut";
import { ListenItem } from "../components/ListenItem";
import { PageHeader } from "../components/PageHeader";
import { RLink } from "../components/RLink";
import { DurationHeadline, Delta, StatCard } from "../components/Stat";
import { CoverageNote, ErrorState, NoData, RowsSkeleton } from "../components/States";
import { TimelineChart } from "../components/TimelineChart";
import { useClock, useNowPlaying, useOverview, useSummary, useTopArtists, useTopGenres, useTopTracks } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtDuration, fmtInt } from "../lib/format";
import { previousLabel } from "../lib/range";

export default function Overview() {
  const range = useRange();
  const summary = useSummary();
  const overview = useOverview(range);
  const artists = useTopArtists(range, { limit: 10 });
  const tracks = useTopTracks(range, { limit: 10 });
  const genres = useTopGenres(range, "deezer", 12);
  const clock = useClock(range);
  const now = useNowPlaying();

  if (summary.data && summary.data.totalStreams === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Welcome to Encore" description="Your listening archive is empty so far." />
        <NoData
          title="No listening yet"
          description="Live collection fills this in as you listen. To see your past, import the data download Spotify gives you."
        />
      </div>
    );
  }

  const t = overview.data?.totals;
  const prev = overview.data?.previous;
  const loading = overview.isPending;
  const vs = previousLabel(range);

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description={range.label} />

      {overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="col-span-2 gap-2 py-4">
            <CardContent className="px-4">
              <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>Time listened</span>
                <Headphones className="size-4 opacity-70" aria-hidden />
              </div>
              {loading || !t ? (
                <Skeleton className="mt-2 h-10 w-56" />
              ) : (
                <div className="mt-1 space-y-1">
                  <DurationHeadline ms={t.ms} />
                  <Delta now={t.ms} before={prev?.ms} label={vs} />
                </div>
              )}
            </CardContent>
          </Card>
          <StatCard
            label="Plays"
            icon={<PlayCircle />}
            loading={loading}
            value={fmtInt(t?.plays)}
            sub={t && `${fmtInt(t.streams)} streams · ${fmtInt(t.skips)} skips`}
          />
          <StatCard
            label="Active days"
            icon={<CalendarDays />}
            loading={loading}
            value={fmtInt(t?.activeDays)}
            sub={t && t.activeDays > 0 ? `${fmtDuration(t.ms / t.activeDays)} per active day` : undefined}
          />
          <StatCard label="Artists" icon={<MicVocal />} loading={loading} value={fmtInt(t?.artists)} sub={prev && <Delta now={t?.artists ?? 0} before={prev.artists} />} />
          <StatCard label="Tracks" icon={<Music />} loading={loading} value={fmtInt(t?.tracks)} sub={prev && <Delta now={t?.tracks ?? 0} before={prev.tracks} />} />
          <StatCard label="Albums" icon={<Disc3 />} loading={loading} value={fmtInt(t?.albums)} />
          <StatCard
            label="Podcasts & audiobooks"
            icon={<Headphones />}
            loading={loading}
            value={fmtDuration(t?.spokenMs ?? 0)}
            sub={t && t.ms > 0 ? `${Math.round(((t.spokenMs ?? 0) / t.ms) * 100)}% of your listening` : undefined}
          />
        </div>
      )}

      <TimelineChart range={range} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top artists</CardTitle>
            <CardDescription>By time listened</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <RLink to="/artists">See all</RLink>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {artists.isError ? (
              <ErrorState error={artists.error} onRetry={() => artists.refetch()} />
            ) : artists.data?.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No artists in this range.</p>
            ) : (
              <ArtistRankList items={artists.data?.items} loading={artists.isPending} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top tracks</CardTitle>
            <CardDescription>By time listened</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <RLink to="/tracks">See all</RLink>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {tracks.isError ? (
              <ErrorState error={tracks.error} onRetry={() => tracks.refetch()} />
            ) : tracks.data?.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tracks in this range.</p>
            ) : (
              <TrackRankList items={tracks.data?.items} loading={tracks.isPending} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Genres</CardTitle>
            <CardDescription>Share of music listening</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <RLink to="/genres">Details</RLink>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            {genres.isError ? (
              <ErrorState error={genres.error} onRetry={() => genres.refetch()} />
            ) : genres.isPending ? (
              <Skeleton className="h-44 w-full" />
            ) : genres.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Genres appear once tracks have been looked up.</p>
            ) : (
              <>
                <GenreDonut items={genres.data.items} />
                <CoverageNote share={genres.data.coverage} what="Genres" />
              </>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Listening clock</CardTitle>
            <CardDescription>When you listen, in your time zone</CardDescription>
          </CardHeader>
          <CardContent>
            {clock.isError ? <ErrorState error={clock.error} onRetry={() => clock.refetch()} /> : <ClockHeatmap data={clock.data} loading={clock.isPending} />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recently played</CardTitle>
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <RLink to="/history">Full history</RLink>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {now.isPending ? (
            <RowsSkeleton rows={5} />
          ) : (now.data?.recent.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {now.data!.recent.map((r) => (
                <ListenItem key={r.id} row={r} tz={range.tz} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
