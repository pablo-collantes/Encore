import { useState } from "react";
import { CalendarRange, Check, ChevronDown } from "lucide-react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useSummary } from "../hooks/queries";
import { useRange } from "../hooks/useRange";
import { PRESETS } from "../lib/range";

/** Header control for the global date range; writes ?range= or ?from=&to= to the URL. */
export function RangePicker() {
  const range = useRange();
  const summary = useSummary();
  const [search, setSearch] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(range.fromKey);
  const [to, setTo] = useState(range.toKey);
  const years = [...(summary.data?.years ?? [])].sort((a, b) => b - a);

  const apply = (next: { range?: string; from?: string; to?: string }) => {
    const s = new URLSearchParams(search);
    for (const k of ["range", "from", "to", "page"]) s.delete(k);
    for (const [k, v] of Object.entries(next)) if (v) s.set(k, v);
    setSearch(s);
    setOpen(false);
  };

  const custom = range.key.includes("..");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setFrom(range.fromKey);
          setTo(range.toKey);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[46vw] gap-1.5 sm:max-w-none" aria-label={`Date range: ${range.label}`}>
          <CalendarRange className="size-4" aria-hidden />
          <span className="truncate">{range.label}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div role="group" aria-label="Preset ranges" className="grid gap-0.5">
          {PRESETS.map((p) => (
            <RangeOption key={p.value} selected={range.key === p.value} onSelect={() => apply({ range: p.value })}>
              {p.label}
            </RangeOption>
          ))}
        </div>
        {years.length > 0 && (
          <>
            <Separator className="my-2" />
            <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Years</div>
            <div className="flex flex-wrap gap-1 px-1">
              {years.map((y) => (
                <Button
                  key={y}
                  size="xs"
                  variant={range.key === `y${y}` ? "default" : "secondary"}
                  onClick={() => apply({ range: `y${y}` })}
                  className="tabular"
                >
                  {y}
                </Button>
              ))}
            </div>
          </>
        )}
        <Separator className="my-2" />
        <form
          className="grid gap-2 px-1 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to && from <= to) apply({ from, to });
          }}
        >
          <div className="text-xs font-medium text-muted-foreground">Custom {custom && "· selected"}</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor="range-from" className="text-xs">
                From
              </Label>
              <Input id="range-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="range-to" className="text-xs">
                To
              </Label>
              <Input id="range-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
            </div>
          </div>
          <Button type="submit" size="sm" disabled={!from || !to || from > to}>
            Apply
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function RangeOption({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
        selected && "font-medium",
      )}
    >
      {children}
      {selected && <Check className="size-4 text-primary" aria-hidden />}
    </button>
  );
}
