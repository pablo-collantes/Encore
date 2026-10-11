// Dashboard answers for All time and calendar years, from the stored totals
// (rollup.ts) instead of the listens: each one reads a few dozen to a few
// hundred stored rows, however long the history is. The shapes match
// queries.ts / details.ts exactly; period.ts decides which one a read gets.
//
// Differences from reading the listens, all deliberate:
//   * a whole year compares with the calendar year before ("vs 2024"), not the
//     365 days before it
//   * sessions are the archive's sessions, attributed to the year they started
//     in, rather than cut at the edges of the range

import type {
  AlbumStat,
  ArtistStat,
  AudioFeatures,
  Bucket,
  ClockResponse,
  DataStatusResponse,
  GenreSource,
  GenreStat,
  GenreTimelineResponse,
  HabitsResponse,
  MoodResponse,
  OverviewResponse,
  PodcastsResponse,
  SummaryResponse,
  TimelineResponse,
  TopAlbumsResponse,
  TopArtistsResponse,
  TopGenresResponse,
  TopTracksResponse,
  Totals,
  TrackStat,
} from "../../shared/api";
import type { Env } from "../types";
import type { ReadCache } from "../lib/cache";
import { platformFamily, streaks } from "./details";
import { hydrateAlbums, hydrateArtists, hydrateTracks, missingTrack } from "./hydrate";
import type { StoredPeriod } from "./period";
import { featuresFor, likePattern, moodTracks, totalsFor, type ListOpts, type MoodTrackRow } from "./queries";
import { FEATURES } from "./rollup";
import { bucketLabels, offsetAt } from "./tz";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round = (v: unknown) => Math.round(num(v));

interface Fact {
  ms: number;
  n: number;
}
type Facts = Map<string, Fact>;

const fact = (f: Facts, k: string): Fact => f.get(k) ?? { ms: 0, n: 0 };
const ratio = (a: number, b: number) => (b ? a / b : null);

/** The end of a key prefix range: 'gd:' -> 'gd;'. */
const after = (prefix: string) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/** Named keys of a period, plus whole key families (each a range of the primary key). */
function factsStmts(env: Env, p: number, keys: string[], prefixes: string[] = []): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  if (keys.length) {
    out.push(env.DB.prepare("SELECT k, ms, n FROM roll_facts WHERE p = ?1 AND k IN (SELECT value FROM json_each(?2))").bind(p, JSON.stringify(keys)));
  }
  for (const x of prefixes) out.push(env.DB.prepare("SELECT k, ms, n FROM roll_facts WHERE p = ?1 AND k >= ?2 AND k < ?3").bind(p, x, after(x)));
  return out;
}

function toFacts(results: (D1Result | undefined)[]): Facts {
  const out: Facts = new Map();
  for (const res of results) for (const r of (res?.results ?? []) as { k: string; ms: number; n: number }[]) out.set(r.k, { ms: num(r.ms), n: num(r.n) });
  return out;
}

async function facts(env: Env, p: number, keys: string[], prefixes: string[] = []): Promise<Facts> {
  const stmts = factsStmts(env, p, keys, prefixes);
  return stmts.length ? toFacts(await env.DB.batch(stmts)) : new Map();
}

/** The same keys for several periods, in one round trip. */
async function factsByPeriod(env: Env, periods: number[], keys: string[]): Promise<Facts[]> {
  if (!periods.length) return [];
  const results = await env.DB.batch(periods.flatMap((p) => factsStmts(env, p, keys)));
  return results.map((r) => toFacts([r]));
}

/** Rows of a key family, without the prefix. */
function family(f: Facts, prefix: string): [string, Fact][] {
  return [...f.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]);
}

