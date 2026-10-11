import type { ReactNode } from "react";

/** Labelled horizontal bars, for categorical breakdowns (platforms, reasons, genres…). */
export function BarList({
  items,
  format,
  color = "bg-primary/70",
  empty = "Nothing to show.",
}: {
  items: { key: string; label: ReactNode; value: number; extra?: ReactNode }[];
  format: (v: number) => string;
  color?: string;
  empty?: string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value), 0);
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{i.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular">
              {i.extra && <span className="mr-2">{i.extra}</span>}
              <span className="font-medium text-foreground">{format(i.value)}</span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full ${color}`} style={{ width: `${max ? (i.value / max) * 100 : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
