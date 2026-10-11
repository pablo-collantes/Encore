import type { ClockResponse } from "@shared/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDuration } from "../lib/format";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function hourLabel(h: number): string {
  const d = new Date(Date.UTC(2020, 0, 1, h));
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(d);
}

/** When you listen: weekday × hour of day, darker = more time. */
export function ClockHeatmap({ data, loading }: { data: ClockResponse | undefined; loading?: boolean }) {
  if (loading && !data) return <Skeleton className="h-48 w-full" />;
  const cells = data?.cells ?? DAYS.map(() => Array<number>(24).fill(0));
  const max = data?.maxMs || 1;
  const dayTotals = cells.map((row) => row.reduce((s, v) => s + v, 0));
  const hourTotals = Array.from({ length: 24 }, (_, h) => cells.reduce((s, row) => s + (row[h] ?? 0), 0));
  const peakHour = hourTotals.indexOf(Math.max(...hourTotals));
  const peakDay = dayTotals.indexOf(Math.max(...dayTotals));

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <div
          className="grid min-w-[340px] gap-[3px]"
          style={{ gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))" }}
          role="grid"
          aria-label="Listening by weekday and hour"
        >
          {cells.map((row, d) => (
            <div key={d} role="row" className="contents">
              <div role="rowheader" className="flex items-center text-[10px] text-muted-foreground">
                {DAYS[d]}
              </div>
              {row.map((ms, h) => {
                const level = ms / max;
                return (
                  <Tooltip key={h}>
                    <TooltipTrigger asChild>
                      <div
                        role="gridcell"
                        aria-label={`${DAYS[d]} ${hourLabel(h)}: ${fmtDuration(ms)}`}
                        className="h-4 rounded-[3px] bg-muted sm:h-5"
                        style={
                          ms > 0
                            ? { backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round(12 + level * 88)}%, var(--muted))` }
                            : undefined
                        }
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      {DAYS[d]} {hourLabel(h)} · {fmtDuration(ms)}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
          <div role="row" className="contents">
            <div role="presentation" />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} role="columnheader" aria-label={hourLabel(h)} className="text-center text-[9px] text-muted-foreground">
                {h % 6 === 0 ? hourLabel(h) : ""}
              </div>
            ))}
          </div>
        </div>
      </div>
      {data && data.maxMs > 0 && (
        <p className="text-xs text-muted-foreground">
          Busiest: <span className="font-medium text-foreground">{DAYS[peakDay]}s</span> and around{" "}
          <span className="font-medium text-foreground">{hourLabel(peakHour)}</span>.
        </p>
      )}
    </div>
  );
}
