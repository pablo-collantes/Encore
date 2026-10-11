import type { ReactNode } from "react";
import { AlertCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { RLink } from "./RLink";

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-6 text-center text-sm">
      <AlertCircle className="size-5 text-destructive" aria-hidden />
      <p className="text-muted-foreground">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function NoData({
  title = "Nothing here for this range",
  description = "Try a longer date range, or import your Spotify history to fill in the past.",
  icon,
  action,
}: {
  title?: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <Upload />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {action ?? (
          <Button asChild size="sm" variant="outline">
            <RLink to="/data">Import Spotify data</RLink>
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );
}

export function RowsSkeleton({ rows = 6, art = true }: { rows?: number; art?: boolean }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          {art && <Skeleton className="size-10 rounded-md" />}
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}

export function CoverageNote({ share, what }: { share: number; what: string }) {
  if (share >= 0.995) return null;
  const pct = Math.round(share * 100);
  return (
    <p className="text-xs text-muted-foreground">
      {what} found for <span className="font-medium text-foreground tabular">{pct}%</span> of listening so far — the rest are
      still being looked up in the background.
    </p>
  );
}
