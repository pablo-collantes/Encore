// The global date range lives in the URL (?range=12m, ?range=y2024, or
// ?from=2024-01-01&to=2024-03-31) so every view is linkable and survives reloads.
import type { Bucket } from "@shared/api";
import { addDaysKey, localDateKey, localParts, parseDateKey, startOfLocalDay, zonedMidnight } from "./time";
import { fmtDate } from "./format";

export const RANGE_PARAMS = ["range", "from", "to"] as const;

export const PRESETS: { value: string; label: string; short: string }[] = [
  { value: "4w", label: "Last 4 weeks", short: "4 weeks" },
  { value: "6m", label: "Last 6 months", short: "6 months" },
  { value: "12m", label: "Last 12 months", short: "12 months" },
  { value: "ytd", label: "This year", short: "This year" },
  { value: "all", label: "All time", short: "All time" },
];

export interface ResolvedRange {
  /** Stable identity for query keys and the picker ("12m", "y2024", "2024-01-01..2024-03-31"). */
  key: string;
  from: number;
  /** Exclusive. */
  to: number;
  tz: string;
  label: string;
  bucket: Bucket;
  /** Custom ranges echo their inclusive date keys for the picker. */
  fromKey: string;
  toKey: string;
}

const DAY = 86_400_000;

export function autoBucket(from: number, to: number): Bucket {
  const span = to - from;
  if (span <= 45 * DAY) return "day";
  if (span <= 548 * DAY) return "week";
  if (span <= 8 * 366 * DAY) return "month";
  return "year";
}

function monthsBack(now: number, tz: string, months: number): number {
  const p = localParts(now, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1 - months, p.day));
  return zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), tz);
}

export function resolveRange(
  search: URLSearchParams,
  opts: { now: number; tz: string; firstTs: number | null; defaultRange: string },
): ResolvedRange {
  const { now, tz } = opts;
  const fromKeyParam = parseDateKey(search.get("from")) ? search.get("from")! : null;
  const toKeyParam = parseDateKey(search.get("to")) ? search.get("to")! : null;

  let key: string;
  let from: number;
  let to = now;
  let label: string;

  if (fromKeyParam && toKeyParam && fromKeyParam <= toKeyParam) {
    const f = parseDateKey(fromKeyParam)!;
    const t = parseDateKey(addDaysKey(toKeyParam, 1))!;
    from = zonedMidnight(f.year, f.month, f.day, tz);
    to = zonedMidnight(t.year, t.month, t.day, tz);
    key = `${fromKeyParam}..${toKeyParam}`;
    label = `${fmtDate(from, tz)} – ${fmtDate(to - 1, tz)}`;
  } else {
    let preset = search.get("range") ?? opts.defaultRange;
    const year = /^y(\d{4})$/.exec(preset);
    if (!year && !PRESETS.some((p) => p.value === preset)) preset = "12m";
    key = preset;
    if (year) {
      const y = Number(year[1]);
      from = zonedMidnight(y, 1, 1, tz);
      to = zonedMidnight(y + 1, 1, 1, tz);
      label = String(y);
    } else {
      switch (preset) {
        case "4w":
          from = startOfLocalDay(now - 27 * DAY, tz);
          break;
        case "6m":
          from = monthsBack(now, tz, 6);
          break;
        case "ytd":
          from = zonedMidnight(localParts(now, tz).year, 1, 1, tz);
          break;
        case "all":
          from = opts.firstTs != null ? startOfLocalDay(opts.firstTs, tz) : monthsBack(now, tz, 12);
          break;
        default:
          from = monthsBack(now, tz, 12);
      }
      label = PRESETS.find((p) => p.value === preset)!.label;
    }
  }

  return {
    key,
    from,
    to,
    tz,
    label,
    bucket: autoBucket(from, to),
    fromKey: localDateKey(from, tz),
    toKey: localDateKey(Math.max(from, to - 1), tz),
  };
}

/** Keep only the range params of a search string, for links between pages. */
export function rangeSearch(search: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of RANGE_PARAMS) {
    const v = search.get(k);
    if (v) out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** Previous same-length period, for "vs previous" labels. */
export function previousLabel(r: ResolvedRange): string {
  if (r.key === "all") return "";
  if (/^y\d{4}$/.test(r.key)) return `vs ${Number(r.key.slice(1)) - 1}`;
  return "vs previous period";
}
