import type { NowResponse } from "@shared/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useNowPlaying } from "../hooks/queries";
import { Art } from "./Art";
import { RLink, trackHref } from "./RLink";

const FRESH_MS = 3 * 60_000;

/** Animated equaliser bars, shown while something is actually playing. */
export function Equalizer({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-3 items-end gap-[2px]", className)} aria-hidden>
      <style>{`@keyframes encore-eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}`}</style>
      {[0, 0.25, 0.5].map((d) => (
        <span
          key={d}
          className="h-full w-[3px] origin-bottom rounded-full bg-primary"
          style={{ animation: `encore-eq 0.9s ease-in-out ${d}s infinite` }}
        />
      ))}
    </span>
  );
}

export function isLive(p: NowResponse["playing"]): boolean {
  return Boolean(p && p.isPlaying && Date.now() - p.sampledAt < FRESH_MS);
}

/** Compact "now playing" chip for the header. */
export function NowPlayingChip() {
  const q = useNowPlaying();
  const p = q.data?.playing ?? null;
  if (!p || !isLive(p)) return null;
  const title = p.track?.name ?? p.episode?.name ?? "Playing";
  const by = p.track ? p.track.artists.map((a) => a.name).join(", ") : (p.episode?.show ?? "");
  const img = p.track?.album?.imageUrl ?? p.episode?.imageUrl ?? null;
  const body = (
    <span className="flex max-w-[14rem] items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 text-xs">
      <Art src={img} alt="" className="size-6" rounded />
      <span className="min-w-0">
        <span className="block truncate font-medium">{title}</span>
      </span>
      <Equalizer />
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {p.track ? (
          <RLink to={trackHref(p.track.id)} aria-label={`Now playing: ${title}`} className="hidden md:block">
            {body}
          </RLink>
        ) : (
          <span className="hidden md:block" aria-label={`Now playing: ${title}`}>
            {body}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        Now playing{p.device ? ` on ${p.device}` : ""}: {title}
        {by ? ` — ${by}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}
