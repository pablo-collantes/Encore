import { useState } from "react";
import { Disc3, Mic2, Music2, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { initials } from "../lib/format";

type Kind = "track" | "album" | "artist" | "show";

/** Cover art / artist photo with a tidy fallback when Spotify gave no image. */
export function Art({
  src,
  alt,
  kind = "track",
  className,
  rounded,
}: {
  src: string | null | undefined;
  alt: string;
  kind?: Kind;
  className?: string;
  rounded?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const round = rounded ?? kind === "artist";
  const shape = round ? "rounded-full" : "rounded-md";
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("aspect-square shrink-0 bg-muted object-cover", shape, className)}
      />
    );
  }
  const Icon = kind === "artist" ? User : kind === "album" ? Disc3 : kind === "show" ? Mic2 : Music2;
  return (
    <div
      role="img"
      aria-label={alt}
      className={cn(
        "flex aspect-square shrink-0 items-center justify-center bg-gradient-to-br from-muted to-secondary text-muted-foreground",
        shape,
        className,
      )}
      style={{ containerType: "inline-size" }}
    >
      {kind === "artist" && alt ? (
        <span className="font-semibold" style={{ fontSize: "clamp(9px, 30cqw, 48px)" }}>
          {initials(alt)}
        </span>
      ) : (
        <Icon className="size-[40%] min-h-3 min-w-3" aria-hidden />
      )}
    </div>
  );
}