/** Years that have stored totals (every period a fold ever touched). */
async function storedYears(env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT f.p FROM roll_facts f WHERE f.p IN (SELECT p FROM roll_pv WHERE p > 0) AND f.k = 'tot' AND f.n > 0 ORDER BY f.p`,
  ).all<{ p: number }>();
  return results.map((r) => r.p);
}

/** Years a period covers. */
async function yearsOf(env: Env, sp: StoredPeriod): Promise<number[]> {
  return sp.p === 0 ? storedYears(env) : [sp.p];
}

/** The local-date range of a period, for roll_days (YYYY-MM-DD strings compare in order). */
function dayRange(sp: StoredPeriod): [string, string] {
  return sp.p === 0 ? ["0000", "9999"] : [`${sp.p}-01-01`, `${sp.p + 1}-01-01`];
}

function labelOf(bucket: Bucket, day: string): string {
  switch (bucket) {
    case "day":
      return day;
    case "week": {
      const d = new Date(`${day}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    }
    case "month":
      return day.slice(0, 7);
    case "year":
      return day.slice(0, 4);
  }
}

// ---------------------------------------------------------------------------
// Summary / overview / timeline
// ---------------------------------------------------------------------------

export async function summary(env: Env): Promise<SummaryResponse> {
  const [ends, f, years] = await Promise.all([
    env.DB.prepare(
      `SELECT (SELECT MIN(ts) FROM listens WHERE dup_of IS NULL) AS first, (SELECT MAX(ts) FROM listens WHERE dup_of IS NULL) AS last`,
    ).first<{ first: number | null; last: number | null }>(),
    facts(env, 0, ["tot"], ["src:"]),
    storedYears(env),
  ]);
  const e = ends ?? { first: null, last: null };
  return {
    firstTs: e.first ?? null,
    lastTs: e.last ?? null,
    totalMs: round(fact(f, "tot").ms),
    totalStreams: round(fact(f, "tot").n),
    sources: { extended: round(fact(f, "src:extended").n), account: round(fact(f, "src:account").n), live: round(fact(f, "src:live").n) },
    years: years.reverse(),
  };
}

const TOTAL_KEYS = ["tot", "plays", "skips", "spoken", "songs", "artists", "albums", "days"];

function toTotals(f: Facts): Totals {
  return {
    ms: round(fact(f, "tot").ms),
    streams: round(fact(f, "tot").n),
    plays: round(fact(f, "plays").n),
    skips: round(fact(f, "skips").n),
    tracks: round(fact(f, "songs").n),
    artists: round(fact(f, "artists").n),
    albums: round(fact(f, "albums").n),
    activeDays: round(fact(f, "days").n),
    spokenMs: round(fact(f, "spoken").ms),
  };
}

export async function overview(env: Env, sp: StoredPeriod, cache: Pick<ReadCache, "get">): Promise<OverviewResponse> {
  const [totals, previous] = await Promise.all([
    facts(env, sp.p, TOTAL_KEYS).then(toTotals),
    sp.prev !== null
      ? facts(env, sp.prev, TOTAL_KEYS).then(toTotals)
      : sp.prevRange
        ? // This year so far vs the same number of days before it: a closed
          // range of the listens, kept in KV until older data changes.
          cache.get(
            `/api/overview/previous?from=${sp.prevRange.from}&to=${sp.prevRange.to}&tz=${sp.range.tz}`,
            () => totalsFor(env, { ...sp.prevRange!, tz: sp.range.tz }),
            "closed",
          )
        : Promise.resolve(null),
  ]);
  return { totals, previous };
}

