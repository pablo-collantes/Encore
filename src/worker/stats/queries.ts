// Every dashboard aggregate. All of them read `listens` filtered to
// `dup_of IS NULL` and a ts range (the covering partial index
// idx_listens_canon), group on `song_id` (one id per recording), and only then
// join names in through hydrate.ts.

import type {
  AlbumStat,
  ArtistStat,
  AudioFeatures,
  Bucket,
  ClockResponse,
  GenreSource,
  GenreStat,
  GenreTimelineResponse,
  HistoryResponse,
  ListenRow,
  MoodResponse,
  MoodTrack,
  OverviewResponse,
  SummaryResponse,
  TimelineResponse,
  TopAlbumsResponse,
  TopArtistsResponse,
  TopGenresResponse,
  TopTracksResponse,
  Totals,
  TrackStat,
} from "../../shared/api";
import { HISTORY_MAX_ROWS } from "../../shared/api";
import type { Env } from "../types";
import { hydrateAlbums, hydrateArtists, hydrateTracks, missingTrack } from "./hydrate";
import { bucketLabels, bucketSql, localMsSql } from "./tz";

export interface Range {
  from: number;
  to: number;
  tz: string;
}

/** A track's listens counted under its canonical recording. */
export const songOf = (param: string) => `COALESCE((SELECT canonical_id FROM tracks WHERE id = ${param}), ${param})`;

/** Restrict listens (alias l) to one entity. Returns SQL with ?N placeholders starting at `n`. */
export interface EntityFilter {
  artist?: string | null;
  track?: string | null;
  album?: string | null;
  genre?: string | null;
  genreSource?: GenreSource;
}

function entitySql(f: EntityFilter, n: number): { sql: string; binds: unknown[] } {
  if (f.artist) return { sql: ` AND l.song_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?${n})`, binds: [f.artist] };
  if (f.track) return { sql: ` AND l.song_id = ${songOf(`?${n}`)}`, binds: [f.track] };
  if (f.album) return { sql: ` AND l.song_id IN (SELECT id FROM tracks WHERE album_id = ?${n})`, binds: [f.album] };
  if (f.genre && f.genreSource === "musicbrainz") {
    return {
      sql: ` AND l.song_id IN (SELECT ta.track_id FROM track_artists ta JOIN artist_tags g ON g.artist_id = ta.artist_id WHERE g.tag = ?${n})`,
      binds: [f.genre],
    };
  }
  if (f.genre) return { sql: ` AND l.song_id IN (SELECT track_id FROM track_genres WHERE genre = ?${n})`, binds: [f.genre] };
  return { sql: "", binds: [] };
}

