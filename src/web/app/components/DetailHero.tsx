import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Big art + title block at the top of artist/track/album pages. */
export function DetailHero({
  art,
  eyebrow,
  title,
  meta,
  spotifyUrl,
  children,
}: {
  art: ReactNode;
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  spotifyUrl?: string | null;
  children?: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/15 via-card to-card p-5 sm:p-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
        {art}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</div>
          <h1 className="font-heading text-3xl font-bold tracking-tight break-words sm:text-4xl">{title}</h1>
          {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
          {children}
        </div>
        {spotifyUrl && (
          <Button asChild variant="outline" size="sm" className="self-start sm:self-end">
            <a href={spotifyUrl} target="_blank" rel="noreferrer noopener">
              Open in Spotify <ExternalLink />
            </a>
          </Button>
        )}
      </div>
    </section>
  );
}