export async function timeline(env: Env, sp: StoredPeriod, bucket: Bucket): Promise<TimelineResponse> {
  const byLabel = new Map<string, { ms: number; plays: number; streams: number }>();
  if (bucket === "year") {
    const years = await yearsOf(env, sp);
    (await factsByPeriod(env, years, ["tot", "plays"])).forEach((f, i) =>
      byLabel.set(String(years[i]), { ms: round(fact(f, "tot").ms), plays: round(fact(f, "plays").n), streams: round(fact(f, "tot").n) }),
    );
  } else {
    const [lo, hi] = dayRange(sp);
    const { results } = await env.DB.prepare("SELECT day, ms, plays, streams FROM roll_days WHERE day >= ?1 AND day < ?2 AND streams > 0")
      .bind(lo, hi)
      .all<{ day: string; ms: number; plays: number; streams: number }>();
    for (const d of results) {
      const t = labelOf(bucket, d.day);
      const p = byLabel.get(t) ?? { ms: 0, plays: 0, streams: 0 };
      p.ms += num(d.ms);
      p.plays += num(d.plays);
      p.streams += num(d.streams);
      byLabel.set(t, p);
    }
  }
  const { from, to, tz } = sp.range;
  const points = bucketLabels(bucket, tz, from, to).map((t) => ({ t, ms: 0, plays: 0, streams: 0, ...byLabel.get(t) }));
  return { bucket, points };
}

// ---------------------------------------------------------------------------
// Top lists
// ---------------------------------------------------------------------------

function listOrder(sort: string | null | undefined, alias: string, skips = false): string {
  if (sort === "plays") return `${alias}.plays DESC, ${alias}.ms DESC`;
  if (skips && sort === "skips") return `${alias}.skips DESC, ${alias}.streams DESC`;
  return `${alias}.ms DESC`;
}

/** Total for a list: the stored count, or a count of the filtered rows. */
async function listTotal(env: Env, p: number, countKey: string, filtered: { sql: string; binds: unknown[] } | null): Promise<number> {
  if (!filtered) return round(fact(await facts(env, p, [countKey]), countKey).n);
  const row = await env.DB.prepare(filtered.sql).bind(...filtered.binds).first<{ n: number }>();
  return num(row?.n);
}

export async function topTracks(env: Env, sp: StoredPeriod, o: ListOpts & { artist?: string | null; album?: string | null }): Promise<TopTracksResponse> {
  const binds: unknown[] = [sp.p];
  let filter = "";
  if (o.artist) {
    binds.push(o.artist);
    filter += ` AND s.song_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?${binds.length})`;
  }
  if (o.album) {
    binds.push(o.album);
    filter += ` AND s.song_id IN (SELECT id FROM tracks WHERE album_id = ?${binds.length})`;
  }
  if (o.q) {
    binds.push(likePattern(o.q));
    const n = binds.length;
    filter += ` AND (s.song_id IN (SELECT id FROM tracks WHERE name LIKE ?${n} ESCAPE '\\')
                     OR s.song_id IN (SELECT ta.track_id FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                                       WHERE a.name LIKE ?${n} ESCAPE '\\'))`;
  }
  const where = `s.p = ?1${filter}`;
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT s.song_id AS id, s.ms, s.plays, s.streams, s.skips, s.first_ts, s.last_ts FROM roll_songs s
        WHERE ${where} ORDER BY ${listOrder(o.sort, "s", true)} LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    )
      .bind(...binds, o.limit, o.offset)
      .all<{ id: string; ms: number; plays: number; streams: number; skips: number; first_ts: number; last_ts: number }>(),
    listTotal(env, sp.p, "songs", filter ? { sql: `SELECT COUNT(*) AS n FROM roll_songs s WHERE ${where}`, binds } : null),
  ]);
  const ids = results.map((x) => x.id);
  const [tracks, features] = await Promise.all([hydrateTracks(env, ids), featuresFor(env, ids)]);
  const items: TrackStat[] = results.map((x, i) => ({
    ...(tracks.get(x.id) ?? missingTrack(x.id)),
    rank: o.offset + i + 1,
    ms: num(x.ms),
    plays: num(x.plays),
    streams: num(x.streams),
    skips: num(x.skips),
    firstTs: x.first_ts,
    lastTs: x.last_ts,
    energy: features.get(x.id)?.energy ?? null,
    valence: features.get(x.id)?.valence ?? null,
  }));
  return { total, items };
}

