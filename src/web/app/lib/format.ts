// Number, duration and date formatting. Dates always render in the chosen zone.
import type { Bucket } from "@shared/api";

const nf = new Intl.NumberFormat();
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));
export const fmt1 = (n: number | null | undefined) => (n == null ? "—" : nf1.format(n));
export const fmtPct = (n: number | null | undefined) => (n == null ? "—" : pct.format(n));

export const minutes = (ms: number) => ms / 60_000;
export const hours = (ms: number) => ms / 3_600_000;
export const days = (ms: number) => ms / 86_400_000;

/** Compact duration for tables: "45s", "34m", "12h 34m", "1,234h". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 100) return `${nf.format(h)}h`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Track length style: "3:27". */
export function fmtClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The three headline units for a listening total. */
export function durationUnits(ms: number) {
  const h = hours(ms);
  const d = days(ms);
  return {
    minutes: nf.format(Math.round(minutes(ms))),
    hours: h >= 100 ? nf.format(Math.round(h)) : nf1.format(h),
    days: d >= 100 ? nf.format(Math.round(d)) : nf1.format(d),
  };
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts });
    dtfCache.set(key, f);
  }
  return f;
}

export const fmtDate = (ts: number | null | undefined, tz: string) =>
  ts == null ? "—" : dtf(tz, { year: "numeric", month: "short", day: "numeric" }).format(ts);
export const fmtDateTime = (ts: number | null | undefined, tz: string) =>
  ts == null ? "—" : dtf(tz, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ts);
export const fmtTime = (ts: number, tz: string) => dtf(tz, { hour: "numeric", minute: "2-digit" }).format(ts);
export const fmtWeekdayDate = (ts: number, tz: string) =>
  dtf(tz, { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(ts);

/** "3 minutes ago", "2 days ago". */
export function fmtRelative(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null) return "—";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diff = ts - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["week", 7 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return "just now";
}

/**
 * Bucket keys come back already in local time ("2025-03-14", "2025-03",
 * "2025"), so they are formatted as plain calendar values (UTC, no shifting).
 */
export function fmtBucket(t: string, bucket: Bucket, long = false): string {
  const [y, m, d] = t.split("-").map(Number);
  if (bucket === "year" || m === undefined) return String(y);
  const date = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  if (bucket === "month") return dtf("UTC", { month: "short", year: long ? "numeric" : "2-digit" }).format(date);
  if (bucket === "week") return (long ? "Week of " : "") + dtf("UTC", { month: "short", day: "numeric", ...(long ? { year: "numeric" } : {}) }).format(date);
  return dtf("UTC", { month: "short", day: "numeric", ...(long ? { year: "numeric", weekday: "short" } : {}) }).format(date);
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

export const SOURCE_LABEL: Record<string, string> = {
  extended: "Export",
  account: "Account data",
  live: "Live",
};

export const KIND_LABEL: Record<string, string> = {
  extended_audio: "Extended history",
  extended_video: "Extended history (video)",
  account_music: "Account data · music",
  account_podcast: "Account data · podcasts",
  account_legacy: "Account data (older format)",
  other: "Not listening history",
};

/** Spotify's reason codes, in plain words. */
export function fmtReason(reason: string): string {
  const map: Record<string, string> = {
    trackdone: "Track finished",
    fwdbtn: "Skipped forward",
    backbtn: "Went back",
    endplay: "Stopped",
    logout: "Logged out",
    remote: "Remote control",
    clickrow: "Picked a song",
    clickside: "Clicked elsewhere",
    playbtn: "Pressed play",
    appload: "App opened",
    trackerror: "Playback error",
    unexpected_exit: "App closed",
    "unexpected-exit": "App closed",
    "unexpected-exit-while-paused": "App closed (paused)",
    unexpected_exit_while_paused: "App closed (paused)",
    popup: "Popup",
    uriopen: "Opened a link",
    persisted: "Resumed",
    switched_to_audio: "Switched to audio",
    switched_to_video: "Switched to video",
    unknown: "Unknown",
  };
  return map[reason] ?? reason.replace(/[_-]+/g, " ");
}
