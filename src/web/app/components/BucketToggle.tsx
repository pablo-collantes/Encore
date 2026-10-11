import type { Bucket } from "@shared/api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const OPTIONS: { value: Bucket; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

export function BucketToggle({ value, onChange }: { value: Bucket; onChange: (b: Bucket) => void }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      spacing={0}
      value={value}
      onValueChange={(v) => v && onChange(v as Bucket)}
      aria-label="Group by"
    >
      {OPTIONS.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-2.5 text-xs">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