export async function topArtists(env: Env, sp: StoredPeriod, o: ListOpts): Promise<TopArtistsResponse> {
  const binds: unknown[] = [sp.p];
  let filter = "";
  if (o.q) {
    binds.push(likePattern(o.q));
    filter = ` AND a.artist_id IN (SELECT id FROM artists WHERE name LIKE ?${binds.length} ESCAPE '\\')`;
  }
  const where = `a.p = ?1${filter}`;
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT a.artist_id AS id, a.ms, a.plays, a.streams, a.tracks, a.first_ts, a.last_ts FROM roll_artists a
        WHERE ${where} ORDER BY ${listOrder(o.sort, "a")} LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    )
      .bind(...binds, o.limit, o.offset)
      .all<{ id: string; ms: number; plays: number; streams: number; tracks: number; first_ts: number; last_ts: number }>(),
    listTotal(env, sp.p, "artists", filter ? { sql: `SELECT COUNT(*) AS n FROM roll_artists a WHERE ${where}`, binds } : null),
  ]);
  const artists = await hydrateArtists(env, results.map((x) => x.id));
  const items: ArtistStat[] = results.map((x, i) => ({
    ...(artists.get(x.id) ?? { id: x.id, name: "Unknown artist", imageUrl: null }),
    rank: o.offset + i + 1,
    ms: num(x.ms),
    plays: num(x.plays),
    streams: num(x.streams),
    tracks: num(x.tracks),
    firstTs: x.first_ts,
    lastTs: x.last_ts,
  }));
  return { total, items };
}

export async function topAlbums(env: Env, sp: StoredPeriod, o: ListOpts & { artist?: string | null }): Promise<TopAlbumsResponse> {
  const binds: unknown[] = [sp.p];
  let source: string;
  let filter = "";
  if (o.artist) {
    // Only the artist's own songs on each album count: summed from the per-song totals.
    binds.push(o.artist);
    source = `(SELECT t.album_id, SUM(s.ms) AS ms, SUM(s.plays) AS plays, SUM(s.streams) AS streams, COUNT(*) AS tracks,
                      MIN(s.first_ts) AS first_ts, MAX(s.last_ts) AS last_ts
                 FROM roll_songs s JOIN tracks t ON t.id = s.song_id
                WHERE s.p = ?1 AND t.album_id IS NOT NULL
                  AND s.song_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?${binds.length})
                GROUP BY t.album_id)`;
  } else {
    source = "(SELECT * FROM roll_albums WHERE p = ?1)";
  }
  if (o.q) {
    binds.push(likePattern(o.q));
    filter = ` WHERE a.album_id IN (SELECT id FROM albums WHERE name LIKE ?${binds.length} ESCAPE '\\')`;
  }
  const narrowed = Boolean(o.artist || o.q);
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT a.album_id AS id, a.ms, a.plays, a.streams, a.tracks, a.first_ts, a.last_ts FROM ${source} a${filter}
        ORDER BY ${listOrder(o.sort, "a")} LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    )
      .bind(...binds, o.limit, o.offset)
      .all<{ id: string; ms: number; plays: number; streams: number; tracks: number; first_ts: number; last_ts: number }>(),
    listTotal(env, sp.p, "albums", narrowed ? { sql: `SELECT COUNT(*) AS n FROM ${source} a${filter}`, binds } : null),
  ]);
  const albums = await hydrateAlbums(env, results.map((x) => x.id));
  const items: AlbumStat[] = results.map((x, i) => ({
    ...(albums.get(x.id) ?? { id: x.id, name: "Unknown album", imageUrl: null, releaseYear: null, artists: [] }),
    rank: o.offset + i + 1,
    ms: num(x.ms),
    plays: num(x.plays),
    streams: num(x.streams),
    tracks: num(x.tracks),
    firstTs: x.first_ts,
    lastTs: x.last_ts,
  }));
  return { total, items };
}

// ---------------------------------------------------------------------------
// Genres
// ---------------------------------------------------------------------------

