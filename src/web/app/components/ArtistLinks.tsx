import { Fragment } from "react";
import type { ArtistLite } from "@shared/api";
import { cn } from "@/lib/utils";
import { artistHref, RLink } from "./RLink";

/** "Artist A, Artist B" with each name linking to its page. */
export function ArtistLinks({ artists, className, max = 3 }: { artists: ArtistLite[]; className?: string; max?: number }) {
  if (!artists.length) return <span className={cn("text-muted-foreground", className)}>Unknown artist</span>;
  const shown = artists.slice(0, max);
  return (
    <span className={cn("truncate", className)}>
      {shown.map((a, i) => (
        <Fragment key={a.id}>
          {i > 0 && ", "}
          <RLink to={artistHref(a.id)} className="hover:text-foreground hover:underline underline-offset-2">
            {a.name}
          </RLink>
        </Fragment>
      ))}
      {artists.length > max && ` +${artists.length - max}`}
    </span>
  );
}
