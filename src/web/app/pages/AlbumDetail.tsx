import { useParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Art } from "../components/Art";
import { ArtistLinks } from "../components/ArtistLinks";
import { DetailHero } from "../components/DetailHero";
import { DurationHeadline, StatCard } from "../components/Stat";
import { ErrorState } from "../components/States";
import { TimelineChart } from "../components/TimelineChart";
import { useAlbum } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { fmtDate, fmtInt } from "../lib/format";
import { DetailSkeleton } from "./ArtistDetail";
import { TrackTable } from "./Tracks";

export default function AlbumDetail() {
  const { id = "" } = useParams();
  const range = useRange();
  const q = useAlbum(id);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isPending) return <DetailSkeleton />;

  const { album, totals, firstListen, lastListen, tracks } = q.data;

  return (
    <div className="space-y-6">
      <DetailHero
        eyebrow={album.albumType ? album.albumType.replace(/^\w/, (c) => c.toUpperCase()) : "Album"}
        title={album.name}
        spotifyUrl={album.spotifyUrl}
        art={<Art src={album.imageUrl} alt={album.name} kind="album" className="size-32 shadow-xl sm:size-44" />}
        meta={
          <span className="flex flex-wrap items-center gap-x-1.5">
            <ArtistLinks artists={album.artists} max={5} className="font-medium text-foreground" />
            {album.releaseYear && <span>· {album.releaseYear}</span>}
            {album.totalTracks != null && <span>· {album.totalTracks} tracks</span>}
          </span>
        }
      >
        {totals.tracks > 0 && album.totalTracks ? (
          <Badge variant="secondary">
            You've heard {fmtInt(Math.min(totals.tracks, album.totalTracks))} of {album.totalTracks} tracks
          </Badge>
        ) : null}
      </DetailHero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="col-span-2 gap-2 py-4">
          <CardContent className="space-y-1 px-4">
            <div className="text-xs font-medium text-muted-foreground">Time listened · all time</div>
            <DurationHeadline ms={totals.ms} />
          </CardContent>
        </Card>
        <StatCard label="Plays" value={fmtInt(totals.plays)} sub={`${fmtInt(totals.skips)} skips`} />
        <StatCard
          label="First / last played"
          value={<span className="text-base">{fmtDate(firstListen, range.tz)}</span>}
          sub={`Last: ${fmtDate(lastListen, range.tz)}`}
        />
      </div>

      <TimelineChart range={range} filter={{ album: id }} title="Listening over time" />

      <Card className="py-2">
        <CardHeader className="pt-4">
          <CardTitle>Tracks you've played</CardTitle>
          <CardDescription>All time, by time listened</CardDescription>
        </CardHeader>
        <CardContent className="px-2 sm:px-4">
          {tracks.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No plays yet.</p> : <TrackTable items={tracks} tz={range.tz} />}
        </CardContent>
      </Card>
    </div>
  );
}