const GENRE_PREFIX: Record<GenreSource, { key: string; src: "d" | "m"; covered: string; total: string }> = {
  deezer: { key: "gd:", src: "d", covered: "gdc", total: "mt" },
  musicbrainz: { key: "gm:", src: "m", covered: "gmc", total: "gmt" },
};

export async function topGenres(env: Env, sp: StoredPeriod, source: GenreSource, limit: number): Promise<TopGenresResponse> {
  const g = GENRE_PREFIX[source];
  const [ranked, cov] = await env.DB.batch([
    env.DB.prepare(
      `SELECT substr(k, ${g.key.length + 1}) AS genre, ms, n FROM roll_facts
        WHERE p = ?1 AND k >= ?2 AND k < ?3 AND ms >= 0.5 ORDER BY ms DESC LIMIT ?4`,
    ).bind(sp.p, g.key, after(g.key), limit),
    ...factsStmts(env, sp.p, [g.covered, g.total]),
  ]);
  const rows = (ranked?.results ?? []) as { genre: string; ms: number; n: number }[];
  const c = toFacts([cov]);

  // Artists behind each genre: the count is stored, the top five come off an index.
  const genres = rows.map((r) => r.genre);
  const perGenre = genres.length
    ? await env.DB.batch([
        ...factsStmts(env, sp.p, genres.map((x) => `gac:${g.src}:${x}`)),
        ...genres.map((x) =>
          env.DB.prepare("SELECT artist_id FROM roll_garts WHERE p = ?1 AND src = ?2 AND genre = ?3 ORDER BY ms DESC LIMIT 5").bind(sp.p, g.src, x),
        ),
      ])
    : [];
  const counts = toFacts([perGenre[0]]);
  const top = perGenre.slice(1).map((r) => ((r?.results ?? []) as { artist_id: string }[]).map((a) => a.artist_id));
  const artists = await hydrateArtists(env, top.flat());
  const items: GenreStat[] = rows.map((x, i) => ({
    genre: x.genre,
    ms: round(x.ms),
    plays: round(x.n),
    artists: round(fact(counts, `gac:${g.src}:${x.genre}`).n),
    topArtists: (top[i] ?? []).map((id) => artists.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a)),
  }));
  const total = fact(c, g.total).ms;
  return { source, coverage: total ? fact(c, g.covered).ms / total : 0, items };
}

export async function genreTimeline(env: Env, sp: StoredPeriod, source: GenreSource, bucket: Bucket, top: number): Promise<GenreTimelineResponse> {
  const ranked = await topGenres(env, sp, source, top);
  const genres = ranked.items.map((x) => x.genre);
  const src = GENRE_PREFIX[source].src;
  // Weeks are stored per year ('w2024:2024-12-30'); months as 'm:2024-12'.
  const [lo, hi] =
    bucket === "week" ? (sp.p === 0 ? ["w", "x"] : [`w${sp.p}:`, `w${sp.p};`]) : sp.p === 0 ? ["m:", "m;"] : [`m:${sp.p}-`, `m:${sp.p}.`];
  const { results } = await env.DB.prepare(
    `SELECT genre, b, ms FROM roll_gb WHERE src = ?1 AND genre IN (SELECT value FROM json_each(?2)) AND b >= ?3 AND b < ?4`,
  )
    .bind(src, JSON.stringify([...genres, "*"]), lo, hi)
    .all<{ genre: string; b: string; ms: number }>();

  const byT = new Map<string, Map<string, number>>();
  for (const r of results) {
    const t = bucket === "week" ? r.b.slice(r.b.indexOf(":") + 1) : bucket === "year" ? r.b.slice(2, 6) : r.b.slice(2);
    const m = byT.get(t) ?? new Map<string, number>();
    m.set(r.genre, (m.get(r.genre) ?? 0) + num(r.ms));
    byT.set(t, m);
  }
  const { from, to, tz } = sp.range;
  const points = bucketLabels(bucket, tz, from, to).map((t) => {
    const m = byT.get(t);
    const values: Record<string, number> = {};
    let named = 0;
    for (const x of genres) {
      values[x] = Math.round(m?.get(x) ?? 0);
      named += m?.get(x) ?? 0;
    }
    return { t, values, otherMs: Math.max(0, Math.round((m?.get("*") ?? 0) - named)) };
  });
  return { bucket, genres, points };
}

