// Time-zone arithmetic without a date library: Intl knows every zone's rules,
// so offsets are read from it and local wall-clock dates converted by hand.

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(ts: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ts))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour === 24 ? 0 : out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset (ms) of `tz` from UTC at instant `ts`. */
export function tzOffset(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads y-m-d 00:00 (month 1-12). */
export function zonedMidnight(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  let ts = guess - tzOffset(guess, tz);
  // Re-check once: the offset at the result can differ across a DST change.
  const second = guess - tzOffset(ts, tz);
  if (second !== ts) ts = second;
  return ts;
}

/** Local midnight at or before `ts`. */
export function startOfLocalDay(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  return zonedMidnight(p.year, p.month, p.day, tz);
}

/** "YYYY-MM-DD" of `ts` in `tz`. */
export function localDateKey(ts: number, tz: string): string {
  const p = localParts(ts, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Parse "YYYY-MM-DD" into its parts, or null. */
export function parseDateKey(s: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = +m[1]!;
  const month = +m[2]!;
  const day = +m[3]!;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Add whole calendar days to a "YYYY-MM-DD" key. */
export function addDaysKey(key: string, days: number): string {
  const p = parseDateKey(key)!;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return d.toISOString().slice(0, 10);
}
