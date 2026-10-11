import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { durationUnits, fmtPct } from "../lib/format";

/** Relative change badge; hidden when there's nothing to compare against. */
export function Delta({ now, before, label }: { now: number; before: number | null | undefined; label?: string }) {
  if (before == null || before <= 0) return null;
  const change = (now - before) / before;
  if (!Number.isFinite(change)) return null;
  const up = change >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium tabular",
        up ? "text-primary" : "text-muted-foreground",
      )}
      title={label}
    >
      {up ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
      {fmtPct(Math.abs(change))}
      {label && <span className="ml-1 font-normal text-muted-foreground">{label}</span>}
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  loading,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  return (
    <Card className={cn("gap-2 py-4", className)}>
      <CardContent className="px-4">
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
          <span>{label}</span>
          {icon && <span className="text-muted-foreground/70 [&_svg]:size-4">{icon}</span>}
        </div>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <div className="mt-1 text-2xl font-semibold tracking-tight tabular">{value}</div>
        )}
        {sub && !loading && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** "18,240 min · 304 h · 12.7 days" — the headline form of a listening total. */
export function DurationHeadline({ ms, size = "lg" }: { ms: number; size?: "lg" | "md" }) {
  const u = durationUnits(ms);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular">
      <span className={cn("font-semibold tracking-tight", size === "lg" ? "text-3xl sm:text-4xl" : "text-2xl")}>
        {u.minutes}
        <span className="ml-1 text-base font-medium text-muted-foreground">min</span>
      </span>
      <span className="text-sm text-muted-foreground">
        {u.hours} h · {u.days} days
      </span>
    </div>
  );
}