// ---------------------------------------------------------------------------
// Clock and mood
// ---------------------------------------------------------------------------

export async function clock(env: Env, sp: StoredPeriod): Promise<ClockResponse> {
  const f = await facts(env, sp.p, [], ["c:"]);
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let maxMs = 0;
  for (const [k, v] of family(f, "c:")) {
    const [wd, h] = k.split(":").map(Number);
    if (wd! >= 0 && wd! < 7 && h! >= 0 && h! < 24) {
      cells[wd!]![h!] = round(v.ms);
      maxMs = Math.max(maxMs, round(v.ms));
    }
  }
  return { cells, maxMs };
}

export async function mood(env: Env, sp: StoredPeriod, bucket: Bucket): Promise<MoodResponse> {
  const fs = factsStmts(env, sp.p, ["mt"], ["mf:", "mh:", "mhe:", "mhv:", "meh:", "mvh:", "mth:", "mq:"]);
  const results = await env.DB.batch([
    ...fs,
    env.DB.prepare(
      `SELECT s.song_id AS id, s.ms, af.energy, af.valence FROM roll_songs s JOIN audio_features af ON af.track_id = s.song_id
        WHERE s.p = ?1 AND af.energy IS NOT NULL AND af.valence IS NOT NULL ORDER BY s.ms DESC LIMIT 500`,
    ).bind(sp.p),
  ]);
  const f = toFacts(results.slice(0, fs.length));
  const tracks = results[fs.length];
  const avg = (k: string) => ratio(fact(f, k).ms, fact(f, k).n);
  const averages = {} as AudioFeatures;
  for (const x of FEATURES) averages[x] = avg(`mf:${x}`);

  const bins = (prefix: string, n: number) => {
    const out = Array.from({ length: n }, () => 0);
    for (const [k, v] of family(f, prefix)) {
      const b = Number(k);
      if (b >= 0 && b < n) out[b] = round(v.ms);
    }
    return out;
  };
  const q = { happy: 0, energetic: 0, tense: 0, sad: 0, calm: 0 };
  for (const [k, v] of family(f, "mq:")) if (k in q) q[k as keyof typeof q] = round(v.ms);

  const scatter = await moodTracks(env, (tracks?.results ?? []) as MoodTrackRow[]);
  return {
    coverage: ratio(fact(f, "mf:energy").n, fact(f, "mt").ms) ?? 0,
    averages,
    byHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      energy: avg(`mhe:${hour}`),
      valence: avg(`mhv:${hour}`),
      ms: round(fact(f, `mh:${hour}`).ms),
    })),
    byPeriod: await moodByPeriod(env, sp, bucket),
    bucket,
    energyHistogram: bins("meh:", 10),
    valenceHistogram: bins("mvh:", 10),
    tempoHistogram: bins("mth:", 14).map((ms, i) => ({ bpm: 60 + i * 10, ms })),
    quadrants: q,
    ...scatter,
  };
}

