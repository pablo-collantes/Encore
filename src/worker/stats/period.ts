// Which dashboard reads the stored totals (rollup.ts) can answer: All time and
// whole calendar years (including this year so far), in the stats time zone,
// once the first build has finished. Anything else (Last 12 months, custom
// ranges, another time zone, a single artist's page) reads the listens it
// covers, as before.

import type { Env } from "../types";
import { clampInt } from "../lib/http";
import type { Range } from "./queries";
import { localMidnight, localYear, rollDefinition, statsTimeZone, STATE_ROLL_DEF, STATE_ROLL_READY } from "./rollup";
import { autoBucket, validTimeZone, type Bucket } from "./tz";

const DAY = 86_400_000;

/** `to` at least this recent means "up to now" (the app rounds now up to 5 minutes). */
const OPEN_SLACK_MS = 15 * 60_000;

/** `from`/`to`/`tz` query params. Lists default to the last year; detail pages to all time. */
export function parseRange(params: URLSearchParams, now: number, defaultSpan: "year" | "all" = "year"): Range {
  const to = clampInt(params.get("to"), now + 60_000, 0, now + 365 * DAY);
  const from = clampInt(params.get("from"), defaultSpan === "all" ? 0 : to - 365 * DAY, 0, to);
  return { from, to, tz: validTimeZone(params.get("tz")) };
}

export function parseBucket(params: URLSearchParams, r: Range): Bucket {
  const b = params.get("bucket");
  return b === "day" || b === "week" || b === "month" || b === "year" ? b : autoBucket(r.from, r.to);
}

export interface StoredPeriod {
  /** 0 = All time, otherwise the calendar year. */
  p: number;
  range: Range;
  /** For a whole year: the year before, for "vs 2024". */
  prev: number | null;
  /** For this year so far: the same number of days before it (read from the listens, by whole days). */
  prevRange: { from: number; to: number } | null;
}

const STORED = /^\/api\/(summary|overview|timeline|top\/(artists|tracks|albums|genres)|genres\/timeline|clock|mood|podcasts|habits)$/;

/**
 * The stored period a read can be answered from, or null to read the listens.
 * Costs one small query (readiness and the first listen) for eligible routes.
 */
export async function storedPeriodFor(env: Env, path: string, params: URLSearchParams, now: number): Promise<StoredPeriod | null> {
  if (!STORED.test(path)) return null;
  const has = (k: string) => Boolean(params.get(k));
  // One artist's/track's/album's listening is read from its own listens (few).
  // Top tracks and albums can be narrowed to an artist from the stored totals.
  if (has("track") || has("genre")) return null;
  if (has("album") && path !== "/api/top/tracks") return null;
  if (has("artist") && path !== "/api/top/tracks" && path !== "/api/top/albums") return null;
  const r = parseRange(params, now);
  if (path === "/api/genres/timeline" && parseBucket(params, r) === "day") return null;

  const tz = statsTimeZone(env);
  if (r.tz !== tz) return null;
  const st = await env.DB.prepare(
    `SELECT (SELECT value FROM sync_state WHERE key = ?1) AS ready,
            (SELECT value FROM sync_state WHERE key = ?2) AS def,
            (SELECT MIN(ts) FROM listens WHERE dup_of IS NULL) AS first`,
  )
    .bind(STATE_ROLL_READY, STATE_ROLL_DEF)
    .first<{ ready: string | null; def: string | null; first: number | null }>();
  if (st?.ready !== "1" || st.def !== rollDefinition(tz)) return null;

  if (path === "/api/summary") return { p: 0, range: r, prev: null, prevRange: null };
  const upToNow = r.to >= now - OPEN_SLACK_MS;
  if (upToNow && (st.first === null || r.from <= st.first)) return { p: 0, range: r, prev: null, prevRange: null };

  const y = localYear(tz, r.from);
  if (r.from !== localMidnight(tz, y, 1, 1)) return null;
  if (r.to === localMidnight(tz, y + 1, 1, 1)) return { p: y, range: r, prev: y - 1, prevRange: null };
  if (upToNow && localYear(tz, now) === y) {
    const days = Math.ceil((r.to - r.from) / DAY);
    const start = new Date(Date.UTC(y, 0, 1 - days));
    return {
      p: y,
      range: r,
      prev: null,
      prevRange: { from: localMidnight(tz, start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()), to: r.from },
    };
  }
  return null;
}

/**
 * The KV key of a stored answer: the plain key prefixed with the version of
 * each period it is built from, so it changes whenever those totals do. A past
 * year's answer may stay a month; All time and this year an hour ("today").
 */
export async function storedCacheKey(env: Env, sp: StoredPeriod, key: string, now: number): Promise<{ key: string; ttlS: number }> {
  const periods = sp.prev === null ? [sp.p] : [sp.p, sp.prev];
  const { results } = await env.DB.prepare("SELECT p, v FROM roll_pv WHERE p IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(periods))
    .all<{ p: number; v: number }>();
  const v = new Map(results.map((r) => [r.p, r.v]));
  const tag = periods.map((p) => `${p}.${v.get(p) ?? 0}`).join(",");
  const past = sp.p !== 0 && sp.p < localYear(sp.range.tz, now);
  return { key: `roll:${tag}:${key}`, ttlS: past ? 30 * 86_400 : 3_600 };
}
