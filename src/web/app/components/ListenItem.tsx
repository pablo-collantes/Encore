import type { ListenRow } from "@shared/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtClock, fmtTime, SOURCE_LABEL } from "../lib/format";
import { Art } from "./Art";
import { ArtistLinks } from "./ArtistLinks";
import { albumHref, RLink, trackHref } from "./RLink";

/** One listening event: time, art, title, artists/show, played duration and badges. */
export function ListenItem({ row, tz, showSource = true }: { row: ListenRow; tz: string; showSource?: boolean }) {
  const t = row.track;
  const e = row.episode;
  const title = t?.name ?? e?.name ?? "Unknown";
  const img = t?.album?.imageUrl ?? e?.show?.imageUrl ?? null;
  return (
    <li className={cn("flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50", row.dupOf != null && "opacity-50")}>
      <time dateTime={new Date(row.ts).toISOString()} className="w-14 shrink-0 text-xs text-muted-foreground tabular">
        {fmtTime(row.ts, tz)}
      </time>
      <Art src={img} alt="" kind={e ? "show" : "track"} className="size-10" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {t ? (
            <RLink to={trackHref(t.id)} className="hover:underline underline-offset-2">
              {title}
            </RLink>
          ) : (
            title
          )}
        </div>
        <div className="flex min-w-0 gap-1 truncate text-xs text-muted-foreground">
          {t ? (
            <>
              <ArtistLinks artists={t.artists} />
              {t.album && (
                <span className="hidden truncate sm:inline">
                  ·{" "}
                  <RLink to={albumHref(t.album.id)} className="hover:text-foreground hover:underline underline-offset-2">
                    {t.album.name}
                  </RLink>
                </span>
              )}
            </>
          ) : (
            <span className="truncate">{e?.show?.name ?? (row.kind === "audiobook" ? "Audiobook" : "Podcast")}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs tabular" title={row.msEstimated ? "Estimated from the track length" : "Time actually played"}>
          {row.msEstimated && "~"}
          {fmtClock(row.msPlayed)}
        </span>
        <span className="flex gap-1">
          {row.skipped && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              Skipped
            </Badge>
          )}
          {row.dupOf != null && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              Duplicate
            </Badge>
          )}
          {showSource && (
            <Badge variant="secondary" className="hidden h-4 px-1.5 text-[10px] sm:inline-flex">
              {SOURCE_LABEL[row.source] ?? row.source}
              {row.platform ? ` · ${shortPlatform(row.platform)}` : ""}
            </Badge>
          )}
        </span>
      </div>
    </li>
  );
}

/** Spotify's platform strings are long ("Android OS 13 API 33 (Google, Pixel 7)"); keep the first words. */
export function shortPlatform(p: string): string {
  const s = p.replace(/\s*\(.*$/, "").trim();
  return s.length > 24 ? `${s.slice(0, 22)}…` : s;
}
