// Entity pages (artist / track / album), podcasts, habits, now playing,
// Spotify's top lists, data status and search.

import type {
  AlbumDetailResponse,
  ArtistDetailResponse,
  Bucket,
  DataStatusResponse,
  HabitsResponse,
  ImportBatch,
  NowResponse,
  PodcastsResponse,
  SearchResponse,
  SpotifyTimeRange,
  SpotifyTopResponse,
  TrackDetailResponse,
  TrackLite,
} from "../../shared/api";
import { REQUIRED_SCOPES } from "../../shared/api";
import type { Env } from "../types";
import type { ReadCache } from "../lib/cache";
import { STUB_SQL } from "./sql";
import { hydrateAlbums, hydrateArtists, hydrateTracks } from "./hydrate";
import { featuresAverage, history, likePattern, songOf, topTracks, totalsFor, type Range } from "./queries";
import { bucketSql, localMsSql, offsetAt } from "./tz";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const spotifyUrl = (type: string, id: string) => (id.startsWith("name:") || id.startsWith("local:") ? null : `https://open.spotify.com/${type}/${id}`);

/** First and last listen of a set of songs (`songFilter` is SQL on l.song_id with ?1). */
async function firstLast(env: Env, songFilter: string, bind: string): Promise<{ first: { ts: number; song: string } | null; last: { ts: number; song: string } | null }> {
  const [first, last] = await env.DB.batch([
    env.DB.prepare(`SELECT l.ts, l.song_id AS song FROM listens l WHERE l.dup_of IS NULL AND ${songFilter} ORDER BY l.ts ASC LIMIT 1`).bind(bind),
    env.DB.prepare(`SELECT l.ts, l.song_id AS song FROM listens l WHERE l.dup_of IS NULL AND ${songFilter} ORDER BY l.ts DESC LIMIT 1`).bind(bind),
  ]);
  return {
    first: ((first?.results?.[0] as { ts: number; song: string } | undefined) ?? null),
    last: ((last?.results?.[0] as { ts: number; song: string } | undefined) ?? null),
  };
}