async function moodByPeriod(env: Env, sp: StoredPeriod, bucket: Bucket): Promise<MoodResponse["byPeriod"]> {
  const sums = new Map<string, { music: number; e: Fact; v: Fact; d: Fact }>();
  if (bucket === "year") {
    const years = await yearsOf(env, sp);
    (await factsByPeriod(env, years, ["mt", "mf:energy", "mf:valence", "mf:danceability"])).forEach((f, i) =>
      sums.set(String(years[i]), { music: fact(f, "mt").ms, e: fact(f, "mf:energy"), v: fact(f, "mf:valence"), d: fact(f, "mf:danceability") }),
    );
  } else {
    const [lo, hi] = dayRange(sp);
    const { results } = await env.DB.prepare(
      `SELECT day, ms - spoken_ms AS music, e_sum, e_ms, v_sum, v_ms, d_sum, d_ms FROM roll_days
        WHERE day >= ?1 AND day < ?2 AND ms > spoken_ms`,
    )
      .bind(lo, hi)
      .all<{ day: string; music: number; e_sum: number; e_ms: number; v_sum: number; v_ms: number; d_sum: number; d_ms: number }>();
    for (const r of results) {
      const t = labelOf(bucket, r.day);
      const s = sums.get(t) ?? { music: 0, e: { ms: 0, n: 0 }, v: { ms: 0, n: 0 }, d: { ms: 0, n: 0 } };
      s.music += num(r.music);
      s.e.ms += num(r.e_sum);
      s.e.n += num(r.e_ms);
      s.v.ms += num(r.v_sum);
      s.v.n += num(r.v_ms);
      s.d.ms += num(r.d_sum);
      s.d.n += num(r.d_ms);
      sums.set(t, s);
    }
  }
  return [...sums.entries()]
    .filter(([, s]) => s.music > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, s]) => ({ t, energy: ratio(s.e.ms, s.e.n), valence: ratio(s.v.ms, s.v.n), danceability: ratio(s.d.ms, s.d.n) }));
}

// ---------------------------------------------------------------------------
// Podcasts, habits, data coverage
// ---------------------------------------------------------------------------