/** `LIKE` pattern for a user search string, with wildcards escaped. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// Summary / overview / timeline
// ---------------------------------------------------------------------------

export async function summary(env: Env, tz: string): Promise<SummaryResponse> {
  const [totals, sources] = await env.DB.batch([
    env.DB.prepare(
      "SELECT MIN(ts) AS first, MAX(ts) AS last, COALESCE(SUM(ms_played), 0) AS ms, COUNT(*) AS n FROM listens WHERE dup_of IS NULL",
    ),
    env.DB.prepare("SELECT source, COUNT(*) AS n FROM listens WHERE dup_of IS NULL GROUP BY source"),
  ]);
  const t = (totals?.results?.[0] ?? {}) as { first: number | null; last: number | null; ms: number; n: number };
  const bySource = { extended: 0, account: 0, live: 0 };
  for (const r of (sources?.results ?? []) as { source: keyof typeof bySource; n: number }[]) bySource[r.source] = r.n;

  let years: number[] = [];
  if (t.first !== null && t.last !== null) {
    const local = localMsSql(tz, t.first, t.last);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT CAST(strftime('%Y', ${local} / 1000, 'unixepoch') AS INTEGER) AS y
         FROM listens WHERE dup_of IS NULL ORDER BY y DESC`,
    ).all<{ y: number }>();
    years = results.map((r) => r.y);
  }
  return { firstTs: t.first ?? null, lastTs: t.last ?? null, totalMs: num(t.ms), totalStreams: num(t.n), sources: bySource, years };
}

async function totalsFor(env: Env, r: Range, f: EntityFilter = {}): Promise<Totals> {
  const local = localMsSql(r.tz, r.from, r.to, "l.ts");
  const e = entitySql(f, 3);
  const where = `l.dup_of IS NULL AND l.ts >= ?1 AND l.ts < ?2${e.sql}`;
  const [main, artists, albums] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(SUM(l.ms_played), 0) AS ms, COUNT(*) AS streams,
              COALESCE(SUM(l.ms_played >= 30000), 0) AS plays,
              COALESCE(SUM(CASE WHEN l.ms_played < 30000 OR l.skipped = 1 THEN 1 ELSE 0 END), 0) AS skips,
              COUNT(DISTINCT l.song_id) AS tracks,
              COUNT(DISTINCT date(${local} / 1000, 'unixepoch')) AS active_days,
              COALESCE(SUM(CASE WHEN l.kind != 'track' THEN l.ms_played END), 0) AS spoken_ms
         FROM listens l WHERE ${where}`,
    ).bind(r.from, r.to, ...e.binds),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT ta.artist_id) AS n FROM listens l JOIN track_artists ta ON ta.track_id = l.song_id
        WHERE ${where} AND l.kind = 'track'`,
    ).bind(r.from, r.to, ...e.binds),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT t.album_id) AS n FROM listens l JOIN tracks t ON t.id = l.song_id
        WHERE ${where} AND l.kind = 'track'`,
    ).bind(r.from, r.to, ...e.binds),
  ]);
  const m = (main?.results?.[0] ?? {}) as Record<string, number>;
  return {
    ms: num(m.ms),
    streams: num(m.streams),
    plays: num(m.plays),
    skips: num(m.skips),
    tracks: num(m.tracks),
    artists: num((artists?.results?.[0] as { n?: number } | undefined)?.n),
    albums: num((albums?.results?.[0] as { n?: number } | undefined)?.n),
    activeDays: num(m.active_days),
    spokenMs: num(m.spoken_ms),
  };
}

export async function overview(env: Env, r: Range, f: EntityFilter = {}): Promise<OverviewResponse> {
  const span = r.to - r.from;
  const [totals, previous] = await Promise.all([
    totalsFor(env, r, f),
    span > 0 && r.from - span > 0 ? totalsFor(env, { ...r, from: r.from - span, to: r.from }, f) : Promise.resolve(null),
  ]);
  return { totals, previous };
}

export { totalsFor };

export async function timeline(env: Env, r: Range, bucket: Bucket, f: EntityFilter = {}): Promise<TimelineResponse> {
  const local = localMsSql(r.tz, r.from, r.to, "l.ts");
  const e = entitySql(f, 3);
  const { results } = await env.DB.prepare(
    `SELECT ${bucketSql(bucket, local)} AS t, SUM(l.ms_played) AS ms, SUM(l.ms_played >= 30000) AS plays, COUNT(*) AS streams
       FROM listens l WHERE l.dup_of IS NULL AND l.ts >= ?1 AND l.ts < ?2${e.sql}
      GROUP BY t`,
  )
    .bind(r.from, r.to, ...e.binds)
    .all<{ t: string; ms: number; plays: number; streams: number }>();
  const byLabel = new Map(results.map((p) => [p.t, p]));
  const points = bucketLabels(bucket, r.tz, r.from, r.to).map((t) => {
    const p = byLabel.get(t);
    return { t, ms: num(p?.ms), plays: num(p?.plays), streams: num(p?.streams) };
  });
  return { bucket, points };
}

// ---------------------------------------------------------------------------
// Top lists
// ---------------------------------------------------------------------------

export interface ListOpts {
  limit: number;
  offset: number;
  q?: string | null;
  sort?: string | null;
}

export async function topArtists(env: Env, r: Range, o: ListOpts): Promise<TopArtistsResponse> {
  const binds: unknown[] = [r.from, r.to];
  let filter = "";
  if (o.q) {
    binds.push(likePattern(o.q));
    filter = ` AND ta.artist_id IN (SELECT id FROM artists WHERE name LIKE ?${binds.length} ESCAPE '\\')`;
  }
  const order = o.sort === "plays" ? "plays DESC, ms DESC" : "ms DESC";
  binds.push(o.limit, o.offset);
  const { results } = await env.DB.prepare(
    `SELECT ta.artist_id AS id, SUM(l.ms_played) AS ms, SUM(l.ms_played >= 30000) AS plays, COUNT(*) AS streams,
            COUNT(DISTINCT l.song_id) AS tracks, MIN(l.ts) AS first_ts, MAX(l.ts) AS last_ts,
            COUNT(*) OVER () AS total
       FROM listens l JOIN track_artists ta ON ta.track_id = l.song_id
      WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2${filter}
      GROUP BY ta.artist_id ORDER BY ${order} LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`,
  )
    .bind(...binds)
    .all<{ id: string; ms: number; plays: number; streams: number; tracks: number; first_ts: number; last_ts: number; total: number }>();
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
  return { total: results[0]?.total ?? (o.offset > 0 ? o.offset : 0), items };
}

export async function topTracks(env: Env, r: Range, o: ListOpts & { artist?: string | null; album?: string | null }): Promise<TopTracksResponse> {
  const binds: unknown[] = [r.from, r.to];
  let filter = "";
  if (o.artist) {
    binds.push(o.artist);
    filter += ` AND l.song_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?${binds.length})`;
  }
  if (o.album) {
    binds.push(o.album);
    filter += ` AND l.song_id IN (SELECT id FROM tracks WHERE album_id = ?${binds.length})`;
  }
  if (o.q) {
    binds.push(likePattern(o.q));
    const n = binds.length;
    filter += ` AND (l.song_id IN (SELECT id FROM tracks WHERE name LIKE ?${n} ESCAPE '\\')
                     OR l.song_id IN (SELECT ta.track_id FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                                       WHERE a.name LIKE ?${n} ESCAPE '\\'))`;
  }
  const order = o.sort === "plays" ? "plays DESC, ms DESC" : o.sort === "skips" ? "skips DESC, streams DESC" : "ms DESC";
  binds.push(o.limit, o.offset);
  const { results } = await env.DB.prepare(
    `SELECT l.song_id AS id, SUM(l.ms_played) AS ms, SUM(l.ms_played >= 30000) AS plays, COUNT(*) AS streams,
            SUM(CASE WHEN l.ms_played < 30000 OR l.skipped = 1 THEN 1 ELSE 0 END) AS skips,
            MIN(l.ts) AS first_ts, MAX(l.ts) AS last_ts, COUNT(*) OVER () AS total
       FROM listens l
      WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.song_id IS NOT NULL AND l.ts >= ?1 AND l.ts < ?2${filter}
      GROUP BY l.song_id ORDER BY ${order} LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`,
  )
    .bind(...binds)
    .all<{ id: string; ms: number; plays: number; streams: number; skips: number; first_ts: number; last_ts: number; total: number }>();
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
  return { total: results[0]?.total ?? 0, items };
}

export async function featuresFor(env: Env, ids: string[]): Promise<Map<string, { energy: number | null; valence: number | null }>> {
  const out = new Map<string, { energy: number | null; valence: number | null }>();
  if (!ids.length) return out;
  const { results } = await env.DB.prepare(
    "SELECT track_id, energy, valence FROM audio_features WHERE track_id IN (SELECT value FROM json_each(?1))",
  )
    .bind(JSON.stringify(ids))
    .all<{ track_id: string; energy: number | null; valence: number | null }>();
  for (const r of results) out.set(r.track_id, { energy: r.energy, valence: r.valence });
  return out;
}

export async function topAlbums(env: Env, r: Range, o: ListOpts & { artist?: string | null }): Promise<TopAlbumsResponse> {
  const binds: unknown[] = [r.from, r.to];
  let filter = "";
  if (o.artist) {
    binds.push(o.artist);
    filter += ` AND l.song_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?${binds.length})`;
  }
  if (o.q) {
    binds.push(likePattern(o.q));
    filter += ` AND t.album_id IN (SELECT id FROM albums WHERE name LIKE ?${binds.length} ESCAPE '\\')`;
  }
  const order = o.sort === "plays" ? "plays DESC, ms DESC" : "ms DESC";
  binds.push(o.limit, o.offset);
  const { results } = await env.DB.prepare(
    `SELECT t.album_id AS id, SUM(l.ms_played) AS ms, SUM(l.ms_played >= 30000) AS plays, COUNT(*) AS streams,
            COUNT(DISTINCT l.song_id) AS tracks, MIN(l.ts) AS first_ts, MAX(l.ts) AS last_ts, COUNT(*) OVER () AS total
       FROM listens l JOIN tracks t ON t.id = l.song_id
      WHERE l.dup_of IS NULL AND l.kind = 'track' AND t.album_id IS NOT NULL AND l.ts >= ?1 AND l.ts < ?2${filter}
      GROUP BY t.album_id ORDER BY ${order} LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`,
  )
    .bind(...binds)
    .all<{ id: string; ms: number; plays: number; streams: number; tracks: number; first_ts: number; last_ts: number; total: number }>();
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
  return { total: results[0]?.total ?? 0, items };
}

// ---------------------------------------------------------------------------
// Genres
// ---------------------------------------------------------------------------

/**
 * Per-song (deezer) or per-artist (musicbrainz) genre weights. A song with
 * three broad genres gives each a third of its time; an artist's detailed
 * genres share its time in proportion to their MusicBrainz votes.
 */
