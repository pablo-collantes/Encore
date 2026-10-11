import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Bucket } from "@shared/api";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useTimeline, type EntityFilter } from "../hooks/queries";
import { fmt1, fmtBucket, fmtDuration, fmtInt, hours } from "../lib/format";
import type { ResolvedRange } from "../lib/range";
import { BucketToggle } from "./BucketToggle";
import { ErrorState } from "./States";

const config = {
  hours: { label: "Hours", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** Listening time per day/week/month/year, as an area chart in hours. */
export function TimelineChart({
  range,
  filter,
  title = "Listening over time",
  description,
  height = "h-64",
}: {
  range: ResolvedRange;
  filter?: EntityFilter;
  title?: string;
  description?: string;
  height?: string;
}) {
  const [override, setOverride] = useState<Bucket | null>(null);
  const bucket = override ?? range.bucket;
  const q = useTimeline(range, bucket, filter);
  const points = (q.data?.points ?? []).map((p) => ({ ...p, hours: hours(p.ms) }));
  const total = points.reduce((s, p) => s + p.ms, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description ?? `${fmtDuration(total)} in ${range.label.toLowerCase()}`}</CardDescription>
        <CardAction>
          <BucketToggle value={bucket} onChange={setOverride} />
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isPending ? (
          <Skeleton className={`${height} w-full`} />
        ) : (
          <ChartContainer config={config} className={`${height} aspect-auto w-full`}>
            <AreaChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="fillHours" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-hours)" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="var(--color-hours)" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="t"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
                tickFormatter={(t: string) => fmtBucket(t, bucket)}
              />
              <YAxis
                width={40}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `${fmt1(v)}h`}
                allowDecimals
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="line"
                    labelFormatter={(_, payload) => {
                      const t = payload?.[0]?.payload?.t as string | undefined;
                      return t ? fmtBucket(t, bucket, true) : "";
                    }}
                    formatter={(_value, _name, item) => {
                      const p = item.payload as { ms: number; plays: number };
                      return (
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="text-muted-foreground">{fmtInt(p.plays)} plays</span>
                          <span className="font-mono font-medium tabular">{fmtDuration(p.ms)}</span>
                        </div>
                      );
                    }}
                  />
                }
              />
              <Area dataKey="hours" type="monotone" fill="url(#fillHours)" stroke="var(--color-hours)" strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
