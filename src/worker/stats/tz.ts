// Local time in SQL. SQLite only knows fixed offsets, so for an IANA zone the
// Worker (which has the full tz database through Intl) works out every UTC
// offset change inside the queried range and hands SQLite a CASE expression:
//
//   (ts + CASE WHEN ts < 1711846800000 THEN 3600000 WHEN ts < … THEN 7200000 ELSE … END)
//
// That makes "day", "hour of day" and "weekday" exact across DST changes
// without a timezone table. The expression only ever contains numbers.

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws RangeError for an unknown zone; callers fall back to UTC. */
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
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
    formatters.set(tz, f);
  }
  return f;
}

export function validTimeZone(tz: string | null | undefined): string {
  if (!tz || tz.length > 64) return "UTC";
  try {
    formatter(tz);
    return tz;
  } catch {
    return "UTC";
  }
}

/** Local wall-clock time minus UTC, in ms, at instant `t`. */
export function offsetAt(tz: string, t: number): number {
  const parts = formatter(tz).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return local - (t - (((t % 1000) + 1000) % 1000));
}

export interface OffsetSegment {
  /** First instant (unix ms) this offset applies to. */
  start: number;
  offset: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Piecewise-constant offsets covering [from, to]. */
export function offsetSegments(tz: string, from: number, to: number): OffsetSegment[] {
  const segments: OffsetSegment[] = [{ start: from, offset: offsetAt(tz, from) }];
  if (tz === "UTC") return segments;
  // Offsets change at most a few times a year; probe daily, then binary-search
  // each change down to the second it happens (offsets change on whole
  // seconds, so the boundary is exact whatever instant the probing began at).
  let prevT = from;
  let prevOff = segments[0]!.offset;
  for (let t = from + DAY; ; t += DAY) {
    const probe = Math.min(t, to);
    const off = offsetAt(tz, probe);
    if (off !== prevOff) {
      let lo = prevT;
      let hi = probe;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetAt(tz, mid) === prevOff) lo = mid;
        else hi = mid;
      }
      segments.push({ start: Math.floor(lo / 1000) * 1000 + 1000, offset: off });
      prevOff = off;
    }
    prevT = probe;
    if (probe >= to) break;
  }
  return segments;
}

/** SQL expression for local unix ms of column `col`, valid for rows in [from, to]. */
export function localMsSql(tz: string, from: number, to: number, col = "ts"): string {
  const segs = offsetSegments(tz, Math.max(0, from - DAY), to + DAY);
  if (segs.length === 1) return `(${col} + ${segs[0]!.offset})`;
  const branches = segs
    .slice(1)
    .map((s, i) => `WHEN ${col} < ${s.start} THEN ${segs[i]!.offset}`)
    .join(" ");
  return `(${col} + CASE ${branches} ELSE ${segs[segs.length - 1]!.offset} END)`;
}

export type Bucket = "day" | "week" | "month" | "year";

/** SQL for the local bucket label of `localExpr` (a local-ms expression). */
export function bucketSql(bucket: Bucket, localExpr: string): string {
  const d = `${localExpr} / 1000, 'unixepoch'`;
  switch (bucket) {
    case "day":
      return `date(${d})`;
    case "week": // weeks start on Monday
      return `date(${d}, '-6 days', 'weekday 1')`;
    case "month":
      return `strftime('%Y-%m', ${d})`;
    case "year":
      return `strftime('%Y', ${d})`;
  }
}

/** Every bucket label between two instants (local), for zero-filling charts. */
export function bucketLabels(bucket: Bucket, tz: string, from: number, to: number): string[] {
  const labelOf = (t: number) => {
    const local = new Date(t + offsetAt(tz, t));
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate();
    const pad = (n: number) => String(n).padStart(2, "0");
    switch (bucket) {
      case "day":
        return `${y}-${pad(m + 1)}-${pad(d)}`;
      case "week": {
        const dow = (local.getUTCDay() + 6) % 7; // Monday = 0
        const monday = new Date(Date.UTC(y, m, d - dow));
        return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
      }
      case "month":
        return `${y}-${pad(m + 1)}`;
      case "year":
        return `${y}`;
    }
  };
  const step = bucket === "day" || bucket === "week" ? (bucket === "day" ? DAY : 7 * DAY) : 27 * DAY;
  const out: string[] = [];
  const end = labelOf(Math.max(from, to - 1));
  let last = "";
  for (let t = from; out.length < 5000; t += step) {
    const label = labelOf(Math.min(t, to - 1));
    if (label !== last) {
      out.push(label);
      last = label;
    }
    if (label === end || t >= to) break;
  }
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

/** Pick a sensible bucket for a range length. */
export function autoBucket(from: number, to: number): Bucket {
  const days = (to - from) / DAY;
  if (days <= 45) return "day";
  if (days <= 548) return "week";
  if (days <= 8 * 366) return "month";
  return "year";
}