const DEEZER_WEIGHTS = `SELECT track_id AS k, genre, 1.0 / COUNT(*) OVER (PARTITION BY track_id) AS w FROM track_genres`;
const MB_WEIGHTS = `SELECT artist_id AS k, tag AS genre, votes * 1.0 / SUM(votes) OVER (PARTITION BY artist_id) AS w FROM artist_tags`;

/** Listening per key (song or artist) in the range: the left side of the genre joins. */
function listeningByKey(source: GenreSource): string {
  return source === "deezer"
    ? `SELECT l.song_id AS k, SUM(l.ms_played) AS ms, SUM(l.ms_played >= 30000) AS plays
         FROM listens l WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2 GROUP BY l.song_id`
    : `SELECT ta.artist_id AS k, SUM(l.ms_played) AS ms, SUM(l.ms_played >= 30000) AS plays
         FROM listens l JOIN track_artists ta ON ta.track_id = l.song_id
        WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2 GROUP BY ta.artist_id`;
}

export async function topGenres(env: Env, r: Range, source: GenreSource, limit: number): Promise<TopGenresResponse> {
  const weights = source === "deezer" ? DEEZER_WEIGHTS : MB_WEIGHTS;
  const [ranked, coverage] = await env.DB.batch([
    env.DB.prepare(
      `WITH f AS (${listeningByKey(source)}), w AS (${weights})
       SELECT w.genre, SUM(f.ms * w.w) AS ms, SUM(f.plays * w.w) AS plays
         FROM f JOIN w ON w.k = f.k GROUP BY w.genre ORDER BY ms DESC LIMIT ?3`,
    ).bind(r.from, r.to, limit),
    env.DB.prepare(
      `WITH f AS (${listeningByKey(source)})
       SELECT SUM(f.ms) AS total,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM ${source === "deezer" ? "track_genres g WHERE g.track_id" : "artist_tags g WHERE g.artist_id"} = f.k)
                       THEN f.ms END) AS covered
         FROM f`,
    ).bind(r.from, r.to),
  ]);
  const rows = (ranked?.results ?? []) as { genre: string; ms: number; plays: number }[];
  const cov = (coverage?.results?.[0] ?? {}) as { total: number | null; covered: number | null };

  // Artists behind each genre: count, and the top few by time for avatars.
  const genres = rows.map((x) => x.genre);
  const artistRows = genres.length
    ? (
        await env.DB.prepare(
          source === "deezer"
            ? `WITH f AS (${listeningByKey("deezer")})
               SELECT g.genre, ta.artist_id, SUM(f.ms) AS ms
                 FROM f JOIN track_genres g ON g.track_id = f.k JOIN track_artists ta ON ta.track_id = f.k
                WHERE g.genre IN (SELECT value FROM json_each(?3))
                GROUP BY g.genre, ta.artist_id`
            : `WITH f AS (${listeningByKey("musicbrainz")})
               SELECT g.tag AS genre, f.k AS artist_id, f.ms
                 FROM f JOIN artist_tags g ON g.artist_id = f.k
                WHERE g.tag IN (SELECT value FROM json_each(?3))`,
        )
          .bind(r.from, r.to, JSON.stringify(genres))
          .all<{ genre: string; artist_id: string; ms: number }>()
      ).results
    : [];
  const byGenre = new Map<string, { artist_id: string; ms: number }[]>();
  for (const a of artistRows) {
    const arr = byGenre.get(a.genre) ?? [];
    arr.push(a);
    byGenre.set(a.genre, arr);
  }
  const topIds = new Set<string>();
  for (const arr of byGenre.values()) {
    arr.sort((a, b) => b.ms - a.ms);
    arr.slice(0, 5).forEach((a) => topIds.add(a.artist_id));
  }
  const artists = await hydrateArtists(env, [...topIds]);
  const items: GenreStat[] = rows.map((x) => {
    const arr = byGenre.get(x.genre) ?? [];
    return {
      genre: x.genre,
      ms: Math.round(num(x.ms)),
      plays: Math.round(num(x.plays)),
      artists: arr.length,
      topArtists: arr
        .slice(0, 5)
        .map((a) => artists.get(a.artist_id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a)),
    };
  });
  return { source, coverage: cov.total ? num(cov.covered) / cov.total : 0, items };
}

