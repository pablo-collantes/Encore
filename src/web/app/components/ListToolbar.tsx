import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDebounced } from "../hooks/useDebounced";
import { fmtInt } from "../lib/format";

export function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [text, setText] = useState(value);
  const debounced = useDebounced(text, 300);
  useEffect(() => {
    if (debounced !== value) onChange(debounced);
  }, [debounced]); // only when the debounced text settles, not when the URL echoes it back
  useEffect(() => setText(value), [value]);
  return (
    <InputGroup className="w-full sm:w-64">
      <InputGroupAddon>
        <Search aria-hidden />
      </InputGroupAddon>
      <InputGroupInput type="search" aria-label={label} placeholder={label} value={text} onChange={(e) => setText(e.target.value)} />
    </InputGroup>
  );
}

export function SortToggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      spacing={0}
      value={value}
      onValueChange={(v) => v && onChange(v)}
      aria-label="Sort by"
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-3 text-xs">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav className="flex items-center justify-between gap-2 pt-2 text-sm" aria-label="Pagination">
      <span className="text-muted-foreground tabular">
        {fmtInt(first)}–{fmtInt(last)} of {fmtInt(total)}
      </span>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="flex items-center px-2 text-xs text-muted-foreground tabular">
          {page} / {pages}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}
