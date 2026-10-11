import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { DataStatusResponse } from "@shared/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtBucket, fmtInt } from "../../lib/format";

const config = {
  extended: { label: "Extended history", color: "var(--chart-1)" },
  account: { label: "Account data", color: "var(--chart-3)" },
  live: { label: "Live collection", color: "var(--chart-2)" },
} satisfies ChartConfig;

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y! + 1}-01` : `${y}-${String(mo! + 1).padStart(2, "0")}`;
}

/** Fill in empty months so gaps show as gaps, and list them. */
export function fillMonths(coverage: DataStatusResponse["coverage"]) {
  if (coverage.length === 0) return { rows: [], gaps: [] as { from: string; to: string }[] };
  const byMonth = new Map(coverage.map((c) => [c.month, c]));
  const sorted = [...coverage].sort((a, b) => a.month.localeCompare(b.month));
  const rows: DataStatusResponse["coverage"] = [];
  const gaps: { from: string; to: string }[] = [];
  for (let m = sorted[0]!.month; m <= sorted[sorted.length - 1]!.month; m = nextMonth(m)) {
    const c = byMonth.get(m) ?? { month: m, extended: 0, account: 0, live: 0, duplicates: 0 };
    rows.push(c);
    if (c.extended + c.account + c.live === 0) {
      const last = gaps[gaps.length - 1];
      if (last && nextMonth(last.to) === m) last.to = m;
      else gaps.push({ from: m, to: m });
    }
  }
  return { rows, gaps };
}

export function Coverage({ coverage }: { coverage: DataStatusResponse["coverage"] }) {
  const { rows, gaps } = fillMonths(coverage);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Coverage</CardTitle>
        <CardDescription>Listens per month by where they came from. Empty months are gaps in your history.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-2 sm:px-6">
        {rows.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No listening data yet.</p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-60 w-full">
            <BarChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} minTickGap={24} tickFormatter={(m: string) => fmtBucket(m, "month")} />
              <YAxis width={44} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtInt(v)} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, p) => {
                      const m = p?.[0]?.payload?.month as string | undefined;
                      return m ? fmtBucket(m, "month", true) : "";
                    }}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="extended" stackId="a" fill="var(--color-extended)" />
              <Bar dataKey="account" stackId="a" fill="var(--color-account)" />
              <Bar dataKey="live" stackId="a" fill="var(--color-live)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
        {gaps.length > 0 && (
          <div className="px-2 text-sm">
            <div className="font-medium">Gaps</div>
            <p className="text-muted-foreground">
              No listening recorded in{" "}
              {gaps
                .map((g) => (g.from === g.to ? fmtBucket(g.from, "month", true) : `${fmtBucket(g.from, "month", true)} – ${fmtBucket(g.to, "month", true)}`))
                .join(", ")}
              . An Extended streaming history export covers your whole account history.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