export async function podcasts(env: Env, sp: StoredPeriod): Promise<PodcastsResponse> {
  const [shows, episodes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT x.show_id AS id, s.name, COALESCE(s.image_url, (SELECT MAX(e.image_url) FROM episodes e WHERE e.show_id = x.show_id)) AS image_url,
              x.kind, x.ms, x.episodes, x.last_ts
         FROM roll_shows x LEFT JOIN shows s ON s.id = x.show_id
        WHERE x.p = ?1 ORDER BY x.ms DESC LIMIT 100`,
    ).bind(sp.p),
    env.DB.prepare(
      `SELECT x.episode_id AS id, e.name, s.name AS show, x.ms, x.streams, x.last_ts
         FROM roll_episodes x JOIN episodes e ON e.id = x.episode_id LEFT JOIN shows s ON s.id = e.show_id
        WHERE x.p = ?1 ORDER BY x.ms DESC LIMIT 200`,
    ).bind(sp.p),
  ]);
  return {
    shows: ((shows?.results ?? []) as { id: string; name: string | null; image_url: string | null; kind: "episode" | "audiobook"; ms: number; episodes: number; last_ts: number }[]).map(
      (s) => ({ id: s.id, name: s.name ?? "Unknown show", imageUrl: s.image_url, kind: s.kind, ms: num(s.ms), episodes: num(s.episodes), lastTs: s.last_ts }),
    ),
    episodes: ((episodes?.results ?? []) as { id: string; name: string; show: string | null; ms: number; streams: number; last_ts: number }[]).map((e) => ({
      id: e.id,
      name: e.name,
      show: e.show,
      ms: num(e.ms),
      streams: num(e.streams),
      lastTs: e.last_ts,
    })),
  };
}

export async function habits(env: Env, sp: StoredPeriod, bucket: Bucket, now = Date.now()): Promise<HabitsResponse> {
  const [lo, hi] = dayRange(sp);
  const years = await yearsOf(env, sp);
  const [f, [days, longest], perYear] = await Promise.all([
    facts(env, sp.p, ["tot", "detailed", "shuffle", "offline", "skips", "ss"], ["pf:", "cc:", "rs:", "re:"]),
    env.DB.batch([
      env.DB.prepare("SELECT day, streams, new_songs, new_artists FROM roll_days WHERE day >= ?1 AND day < ?2").bind(lo, hi),
      sp.p === 0
        ? env.DB.prepare("SELECT start, end, ms FROM roll_sessions ORDER BY ms DESC LIMIT 1")
        : env.DB.prepare("SELECT start, end, ms FROM roll_sessions WHERE p = ?1 ORDER BY ms DESC LIMIT 1").bind(sp.p),
    ]),
    factsByPeriod(env, years, ["tot", "plays", "songs", "artists"]),
  ]);
  const streams = fact(f, "tot").n;

  const families = new Map<string, { name: string; ms: number; streams: number }>();
  for (const [raw, v] of family(f, "pf:")) {
    const name = platformFamily(raw);
    const x = families.get(name) ?? { name, ms: 0, streams: 0 };
    x.ms += round(v.ms);
    x.streams += round(v.n);
    families.set(name, x);
  }
  const reasons = (prefix: string) =>
    family(f, prefix)
      .filter(([, v]) => v.n > 0)
      .map(([reason, v]) => ({ reason, streams: round(v.n) }))
      .sort((a, b) => b.streams - a.streams);

  const dayRows = (days?.results ?? []) as { day: string; streams: number; new_songs: number; new_artists: number }[];
  const discoveries = new Map<string, { t: string; newArtists: number; newTracks: number }>();
  for (const d of dayRows) {
    if (!d.new_songs && !d.new_artists) continue;
    const t = labelOf(bucket, d.day);
    const x = discoveries.get(t) ?? { t, newArtists: 0, newTracks: 0 };
    x.newTracks += num(d.new_songs);
    x.newArtists += num(d.new_artists);
    discoveries.set(t, x);
  }

  const sessions = fact(f, "ss");
  const top = (longest?.results?.[0] ?? null) as { start: number; end: number; ms: number } | null;
  const todayLocal = new Date(now + offsetAt(sp.range.tz, now)).toISOString().slice(0, 10);
  return {
    detailedCoverage: streams ? fact(f, "detailed").n / streams : 0,
    platforms: [...families.values()].sort((a, b) => b.ms - a.ms),
    countries: family(f, "cc:")
      .filter(([, v]) => v.n > 0)
      .map(([code, v]) => ({ code, ms: round(v.ms), streams: round(v.n) }))
      .sort((a, b) => b.ms - a.ms),
    reasonsStart: reasons("rs:"),
    reasonsEnd: reasons("re:"),
    shuffleShare: ratio(fact(f, "shuffle").ms, fact(f, "shuffle").n),
    offlineShare: ratio(fact(f, "offline").ms, fact(f, "offline").n),
    skipRate: streams ? fact(f, "skips").n / streams : null,
    streaks: streaks(
      dayRows.filter((d) => d.streams > 0).map((d) => d.day),
      todayLocal,
    ),
    byYear: years
      .map((year, i) => {
        const y = perYear[i] ?? new Map();
        return { year, ms: round(fact(y, "tot").ms), plays: round(fact(y, "plays").n), tracks: round(fact(y, "songs").n), artists: round(fact(y, "artists").n) };
      })
      .filter((y) => y.ms > 0 || y.plays > 0),
    discoveries: [...discoveries.values()].sort((a, b) => a.t.localeCompare(b.t)),
    bucket,
    sessions: {
      count: round(sessions.n),
      avgMs: sessions.n ? Math.round(sessions.ms / sessions.n) : 0,
      longest: top ? { start: top.start, end: top.end, ms: num(top.ms) } : null,
    },
  };
}

/** Listens per month and source (the Data page). */
export async function coverage(env: Env): Promise<DataStatusResponse["coverage"]> {
  const { results } = await env.DB.prepare(
    `SELECT substr(day, 1, 7) AS month, SUM(extended) AS extended, SUM(account) AS account, SUM(live) AS live, SUM(dups) AS duplicates
       FROM roll_days GROUP BY month HAVING SUM(extended) + SUM(account) + SUM(live) + SUM(dups) > 0 ORDER BY month`,
  ).all<{ month: string; extended: number; account: number; live: number; duplicates: number }>();
  return results.map((r) => ({ month: r.month, extended: num(r.extended), account: num(r.account), live: num(r.live), duplicates: num(r.duplicates) }));
}
