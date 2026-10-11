import type { ReactNode } from "react";
import type { ArtistStat, TrackStat, AlbumStat } from "@shared/api";
import { fmtDuration, fmtInt } from "../lib/format";
import { Art } from "./Art";
import { ArtistLinks } from "./ArtistLinks";
import { albumHref, artistHref, RLink, trackHref } from "./RLink";
import { RowsSkeleton } from "./States";

/** A ranked row: number, art, two lines of text, a proportional bar, and the time. */
function RankRow({
  rank,
  art,
  title,
  subtitle,
  ms,
  max,
  meta,
}: {
  rank: number;
  art: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  ms: number;
  max: number;
  meta?: ReactNode;
}) {
  const width = max > 0 ? Math.max(2, (ms / max) * 100) : 0;
  return (
    <li className="group relative flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
      <span className="w-6 shrink-0 text-right text-sm font-medium text-muted-foreground tabular">{rank}</span>
      {art}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary/70 transition-[width] duration-500" style={{ width: `${width}%` }} />
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-medium tabular">{fmtDuration(ms)}</div>
        {meta && <div className="text-xs text-muted-foreground tabular">{meta}</div>}
      </div>
    </li>
  );
}

export function ArtistRankList({ items, loading }: { items: ArtistStat[] | undefined; loading?: boolean }) {
  if (loading && !items) return <RowsSkeleton rows={8} />;
  const max = Math.max(0, ...(items ?? []).map((i) => i.ms));
  return (
    <ol className="flex flex-col gap-0.5">
      {(items ?? []).map((a) => (
        <RankRow
          key={a.id}
          rank={a.rank}
          art={<Art src={a.imageUrl} alt={a.name} kind="artist" className="size-10" />}
          title={
            <RLink to={artistHref(a.id)} className="hover:underline underline-offset-2">
              {a.name}
            </RLink>
          }
          subtitle={`${fmtInt(a.plays)} plays · ${fmtInt(a.tracks)} tracks`}
          ms={a.ms}
          max={max}
        />
      ))}
    </ol>
  );
}

export function TrackRankList({ items, loading }: { items: TrackStat[] | undefined; loading?: boolean }) {
  if (loading && !items) return <RowsSkeleton rows={8} />;
  const max = Math.max(0, ...(items ?? []).map((i) => i.ms));
  return (
    <ol className="flex flex-col gap-0.5">
      {(items ?? []).map((t) => (
        <RankRow
          key={t.id}
          rank={t.rank}
          art={<Art src={t.album?.imageUrl} alt={t.album?.name ?? t.name} kind="track" className="size-10" />}
          title={
            <RLink to={trackHref(t.id)} className="hover:underline underline-offset-2">
              {t.name}
            </RLink>
          }
          subtitle={<ArtistLinks artists={t.artists} />}
          ms={t.ms}
          max={max}
          meta={`${fmtInt(t.plays)} plays`}
        />
      ))}
    </ol>
  );
}

export function AlbumRankList({ items, loading }: { items: AlbumStat[] | undefined; loading?: boolean }) {
  if (loading && !items) return <RowsSkeleton rows={6} />;
  const max = Math.max(0, ...(items ?? []).map((i) => i.ms));
  return (
    <ol className="flex flex-col gap-0.5">
      {(items ?? []).map((a) => (
        <RankRow
          key={a.id}
          rank={a.rank}
          art={<Art src={a.imageUrl} alt={a.name} kind="album" className="size-10" />}
          title={
            <RLink to={albumHref(a.id)} className="hover:underline underline-offset-2">
              {a.name}
            </RLink>
          }
          subtitle={<ArtistLinks artists={a.artists} />}
          ms={a.ms}
          max={max}
          meta={`${fmtInt(a.plays)} plays`}
        />
      ))}
    </ol>
  );
}