export async function genreTimeline(env: Env, r: Range, source: GenreSource, bucket: Bucket, top: number): Promise<GenreTimelineResponse> {
  const ranked = await topGenres(env, r, source, top);
  const genres = ranked.items.map((g) => g.genre);
  const local = localMsSql(r.tz, r.from, r.to, "l.ts");
  const weights = source === "deezer" ? DEEZER_WEIGHTS : MB_WEIGHTS;
  const keyed =
    source === "deezer"
      ? `SELECT ${bucketSql(bucket, local)} AS t, l.song_id AS k, SUM(l.ms_played) AS ms
           FROM listens l WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2 GROUP BY t, l.song_id`
      : `SELECT ${bucketSql(bucket, local)} AS t, ta.artist_id AS k, SUM(l.ms_played) AS ms
           FROM listens l JOIN track_artists ta ON ta.track_id = l.song_id
          WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2 GROUP BY t, ta.artist_id`;
  const { results } = await env.DB.prepare(
    `WITH f AS (${keyed}), w AS (${weights})
     SELECT f.t, w.genre, SUM(f.ms * w.w) AS ms FROM f JOIN w ON w.k = f.k GROUP BY f.t, w.genre`,
  )
    .bind(r.from, r.to)
    .all<{ t: string; genre: string; ms: number }>();

  const wanted = new Set(genres);
  const byT = new Map<string, { values: Record<string, number>; otherMs: number }>();
  for (const row of results) {
    const p = byT.get(row.t) ?? { values: {}, otherMs: 0 };
    if (wanted.has(row.genre)) p.values[row.genre] = Math.round(num(row.ms));
    else p.otherMs += num(row.ms);
    byT.set(row.t, p);
  }
  const points = bucketLabels(bucket, r.tz, r.from, r.to).map((t) => {
    const p = byT.get(t);
    const values: Record<string, number> = {};
    for (const g of genres) values[g] = p?.values[g] ?? 0;
    return { t, values, otherMs: Math.round(p?.otherMs ?? 0) };
  });
  return { bucket, genres, points };
}

