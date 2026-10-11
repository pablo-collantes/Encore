import { Cell, Pie, PieChart } from "recharts";
import type { GenreStat } from "@shared/api";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtDuration, fmtPct } from "../lib/format";

export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "color-mix(in oklch, var(--chart-1) 55%, var(--muted))",
  "color-mix(in oklch, var(--chart-2) 55%, var(--muted))",
  "color-mix(in oklch, var(--chart-3) 55%, var(--muted))",
  "color-mix(in oklch, var(--chart-4) 55%, var(--muted))",
  "color-mix(in oklch, var(--chart-5) 55%, var(--muted))",
];

/** Share of listening by genre, top N plus "Other". */
export function GenreDonut({ items, top = 6 }: { items: GenreStat[]; top?: number }) {
  const total = items.reduce((s, g) => s + g.ms, 0);
  const head = items.slice(0, top);
  const rest = items.slice(top).reduce((s, g) => s + g.ms, 0);
  const data = [
    ...head.map((g, i) => ({ key: `g${i}`, name: g.genre, ms: g.ms, fill: SERIES_COLORS[i % SERIES_COLORS.length]! })),
    ...(rest > 0 ? [{ key: "other", name: "Other", ms: rest, fill: "var(--muted)" }] : []),
  ];
  const config: ChartConfig = Object.fromEntries(data.map((d) => [d.key, { label: d.name, color: d.fill }]));

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <ChartContainer config={config} className="aspect-square h-44 shrink-0">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideLabel
                nameKey="key"
                formatter={(_v, _n, item) => {
                  const d = item.payload as { name: string; ms: number };
                  return (
                    <div className="flex w-full justify-between gap-3">
                      <span>{d.name}</span>
                      <span className="font-mono tabular">{fmtDuration(d.ms)}</span>
                    </div>
                  );
                }}
              />
            }
          />
          <Pie data={data} dataKey="ms" nameKey="key" innerRadius="58%" outerRadius="100%" strokeWidth={2} stroke="var(--card)">
            {data.map((d) => (
              <Cell key={d.key} fill={d.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="grid w-full gap-1.5 text-sm">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: d.fill }} aria-hidden />
            <span className="min-w-0 flex-1 truncate capitalize">{d.name}</span>
            <span className="text-xs text-muted-foreground tabular">{fmtPct(total ? d.ms / total : 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