export async function artistDetail(env: Env, id: string, r: Range): Promise<ArtistDetailResponse | null> {
  const artist = await env.DB.prepare("SELECT id, name, image_url, priority FROM artists WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; image_url: string | null; priority: number }>();
  if (!artist) return null;

  const songFilter = "l.song_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?1)";
  const [totals, fl, features, genreRows, rank] = await Promise.all([
    totalsFor(env, r, { artist: id }),
    firstLast(env, songFilter, id),
    featuresAverage(env, r, { artist: id }),
    env.DB.batch([
      env.DB.prepare(
        `SELECT g.genre, COUNT(*) AS n FROM track_genres g
          WHERE g.track_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?1)
          GROUP BY g.genre ORDER BY n DESC, g.genre LIMIT 5`,
      ).bind(id),
      env.DB.prepare("SELECT tag FROM artist_tags WHERE artist_id = ?1 ORDER BY votes DESC LIMIT 8").bind(id),
    ]),
    artist.priority > 0
      ? env.DB.prepare(`SELECT 1 + COUNT(*) AS rank FROM artists WHERE priority > ?1 AND NOT ${STUB_SQL("id")}`)
          .bind(artist.priority)
          .first<{ rank: number }>()
      : Promise.resolve(null),
  ]);
  const tracks = await hydrateTracks(env, [fl.first?.song, fl.last?.song]);
  return {
    artist: {
      id: artist.id,
      name: artist.name,
      imageUrl: artist.image_url,
      spotifyUrl: spotifyUrl("artist", artist.id),
      genres: {
        deezer: ((genreRows[0]?.results ?? []) as { genre: string }[]).map((g) => g.genre),
        musicbrainz: ((genreRows[1]?.results ?? []) as { tag: string }[]).map((g) => g.tag),
      },
    },
    totals,
    rankAllTime: rank?.rank ?? null,
    firstListen: fl.first ? { ts: fl.first.ts, track: tracks.get(fl.first.song) ?? null } : null,
    lastListen: fl.last ? { ts: fl.last.ts, track: tracks.get(fl.last.song) ?? null } : null,
    features,
  };
}

export async function trackDetail(env: Env, rawId: string, r: Range): Promise<TrackDetailResponse | null> {
  // Any version id resolves to the canonical recording the stats use.
  const row = await env.DB.prepare(
    `SELECT t.id, t.name, t.isrc, t.explicit, t.priority, al.release_date
       FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
      WHERE t.id = ${songOf("?1")}`,
  )
    .bind(rawId)
    .first<{ id: string; name: string; isrc: string | null; explicit: number | null; priority: number; release_date: string | null }>();
  if (!row) return null;
  const id = row.id;

  const [hydrated, totals, fl, extra] = await Promise.all([
    hydrateTracks(env, [id]),
    totalsFor(env, r, { track: id }),
    firstLast(env, "l.song_id = ?1", id),
    env.DB.batch([
      env.DB.prepare("SELECT * FROM audio_features WHERE track_id = ?1").bind(id),
      env.DB.prepare("SELECT genre FROM track_genres WHERE track_id = ?1").bind(id),
      env.DB.prepare(
        `SELECT COALESCE(reason_end, 'unknown') AS reason, COUNT(*) AS streams FROM listens
          WHERE dup_of IS NULL AND song_id = ?1 AND ts >= ?2 AND ts < ?3 AND source = 'extended'
          GROUP BY reason ORDER BY streams DESC`,
      ).bind(id, r.from, r.to),
      env.DB.prepare("SELECT id FROM tracks WHERE canonical_id = ?1").bind(id),
      env.DB.prepare(`SELECT 1 + COUNT(*) AS rank FROM tracks WHERE priority > ?1 AND canonical_id IS NULL AND NOT ${STUB_SQL("id")}`).bind(row.priority),
    ]),
  ]);
  const f = extra[0]?.results?.[0] as Record<string, number | string | null> | undefined;
  const versions = await hydrateTracks(env, ((extra[3]?.results ?? []) as { id: string }[]).map((v) => v.id));
  const lite = hydrated.get(id);
  const n = (k: string) => (typeof f?.[k] === "number" ? (f[k] as number) : null);
  return {
    track: {
      ...(lite ?? { id, name: row.name, artists: [], album: null, durationMs: null }),
      isrc: row.isrc,
      explicit: row.explicit === null ? null : row.explicit === 1,
      releaseDate: row.release_date,
      spotifyUrl: spotifyUrl("track", id),
      genres: ((extra[1]?.results ?? []) as { genre: string }[]).map((g) => g.genre),
    },
    totals,
    rankAllTime: row.priority > 0 ? ((extra[4]?.results?.[0] as { rank: number } | undefined)?.rank ?? null) : null,
    firstListen: fl.first?.ts ?? null,
    lastListen: fl.last?.ts ?? null,
    features: f
      ? {
          energy: n("energy"),
          valence: n("valence"),
          danceability: n("danceability"),
          acousticness: n("acousticness"),
          instrumentalness: n("instrumentalness"),
          speechiness: n("speechiness"),
          liveness: n("liveness"),
          tempo: n("tempo"),
          loudness: n("loudness"),
        }
      : null,
    featuresSource: f ? (f.source === "analysis" ? "analysis" : "reccobeats") : null,
    reasonsEnd: (extra[2]?.results ?? []) as { reason: string; streams: number }[],
    versions: [...versions.values()],
  };
}

export async function albumDetail(env: Env, id: string, r: Range): Promise<AlbumDetailResponse | null> {
  const row = await env.DB.prepare("SELECT id, album_type, total_tracks FROM albums WHERE id = ?")
    .bind(id)
    .first<{ id: string; album_type: string | null; total_tracks: number | null }>();
  if (!row) return null;
  const [albums, totals, fl, tracks] = await Promise.all([
    hydrateAlbums(env, [id]),
    totalsFor(env, r, { album: id }),
    firstLast(env, "l.song_id IN (SELECT id FROM tracks WHERE album_id = ?1)", id),
    topTracks(env, r, { album: id, limit: 100, offset: 0 }),
  ]);
  const album = albums.get(id)!;
  return {
    album: { ...album, spotifyUrl: spotifyUrl("album", id), albumType: row.album_type, totalTracks: row.total_tracks },
    totals,
    firstListen: fl.first?.ts ?? null,
    lastListen: fl.last?.ts ?? null,
    tracks: tracks.items,
  };
}

// ---------------------------------------------------------------------------

export async function podcasts(env: Env, r: Range): Promise<PodcastsResponse> {
  const [shows, episodes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT e.show_id AS id, s.name, COALESCE(s.image_url, MAX(e.image_url)) AS image_url, MIN(l.kind) AS kind,
              SUM(l.ms_played) AS ms, COUNT(DISTINCT l.episode_id) AS episodes, MAX(l.ts) AS last_ts
         FROM listens l JOIN episodes e ON e.id = l.episode_id LEFT JOIN shows s ON s.id = e.show_id
        WHERE l.dup_of IS NULL AND l.kind != 'track' AND l.ts >= ?1 AND l.ts < ?2
        GROUP BY e.show_id ORDER BY ms DESC LIMIT 100`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT l.episode_id AS id, e.name, s.name AS show, SUM(l.ms_played) AS ms, COUNT(*) AS streams, MAX(l.ts) AS last_ts
         FROM listens l JOIN episodes e ON e.id = l.episode_id LEFT JOIN shows s ON s.id = e.show_id
        WHERE l.dup_of IS NULL AND l.kind != 'track' AND l.ts >= ?1 AND l.ts < ?2
        GROUP BY l.episode_id ORDER BY ms DESC LIMIT 200`,
    ).bind(r.from, r.to),
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

/** "Android OS 9 API 28 (samsung, SM-G960U)" -> "Android", etc. */
export function platformFamily(raw: string): string {
  const p = raw.toLowerCase();
  if (p.includes("android")) return "Android";
  if (p.startsWith("ios") || p.includes("iphone") || p.includes("ipad")) return "iPhone / iPad";
  if (p.includes("web_player") || p.includes("web player")) return "Web player";
  if (p.includes("windows")) return "Windows";
  if (p.startsWith("os x") || p.includes("macos") || p.includes("mac os")) return "Mac";
  if (p.includes("linux")) return "Linux";
  if (p.includes("cast") || p.includes("chromecast")) return "Chromecast / Cast";
  if (p.includes("sonos")) return "Sonos";
  if (p.includes("playstation") || p.includes("ps4") || p.includes("ps5")) return "PlayStation";
  if (p.includes("xbox")) return "Xbox";
  if (p.includes("tv") || p.includes("tizen") || p.includes("webos") || p.includes("roku")) return "TV";
  if (p.includes("car") || p.includes("auto")) return "Car";
  if (p.includes("watch") || p.includes("wear")) return "Watch";
  if (p.includes("alexa") || p.includes("echo") || p.includes("google_home") || p.includes("speaker")) return "Smart speaker";
  return raw.split(/[ (;]/)[0] || "Other";
}

/** Longest run of consecutive days, and the run ending at `today` (or yesterday). */
export function streaks(days: string[], today: string): HabitsResponse["streaks"] {
  const sorted = [...new Set(days)].sort();
  const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  let longest: { days: number; from: string; to: string } | null = null;
  let runStart = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && dayNum(sorted[i]!) !== dayNum(sorted[i - 1]!) + 1) runStart = i;
    const len = i - runStart + 1;
    if (!longest || len > longest.days) longest = { days: len, from: sorted[runStart]!, to: sorted[i]! };
  }
  let current: { days: number; from: string; to: string } | null = null;
  const lastDay = sorted[sorted.length - 1];
  if (lastDay && dayNum(today) - dayNum(lastDay) <= 1) {
    let i = sorted.length - 1;
    while (i > 0 && dayNum(sorted[i]!) === dayNum(sorted[i - 1]!) + 1) i--;
    current = { days: sorted.length - i, from: sorted[i]!, to: lastDay };
  }
  return { longest, current };
}

/**
 * @param stored  the stored totals are built: first listens per song/artist
 *                come from them (an index range) instead of a pass over the
 *                whole timeline.
 */
export async function habits(env: Env, r: Range, bucket: Bucket, now = Date.now(), stored = false): Promise<HabitsResponse> {
  const local = localMsSql(r.tz, r.from, r.to, "l.ts");
  const range = "l.dup_of IS NULL AND l.ts >= ?1 AND l.ts < ?2";
  const firsts = (table: "roll_songs" | "roll_artists", fallback: string) =>
    stored ? `(SELECT first_ts AS first FROM ${table} WHERE p = 0 AND first_ts >= ?1 AND first_ts < ?2)` : fallback;
  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS streams, SUM(l.platform IS NOT NULL) AS detailed,
              AVG(l.shuffle) AS shuffle, AVG(l.offline) AS offline,
              AVG(CASE WHEN l.ms_played < 30000 OR l.skipped = 1 THEN 1.0 ELSE 0.0 END) AS skip_rate
         FROM listens l WHERE ${range}`,
    ).bind(r.from, r.to),
    env.DB.prepare(`SELECT l.platform AS name, SUM(l.ms_played) AS ms, COUNT(*) AS streams FROM listens l WHERE ${range} AND l.platform IS NOT NULL GROUP BY l.platform`).bind(r.from, r.to),
    env.DB.prepare(`SELECT l.country AS code, SUM(l.ms_played) AS ms, COUNT(*) AS streams FROM listens l WHERE ${range} AND l.country IS NOT NULL GROUP BY l.country ORDER BY ms DESC`).bind(r.from, r.to),
    env.DB.prepare(`SELECT l.reason_start AS reason, COUNT(*) AS streams FROM listens l WHERE ${range} AND l.reason_start IS NOT NULL GROUP BY reason ORDER BY streams DESC`).bind(r.from, r.to),
    env.DB.prepare(`SELECT l.reason_end AS reason, COUNT(*) AS streams FROM listens l WHERE ${range} AND l.reason_end IS NOT NULL GROUP BY reason ORDER BY streams DESC`).bind(r.from, r.to),
    env.DB.prepare(`SELECT DISTINCT date(${local} / 1000, 'unixepoch') AS d FROM listens l WHERE ${range}`).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT CAST(strftime('%Y', ${local} / 1000, 'unixepoch') AS INTEGER) AS year, SUM(l.ms_played) AS ms,
              SUM(l.ms_played >= 30000) AS plays, COUNT(DISTINCT l.song_id) AS tracks
         FROM listens l WHERE ${range} GROUP BY year ORDER BY year`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT CAST(strftime('%Y', ${local} / 1000, 'unixepoch') AS INTEGER) AS year, COUNT(DISTINCT ta.artist_id) AS artists
         FROM listens l JOIN track_artists ta ON ta.track_id = l.song_id WHERE ${range} AND l.kind = 'track' GROUP BY year`,
    ).bind(r.from, r.to),
    // First-ever listen per song / artist (all time), then bucketed within the range.
    env.DB.prepare(
      `SELECT ${bucketSql(bucket, localMsSql(r.tz, r.from, r.to, "first"))} AS t, COUNT(*) AS n
         FROM ${firsts("roll_songs", "(SELECT song_id, MIN(ts) AS first FROM listens WHERE dup_of IS NULL AND kind = 'track' AND song_id IS NOT NULL GROUP BY song_id)")}
        WHERE first >= ?1 AND first < ?2 GROUP BY t`,
    ).bind(r.from, r.to),
    env.DB.prepare(
      `SELECT ${bucketSql(bucket, localMsSql(r.tz, r.from, r.to, "first"))} AS t, COUNT(*) AS n
         FROM ${firsts(
           "roll_artists",
           `(SELECT ta.artist_id, MIN(l.ts) AS first FROM listens l JOIN track_artists ta ON ta.track_id = l.song_id
              WHERE l.dup_of IS NULL AND l.kind = 'track' GROUP BY ta.artist_id)`,
         )}
        WHERE first >= ?1 AND first < ?2 GROUP BY t`,
    ).bind(r.from, r.to),
    // Sessions: a gap of more than 30 minutes between streams starts a new one.
    env.DB.prepare(
      `WITH x AS (
         SELECT l.ts, l.ms_played,
                CASE WHEN LAG(l.ts) OVER (ORDER BY l.ts) IS NULL
                       OR (l.ts - l.ms_played) - LAG(l.ts) OVER (ORDER BY l.ts) > 1800000 THEN 1 ELSE 0 END AS starts
           FROM listens l WHERE ${range}),
       y AS (SELECT ts, ms_played, SUM(starts) OVER (ORDER BY ts) AS sid FROM x),
       s AS (SELECT sid, MIN(ts - ms_played) AS start, MAX(ts) AS end, SUM(ms_played) AS ms FROM y GROUP BY sid)
       SELECT COUNT(*) AS n, AVG(ms) AS avg_ms,
              (SELECT start FROM s ORDER BY ms DESC LIMIT 1) AS l_start,
              (SELECT end FROM s ORDER BY ms DESC LIMIT 1) AS l_end,
              (SELECT ms FROM s ORDER BY ms DESC LIMIT 1) AS l_ms
         FROM s`,
    ).bind(r.from, r.to),
  ]);
  const [head, platforms, countries, rStart, rEnd, days, years, yearArtists, newTracks, newArtists, sessions] = results.map((x) => x?.results ?? []) as [
    Record<string, number | null>[],
    { name: string; ms: number; streams: number }[],
    { code: string; ms: number; streams: number }[],
    { reason: string; streams: number }[],
    { reason: string; streams: number }[],
    { d: string }[],
    { year: number; ms: number; plays: number; tracks: number }[],
    { year: number; artists: number }[],
    { t: string; n: number }[],
    { t: string; n: number }[],
    { n: number; avg_ms: number | null; l_start: number | null; l_end: number | null; l_ms: number | null }[],
  ];
  const h = head[0] ?? {};

  const families = new Map<string, { name: string; ms: number; streams: number }>();
  for (const p of platforms) {
    const name = platformFamily(p.name);
    const f = families.get(name) ?? { name, ms: 0, streams: 0 };
    f.ms += num(p.ms);
    f.streams += num(p.streams);
    families.set(name, f);
  }

  const todayLocal = new Date(now + offsetAt(r.tz, now)).toISOString().slice(0, 10);
  const artistsByYear = new Map(yearArtists.map((y) => [y.year, y.artists]));
  const discoveries = new Map<string, { t: string; newArtists: number; newTracks: number }>();
  for (const x of newTracks) discoveries.set(x.t, { t: x.t, newTracks: x.n, newArtists: 0 });
  for (const x of newArtists) {
    const d = discoveries.get(x.t) ?? { t: x.t, newTracks: 0, newArtists: 0 };
    d.newArtists = x.n;
    discoveries.set(x.t, d);
  }
  const sess = sessions[0];
  const streams = num(h.streams);
  return {
    detailedCoverage: streams ? num(h.detailed) / streams : 0,
    platforms: [...families.values()].sort((a, b) => b.ms - a.ms),
    countries: countries.map((c) => ({ code: c.code, ms: num(c.ms), streams: num(c.streams) })),
    reasonsStart: rStart,
    reasonsEnd: rEnd,
    shuffleShare: typeof h.shuffle === "number" ? h.shuffle : null,
    offlineShare: typeof h.offline === "number" ? h.offline : null,
    skipRate: streams ? num(h.skip_rate) : null,
    streaks: streaks(days.map((d) => d.d), todayLocal),
    byYear: years.map((y) => ({ year: y.year, ms: num(y.ms), plays: num(y.plays), tracks: num(y.tracks), artists: artistsByYear.get(y.year) ?? 0 })),
    discoveries: [...discoveries.values()].sort((a, b) => a.t.localeCompare(b.t)),
    bucket,
    sessions: {
      count: num(sess?.n),
      avgMs: Math.round(num(sess?.avg_ms)),
      longest: sess?.l_start != null && sess.l_end != null ? { start: sess.l_start, end: sess.l_end, ms: num(sess.l_ms) } : null,
    },
  };
}

// ---------------------------------------------------------------------------

export async function now(env: Env, at = Date.now()): Promise<NowResponse> {
  const sample = await env.DB.prepare(
    `SELECT s.sampled_at, s.is_playing, s.progress_ms, s.duration_ms, s.device_name, s.track_id, s.episode_id, s.item_type,
            e.name AS episode_name, sh.name AS show_name, COALESCE(sh.image_url, e.image_url) AS episode_image
       FROM playback_samples s
       LEFT JOIN episodes e ON e.id = s.episode_id
       LEFT JOIN shows sh ON sh.id = e.show_id
      ORDER BY s.sampled_at DESC LIMIT 1`,
  ).first<{
    sampled_at: number;
    is_playing: number;
    progress_ms: number | null;
    duration_ms: number | null;
    device_name: string | null;
    track_id: string | null;
    episode_id: string | null;
    item_type: string | null;
    episode_name: string | null;
    show_name: string | null;
    episode_image: string | null;
  }>();
  const recent = await history(env, {
    before: null,
    limit: 12,
    q: null,
    from: null,
    to: null,
    artist: null,
    track: null,
    album: null,
    kind: null,
    source: null,
    skipped: false,
    includeDuplicates: false,
  });

  // A sample older than a few minutes no longer says anything about "now".
  let playing: NowResponse["playing"] = null;
  if (sample && sample.item_type !== "none" && at - sample.sampled_at < 6 * 60_000) {
    const tracks = await hydrateTracks(env, [sample.track_id]);
    playing = {
      isPlaying: sample.is_playing === 1,
      sampledAt: sample.sampled_at,
      progressMs: sample.progress_ms,
      durationMs: sample.duration_ms,
      device: sample.device_name,
      track: sample.track_id ? (tracks.get(sample.track_id) ?? null) : null,
      episode: sample.episode_id
        ? { id: sample.episode_id, name: sample.episode_name ?? "", show: sample.show_name, imageUrl: sample.episode_image }
        : null,
    };
  }
  return { playing, recent: recent.items };
}

export async function spotifyTop(env: Env): Promise<SpotifyTopResponse> {
  const auth = await env.DB.prepare("SELECT scope FROM auth_tokens WHERE id = 1").first<{ scope: string }>();
  const scopeGranted = Boolean(auth?.scope.split(/\s+/).includes("user-top-read"));
  const latest = await env.DB.prepare("SELECT MAX(taken_at) AS t FROM top_snapshots").first<{ t: number | null }>();
  const empty = () => ({ tracks: [] as TrackLite[], artists: [] as ArtistLiteArr });
  type ArtistLiteArr = SpotifyTopResponse["ranges"]["short_term"]["artists"];
  const ranges: SpotifyTopResponse["ranges"] = { short_term: empty(), medium_term: empty(), long_term: empty() };
  if (!latest?.t) return { scopeGranted, takenAt: null, ranges };

  const { results } = await env.DB.prepare(
    "SELECT time_range, kind, rank, item_id FROM top_snapshots WHERE taken_at = ? ORDER BY time_range, kind, rank",
  )
    .bind(latest.t)
    .all<{ time_range: SpotifyTimeRange; kind: "track" | "artist"; rank: number; item_id: string }>();
  const [tracks, artists] = await Promise.all([
    hydrateTracks(env, results.filter((x) => x.kind === "track").map((x) => x.item_id)),
    hydrateArtists(env, results.filter((x) => x.kind === "artist").map((x) => x.item_id)),
  ]);
  for (const row of results) {
    const range = ranges[row.time_range];
    if (!range) continue;
    if (row.kind === "track") {
      const t = tracks.get(row.item_id);
      if (t) range.tracks.push(t);
    } else {
      const a = artists.get(row.item_id);
      if (a) range.artists.push(a);
    }
  }
  return { scopeGranted, takenAt: latest.t, ranges };
}

// ---------------------------------------------------------------------------

export interface CollectorHealth {
  status: "ok" | "degraded" | "not_connected";
  sampleLastRunMinutesAgo: number | null;
  recentLastRunMinutesAgo: number | null;
  lastError: string | null;
}

/** Listens per month and source: a scan of the whole timeline, so it is stored like an All time answer. */
async function coverageByMonth(env: Env, tz: string): Promise<DataStatusResponse["coverage"]> {
  const span = await env.DB.prepare("SELECT MIN(ts) AS a, MAX(ts) AS b FROM listens").first<{ a: number | null; b: number | null }>();
  const local = localMsSql(tz, span?.a ?? 0, span?.b ?? 0);
  const { results } = await env.DB.prepare(
    `SELECT strftime('%Y-%m', ${local} / 1000, 'unixepoch') AS month, source,
            SUM(dup_of IS NULL) AS n, SUM(dup_of IS NOT NULL) AS dups
       FROM listens GROUP BY month, source ORDER BY month`,
  ).all<{ month: string; source: "extended" | "account" | "live"; n: number; dups: number }>();
  const months = new Map<string, DataStatusResponse["coverage"][number]>();
  for (const row of results) {
    const m = months.get(row.month) ?? { month: row.month, extended: 0, account: 0, live: 0, duplicates: 0 };
    m[row.source] += num(row.n);
    m.duplicates += num(row.dups);
    months.set(row.month, m);
  }
  return [...months.values()];
}

/**
 * The Data page. Imports, enrichment progress and collector health are always
 * live; the month-by-month coverage comes from the stored totals when they are
 * in this time zone (`storedCoverage`), else from a pass over the timeline.
 */
const LANES = ["spotify", "deezer", "features", "musicbrainz"] as const;

/**
 * Import history, coverage and the collectors' and lookups' state: a few
 * dozen rows, since the Data page asks every 15 s. Enrichment progress isn't
 * counted (that reads every track and artist); the page shows instead which
 * lookups are waiting out a rate limit, and until when.
 */
export async function dataStatus(
  env: Env,
  cache: Pick<ReadCache, "get">,
  tz: string,
  storedCoverage: (() => Promise<DataStatusResponse["coverage"]>) | null,
  collector: CollectorHealth,
  auth: DataStatusResponse["auth"],
  now = Date.now(),
): Promise<DataStatusResponse> {
  const [coverage, [imports, state]] = await Promise.all([
    storedCoverage
      ? cache.get(`coverage?stored&tz=${tz}`, storedCoverage, "long")
      : cache.get(`coverage?tz=${tz}`, () => coverageByMonth(env, tz), "long"),
    env.DB.batch([
      env.DB.prepare("SELECT * FROM imports ORDER BY created_at DESC LIMIT 50"),
      env.DB.prepare(`SELECT key, value FROM sync_state WHERE key IN ('pump_last_run_at', ${LANES.map((l) => `'backoff_${l}'`).join(", ")})`),
    ]),
  ]);

  const kv = new Map(((state?.results ?? []) as { key: string; value: string | null }[]).map((r) => [r.key, Number.parseInt(r.value ?? "", 10)]));
  const at = (key: string) => {
    const v = kv.get(key);
    return v !== undefined && Number.isFinite(v) ? v : null;
  };
  const waiting = (lane: (typeof LANES)[number]) => {
    const until = at(`backoff_${lane}`);
    return until !== null && until > now ? until : null;
  };
  return {
    coverage,
    imports: ((imports?.results ?? []) as Record<string, unknown>[]).map(toImportBatch),
    lastPumpAt: at("pump_last_run_at"),
    waitingUntil: { spotify: waiting("spotify"), deezer: waiting("deezer"), features: waiting("features"), musicbrainz: waiting("musicbrainz") },
    collector,
    auth,
  };
}

export function toImportBatch(row: Record<string, unknown>): ImportBatch {
  let files: ImportBatch["files"] = [];
  try {
    files = JSON.parse(String(row.files ?? "[]"));
  } catch {
    files = [];
  }
  return {
    id: String(row.id),
    createdAt: num(row.created_at),
    finishedAt: typeof row.finished_at === "number" ? row.finished_at : null,
    status: (row.status as ImportBatch["status"]) ?? "uploading",
    files,
    rowsReceived: num(row.rows_received),
    rowsInserted: num(row.rows_inserted),
    firstTs: typeof row.first_ts === "number" ? row.first_ts : null,
    lastTs: typeof row.last_ts === "number" ? row.last_ts : null,
    duplicates: typeof row.duplicates === "number" ? row.duplicates : null,
  };
}

export function missingScopes(scope: string | null): string[] {
  const have = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.filter((s) => !have.has(s));
}

// ---------------------------------------------------------------------------

export async function search(env: Env, q: string): Promise<SearchResponse> {
  const like = likePattern(q);
  const [artists, tracks, albums] = await env.DB.batch([
    // Name-only (`name:`) entities are included: until enrichment finds their
    // Spotify ids they are the only record of what an import contained.
    env.DB.prepare(`SELECT id FROM artists WHERE name LIKE ?1 ESCAPE '\\' ORDER BY priority DESC LIMIT 6`).bind(like),
    env.DB.prepare(`SELECT id FROM tracks WHERE name LIKE ?1 ESCAPE '\\' AND canonical_id IS NULL ORDER BY priority DESC LIMIT 8`).bind(like),
    env.DB.prepare(
      `SELECT al.id FROM albums al WHERE al.name LIKE ?1 ESCAPE '\\'
        ORDER BY (SELECT COALESCE(SUM(t.priority), 0) FROM tracks t WHERE t.album_id = al.id) DESC LIMIT 6`,
    ).bind(like),
  ]);
  const ids = (r: D1Result | undefined) => ((r?.results ?? []) as { id: string }[]).map((x) => x.id);
  const [a, t, al] = await Promise.all([hydrateArtists(env, ids(artists)), hydrateTracks(env, ids(tracks)), hydrateAlbums(env, ids(albums))]);
  return {
    artists: ids(artists).map((id) => a.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x)),
    tracks: ids(tracks).map((id) => t.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x)),
    albums: ids(albums).map((id) => al.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x)),
  };
}