// ---------------------------------------------------------------------------
// Listening clock
// ---------------------------------------------------------------------------

export async function clock(env: Env, r: Range, f: EntityFilter = {}): Promise<ClockResponse> {
  // Attribute each stream to the hour of its midpoint, not its end.
  const local = localMsSql(r.tz, r.from, r.to, "(l.ts - l.ms_played / 2)");
  const e = entitySql(f, 3);
  const { results } = await env.DB.prepare(
    `SELECT (CAST(strftime('%w', ${local} / 1000, 'unixepoch') AS INTEGER) + 6) % 7 AS wd,
            CAST(strftime('%H', ${local} / 1000, 'unixepoch') AS INTEGER) AS h,
            SUM(l.ms_played) AS ms
       FROM listens l WHERE l.dup_of IS NULL AND l.ts >= ?1 AND l.ts < ?2${e.sql}
      GROUP BY wd, h`,
  )
    .bind(r.from, r.to, ...e.binds)
    .all<{ wd: number; h: number; ms: number }>();
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let maxMs = 0;
  for (const c of results) {
    if (c.wd >= 0 && c.wd < 7 && c.h >= 0 && c.h < 24) {
      cells[c.wd]![c.h] = num(c.ms);
      maxMs = Math.max(maxMs, num(c.ms));
    }
  }
  return { cells, maxMs };
}

// ---------------------------------------------------------------------------
// Mood & energy
// ---------------------------------------------------------------------------

const FEATURE_KEYS = ["energy", "valence", "danceability", "acousticness", "instrumentalness", "speechiness", "liveness", "tempo", "loudness"] as const;

/** Listening-time-weighted average of every feature, over listens matching `where`. */
function weightedFeaturesSql(): string {
  return FEATURE_KEYS.map(
    (k) => `SUM(af.${k} * l.ms_played) / NULLIF(SUM(CASE WHEN af.${k} IS NOT NULL THEN l.ms_played END), 0) AS ${k}`,
  ).join(",\n              ");
}

function toFeatures(row: Record<string, unknown> | undefined): AudioFeatures {
  const out = {} as AudioFeatures;
  for (const k of FEATURE_KEYS) out[k] = numOrNull(row?.[k]);
  return out;
}

export async function featuresAverage(env: Env, r: Range | null, f: EntityFilter): Promise<AudioFeatures | null> {
  const e = entitySql(f, 3);
  const row = await env.DB.prepare(
    `SELECT ${weightedFeaturesSql()}, SUM(CASE WHEN af.track_id IS NOT NULL THEN 1 ELSE 0 END) AS n
       FROM listens l JOIN audio_features af ON af.track_id = l.song_id
      WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2${e.sql}`,
  )
    .bind(r?.from ?? 0, r?.to ?? 8_640_000_000_000, ...e.binds)
    .first<Record<string, unknown>>();
  if (!row || !num(row.n)) return null;
  return toFeatures(row);
}

export async function mood(env: Env, r: Range, bucket: Bucket): Promise<MoodResponse> {
  const base = `FROM listens l LEFT JOIN audio_features af ON af.track_id = l.song_id
               WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2`;
  const hourLocal = localMsSql(r.tz, r.from, r.to, "(l.ts - l.ms_played / 2)");
  const local = localMsSql(r.tz, r.from, r.to, "l.ts");
  const wavg = (k: string) => `SUM(af.${k} * l.ms_played) / NULLIF(SUM(CASE WHEN af.${k} IS NOT NULL THEN l.ms_played END), 0)`;

  const [avg, byHour, byPeriod, energyH, valenceH, tempoH, quadrants, tracks] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${weightedFeaturesSql()}, SUM(l.ms_played) AS total_ms,
              SUM(CASE WHEN af.energy IS NOT NULL THEN l.ms_played END) AS covered_ms ${base}`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT CAST(strftime('%H', ${hourLocal} / 1000, 'unixepoch') AS INTEGER) AS hour,
              ${wavg("energy")} AS energy, ${wavg("valence")} AS valence, SUM(l.ms_played) AS ms
         ${base} GROUP BY hour ORDER BY hour`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT ${bucketSql(bucket, local)} AS t, ${wavg("energy")} AS energy, ${wavg("valence")} AS valence,
              ${wavg("danceability")} AS danceability
         ${base} GROUP BY t ORDER BY t`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT MIN(CAST(af.energy * 10 AS INTEGER), 9) AS b, SUM(l.ms_played) AS ms ${base} AND af.energy IS NOT NULL GROUP BY b`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT MIN(CAST(af.valence * 10 AS INTEGER), 9) AS b, SUM(l.ms_played) AS ms ${base} AND af.valence IS NOT NULL GROUP BY b`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT MIN(MAX(CAST((af.tempo - 60) / 10 AS INTEGER), 0), 13) AS b, SUM(l.ms_played) AS ms
         ${base} AND af.tempo IS NOT NULL AND af.tempo > 0 GROUP BY b`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT CASE
                WHEN af.energy >= 0.8 AND af.valence >= 0.5 THEN 'energetic'
                WHEN af.energy >= 0.5 AND af.valence >= 0.5 THEN 'happy'
                WHEN af.energy >= 0.5 THEN 'tense'
                WHEN af.valence >= 0.5 THEN 'calm'
                ELSE 'sad' END AS q,
              SUM(l.ms_played) AS ms
         ${base} AND af.energy IS NOT NULL AND af.valence IS NOT NULL GROUP BY q`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT l.song_id AS id, SUM(l.ms_played) AS ms, af.energy, af.valence
         FROM listens l JOIN audio_features af ON af.track_id = l.song_id
        WHERE l.dup_of IS NULL AND l.kind = 'track' AND l.ts >= ?1 AND l.ts < ?2
          AND af.energy IS NOT NULL AND af.valence IS NOT NULL
        GROUP BY l.song_id ORDER BY ms DESC LIMIT 500`,
    ).bind(r.from, r.to),
  ]);

  const a = (avg?.results?.[0] ?? {}) as Record<string, unknown>;
  const bins = (res: D1Result | undefined, n: number) => {
    const out = Array.from({ length: n }, () => 0);
    for (const row of (res?.results ?? []) as { b: number; ms: number }[]) if (row.b >= 0 && row.b < n) out[row.b] = num(row.ms);
    return out;
  };
  const tempoBins = bins(tempoH, 14);
  const q = { happy: 0, energetic: 0, tense: 0, sad: 0, calm: 0 };
  for (const row of (quadrants?.results ?? []) as { q: keyof typeof q; ms: number }[]) q[row.q] = num(row.ms);

  const scatter = await moodTracks(env, (tracks?.results ?? []) as MoodTrackRow[]);

  const hours = new Map(((byHour?.results ?? []) as { hour: number; energy: number | null; valence: number | null; ms: number }[]).map((h) => [h.hour, h]));
  return {
    coverage: num(a.total_ms) ? num(a.covered_ms) / num(a.total_ms) : 0,
    averages: toFeatures(a),
    byHour: Array.from({ length: 24 }, (_, hour) => {
      const h = hours.get(hour);
      return { hour, energy: numOrNull(h?.energy), valence: numOrNull(h?.valence), ms: num(h?.ms) };
    }),
    byPeriod: ((byPeriod?.results ?? []) as { t: string; energy: number | null; valence: number | null; danceability: number | null }[]).map(
      (p) => ({ t: p.t, energy: numOrNull(p.energy), valence: numOrNull(p.valence), danceability: numOrNull(p.danceability) }),
    ),
    bucket,
    energyHistogram: bins(energyH, 10),
    valenceHistogram: bins(valenceH, 10),
    tempoHistogram: tempoBins.map((ms, i) => ({ bpm: 60 + i * 10, ms })),
    quadrants: q,
    ...scatter,
  };
}

export interface MoodTrackRow {
  id: string;
  ms: number;
  energy: number;
  valence: number;
}

/** The scatter's tracks (top 500 by time, with energy and valence) and the extremes among them. */
export async function moodTracks(env: Env, rows: MoodTrackRow[]): Promise<Pick<MoodResponse, "tracks" | "extremes">> {
  const hydrated = await hydrateTracks(env, rows.map((t) => t.id));
  const all: MoodTrack[] = rows.map((t) => {
    const h = hydrated.get(t.id);
    return {
      id: t.id,
      name: h?.name ?? "Unknown track",
      artist: h?.artists.map((x) => x.name).join(", ") ?? "",
      imageUrl: h?.album?.imageUrl ?? null,
      energy: t.energy,
      valence: t.valence,
      ms: num(t.ms),
    };
  });
  // Extremes only among tracks you actually spent time with.
  const pool = all.filter((t) => t.ms >= 120_000);
  const by = (k: "energy" | "valence", dir: 1 | -1) => [...pool].sort((x, y) => dir * (y[k] - x[k])).slice(0, 8);
  return {
    tracks: all.slice(0, 150),
    extremes: {
      mostEnergetic: by("energy", 1),
      calmest: by("energy", -1),
      happiest: by("valence", 1),
      saddest: by("valence", -1),
    },
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryOpts {
  before: string | null;
  limit: number;
  q: string | null;
  from: number | null;
  to: number | null;
  artist: string | null;
  track: string | null;
  album: string | null;
  /** music = tracks, spoken = podcasts + audiobooks, or one exact kind. */
  kind: "music" | "spoken" | "track" | "episode" | "audiobook" | null;
  source: string | null;
  skipped: boolean;
  includeDuplicates: boolean;
}

interface ListenDbRow {
  id: number;
  ts: number;
  kind: ListenRow["kind"];
  source: ListenRow["source"];
  ms_played: number;
  ms_estimated: number;
  skipped: number | null;
  reason_start: string | null;
  reason_end: string | null;
  platform: string | null;
  country: string | null;
  shuffle: number | null;
  offline: number | null;
  context_uri: string | null;
  dup_of: number | null;
  song_id: string | null;
  episode_id: string | null;
}

const boolOrNull = (v: number | null) => (v === null ? null : v === 1);

export async function hydrateListens(env: Env, rows: ListenDbRow[]): Promise<ListenRow[]> {
  const tracks = await hydrateTracks(env, rows.map((r) => r.song_id));
  const episodeIds = [...new Set(rows.map((r) => r.episode_id).filter((x): x is string => Boolean(x)))];
  const episodes = new Map<string, ListenRow["episode"]>();
  if (episodeIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.name, s.id AS show_id, s.name AS show_name, COALESCE(s.image_url, e.image_url) AS image_url
         FROM episodes e LEFT JOIN shows s ON s.id = e.show_id
        WHERE e.id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify(episodeIds))
      .all<{ id: string; name: string; show_id: string | null; show_name: string | null; image_url: string | null }>();
    for (const e of results) {
      episodes.set(e.id, {
        id: e.id,
        name: e.name,
        show: e.show_id ? { id: e.show_id, name: e.show_name ?? "", imageUrl: e.image_url } : null,
      });
    }
  }
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    source: r.source,
    msPlayed: r.ms_played,
    msEstimated: r.ms_estimated === 1,
    skipped: r.ms_played < 30000 && r.source !== "live" ? true : boolOrNull(r.skipped),
    reasonStart: r.reason_start,
    reasonEnd: r.reason_end,
    platform: r.platform,
    country: r.country,
    shuffle: boolOrNull(r.shuffle),
    offline: boolOrNull(r.offline),
    contextUri: r.context_uri,
    dupOf: r.dup_of,
    track: r.song_id ? (tracks.get(r.song_id) ?? missingTrack(r.song_id)) : null,
    episode: r.episode_id ? (episodes.get(r.episode_id) ?? { id: r.episode_id, name: "Unknown episode", show: null }) : null,
  }));
}

/**
 * One page of the timeline, newest first, continuing from `before`. Each page
 * reads only its own rows (keyset paging), and a view stops after
 * HISTORY_MAX_ROWS: the whole history is the CSV download, not a scroll. The
 * cursor carries how many rows the view has shown ("ts_id_shown").
 */
export async function history(env: Env, o: HistoryOpts): Promise<HistoryResponse> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  if (!o.includeDuplicates) clauses.push("l.dup_of IS NULL");
  let shown = 0;
  if (o.before) {
    const [ts, id, n] = o.before.split("_").map((x) => Number.parseInt(x, 10));
    if (Number.isFinite(ts) && Number.isFinite(id)) clauses.push(`(l.ts < ${p(ts)} OR (l.ts = ${p(ts)} AND l.id < ${p(id)}))`);
    if (Number.isFinite(n) && n! > 0) shown = n!;
  }
  const limit = Math.min(o.limit, HISTORY_MAX_ROWS - shown);
  if (limit <= 0) return { items: [], nextBefore: null, capped: true };
  if (o.from !== null) clauses.push(`l.ts >= ${p(o.from)}`);
  if (o.to !== null) clauses.push(`l.ts < ${p(o.to)}`);
  if (o.artist) clauses.push(`l.song_id IN (SELECT track_id FROM track_artists WHERE artist_id = ${p(o.artist)})`);
  if (o.track) clauses.push(`l.song_id = ${songOf(p(o.track))}`);
  if (o.album) clauses.push(`l.song_id IN (SELECT id FROM tracks WHERE album_id = ${p(o.album)})`);
  if (o.kind === "music") clauses.push("l.kind = 'track'");
  else if (o.kind === "spoken") clauses.push("l.kind != 'track'");
  else if (o.kind) clauses.push(`l.kind = ${p(o.kind)}`);
  if (o.source === "extended" || o.source === "account" || o.source === "live") clauses.push(`l.source = ${p(o.source)}`);
  if (o.skipped) clauses.push("(l.skipped = 1 OR (l.ms_played < 30000 AND l.source != 'live'))");
  if (o.q) {
    const like = p(likePattern(o.q));
    clauses.push(`(l.song_id IN (SELECT id FROM tracks WHERE name LIKE ${like} ESCAPE '\\')
      OR l.song_id IN (SELECT ta.track_id FROM track_artists ta JOIN artists a ON a.id = ta.artist_id WHERE a.name LIKE ${like} ESCAPE '\\')
      OR l.episode_id IN (SELECT e.id FROM episodes e LEFT JOIN shows s ON s.id = e.show_id
                           WHERE e.name LIKE ${like} ESCAPE '\\' OR s.name LIKE ${like} ESCAPE '\\'))`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.ts, l.kind, l.source, l.ms_played, l.ms_estimated, l.skipped, l.reason_start, l.reason_end,
            l.platform, l.country, l.shuffle, l.offline, l.context_uri, l.dup_of, l.song_id, l.episode_id
       FROM listens l ${where} ORDER BY l.ts DESC, l.id DESC LIMIT ${p(limit + 1)}`,
  )
    .bind(...binds)
    .all<ListenDbRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const more = results.length > limit;
  const total = shown + page.length;
  return {
    items: await hydrateListens(env, page),
    nextBefore: more && last && total < HISTORY_MAX_ROWS ? `${last.ts}_${last.id}_${total}` : null,
    capped: more && total >= HISTORY_MAX_ROWS,
  };
}
