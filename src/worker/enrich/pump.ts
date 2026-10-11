// The enrichment pump: one small step per minute (piggy-backing on the sampler
// cron), most-listened first, until everything in the archive has artwork,
// credits, genres and audio features.
//
// Four independent lanes run concurrently, one per rate-limited service:
//   spotify      GET /tracks/{id} for imported tracks (credits, album, ISRC, art),
//                GET /artists/{id} for artist images, and /search to give
//                name-only (Account data) tracks a real id
//   deezer       ISRC -> Deezer track -> album genres ("broad" genres)
//   features     ReccoBeats audio features by Spotify id; for tracks it doesn't
//                know, analyse the Deezer 30 s preview instead
//   musicbrainz  artist -> MusicBrainz community genres ("detailed" genres)
//
// A lane that gets rate-limited backs off (sync_state backoff_<lane>) for as
// long as the service asks, longer each time it's refused again, without
// holding up the others. Items that fail for any other reason are marked
// 'error' so one bad id can't block its queue. A minute with nothing queued,
// or queued only for lanes that are backing off, costs a few reads and no
// writes.

import type { Env, SpotifyTrack } from "../types";
import { ReauthRequiredError } from "../auth";
import { bumpDataVersion, CLOSED_AFTER_MS, flushPendingBumps, PUMP_BUMP_EVERY_MS } from "../lib/cache";
import { getState, setState, touchState } from "../lib/db";
import { artistEnrichmentStatement, trackStatements } from "../ingest";
import { STATE_DUPS_RECHECK } from "../cleanup";
import { SpotifyClient, SpotifyError } from "../spotify";
import { normName } from "../../shared/normalize";
import {
  deezerAlbumGenres,
  deezerTrack,
  deezerTrackByIsrc,
  fetchPreview,
  musicbrainzArtistGenres,
  musicbrainzFindArtist,
  RateLimited,
  reccobeatsAnalyse,
  reccobeatsFeatures,
  type Features,
} from "./external";

export const STATE_PUMP_LAST_RUN = "pump_last_run_at";
const LEASE_KEY = "pump_lease_until";
/** While idle, "last run" is refreshed this often (the Data page shows it). */
const IDLE_HEARTBEAT_EVERY_MS = 10 * 60_000;
const STUB = (col: string) => `(${col} >= 'name:' AND ${col} < 'name;')`;
const REAL = `NOT ${STUB("id")} AND id NOT LIKE 'local:%'`;

/**
 * What each lane takes next (most-listened first). Each has a partial index
 * with exactly this WHERE (migrations 0003, 0006), so taking the next items, or
 * asking whether there are any, reads only rows that qualify. An index that
 * also holds rows the lane skips is walked to the end every empty minute: the
 * Deezer lane read 18,616 tracks a minute that way (2026-10-07), all of them
 * still waiting for Spotify, to return none.
 */
export const QUEUES = {
  meta: { table: "tracks", index: "idx_tracks_meta_queue", where: "meta_status IS NULL" },
  deezer: { table: "tracks", index: "idx_tracks_deezer_queue", where: "deezer_status IS NULL AND meta_status = 'ok'" },
  features: { table: "tracks", index: "idx_tracks_features_queue", where: "features_status IS NULL" },
  analysis: {
    table: "tracks",
    index: "idx_tracks_analysis_queue",
    where: "features_status = 'pending_analysis' AND deezer_status IN ('ok', 'missing')",
  },
  artistImages: { table: "artists", index: "idx_artists_enrich_queue", where: `enriched_at IS NULL AND ${REAL}` },
  musicbrainz: { table: "artists", index: "idx_artists_mb_queue", where: `mb_status IS NULL AND ${REAL}` },
};

/**
 * Per-tick limits: gentle enough to stay well inside every service's quota.
 * Searches share Spotify with the collectors, so they stay modest (a 429 in
 * development mode can last hours): 12/min clears a one-year Account export's
 * ~4,400 name-only tracks in about six hours, most-played first. MusicBrainz
 * asks for 1 request/s; each artist is two requests plus the pauses.
 */
const LIMITS = {
  spotifyTracks: 24,
  spotifyArtists: 10,
  spotifySearches: 12,
  deezer: 16,
  featureBatch: 40,
  analyses: 4,
  musicbrainz: 5,
};

type Lane = "spotify" | "deezer" | "features" | "musicbrainz";

interface LaneResult {
  done: number;
  note?: string;
  /** Tracks and artists whose stored data changed, for the cache (see touchesHistory). */
  tracks?: string[];
  artists?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors that mean "stop this lane", as opposed to "this one item failed". */
function isLaneError(err: unknown): boolean {
  return err instanceof RateLimited || err instanceof ReauthRequiredError || (err instanceof SpotifyError && err.status === 429);
}

/**
 * Run `fn` over items with bounded concurrency, stopping at the deadline. An
 * item that fails for an item-specific reason goes to `onItemError` (which
 * marks it 'error' so it can't block the queue; maintenance retries those
 * daily); lane-level errors (rate limits, lost auth) abort the lane.
 */
async function pool<T>(
  items: T[],
  concurrency: number,
  deadline: number,
  fn: (item: T) => Promise<void>,
  onItemError: (item: T, err: unknown) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && Date.now() < deadline) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        if (isLaneError(err)) throw err;
        console.error("enrich item failed", err instanceof Error ? err.message : err);
        await onItemError(item, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const markError = (env: Env, table: "tracks" | "artists", column: string) => async (item: { id: string }) => {
  await env.DB.prepare(`UPDATE ${table} SET ${column} = 'error' WHERE id = ?`).bind(item.id).run();
};

async function backedOff(env: Env, lane: Lane, now: number): Promise<boolean> {
  const until = Number.parseInt((await getState(env, `backoff_${lane}`)) ?? "0", 10);
  return Number.isFinite(until) && until > now;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * When a rate-limited lane may try again. The service's Retry-After is honoured
 * in full (it used to be capped at an hour, and the Spotify lane then hit the
 * same 429 every hour from 2026-10-06 13:20), and a lane limited again within
 * minutes of its wait ending waits twice as long as last time, up to a day.
 */
export function backoffUntil(prev: { until: number; since: number } | null, retryAfterSec: number, now: number): number {
  const again = prev !== null && now - prev.until < 15 * 60_000 ? 2 * (prev.until - prev.since) : 0;
  return now + Math.max(Math.min(retryAfterSec * 1000, 7 * DAY_MS), Math.min(again, DAY_MS), 30_000);
}

async function backOff(env: Env, lane: Lane, seconds: number, now = Date.now()): Promise<void> {
  const prev = await env.DB.prepare("SELECT CAST(value AS INTEGER) AS until, updated_at AS since FROM sync_state WHERE key = ?")
    .bind(`backoff_${lane}`)
    .first<{ until: number; since: number }>();
  await setState(env, `backoff_${lane}`, String(backoffUntil(prev, seconds, now)), now);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/** Pick the search result that is unambiguously the named track. */
export function pickSearchMatch(results: SpotifyTrack[], track: string, artist: string | null): SpotifyTrack | null {
  const wantTrack = normName(track);
  const wantArtist = normName(artist);
  for (const r of results) {
    if (!r.id || normName(r.name) !== wantTrack) continue;
    if (!wantArtist || (r.artists ?? []).some((a) => normName(a.name) === wantArtist)) return r;
  }
  return null;
}

async function spotifyLane(env: Env, now: number, deadline: number): Promise<LaneResult> {
  const db = env.DB;
  const client = new SpotifyClient(env, "enrich", false);
  let done = 0;
  const touched: string[] = [];
  const artistsTouched: string[] = [];

  try {
    // 1. Full metadata for imported tracks.
    const { results: tracks } = await db
      .prepare(`SELECT id FROM tracks WHERE ${QUEUES.meta.where} ORDER BY priority DESC LIMIT ?`)
      .bind(LIMITS.spotifyTracks)
      .all<{ id: string }>();
    const writes: D1PreparedStatement[] = [];
    await pool(tracks, 3, deadline, async ({ id }) => {
      const track = await client.track(id);
      if (track?.id === id) {
        writes.push(...trackStatements(env, track, now));
        touched.push(id);
      } else writes.push(db.prepare("UPDATE tracks SET meta_status = 'missing', enriched_at = ? WHERE id = ?").bind(now, id));
      done++;
    }, markError(env, "tracks", "meta_status"));
    if (writes.length) await db.batch(writes);

    // 2. Artist images.
    if (Date.now() < deadline) {
      const { results: artists } = await db
        .prepare(`SELECT id FROM artists WHERE ${QUEUES.artistImages.where} ORDER BY priority DESC LIMIT ?`)
        .bind(LIMITS.spotifyArtists)
        .all<{ id: string }>();
      const artistWrites: D1PreparedStatement[] = [];
      await pool(artists, 3, deadline, async ({ id }) => {
        const artist = await client.artist(id);
        artistWrites.push(
          artist?.id === id
            ? artistEnrichmentStatement(env, artist, now)
            : db.prepare("UPDATE artists SET enriched_at = ? WHERE id = ?").bind(now, id),
        );
        if (artist?.id === id) artistsTouched.push(id);
        done++;
      }, async ({ id }) => {
        await db.prepare("UPDATE artists SET enriched_at = ? WHERE id = ?").bind(now, id).run();
      });
      if (artistWrites.length) await db.batch(artistWrites);
    }

    // 3. Name-only tracks: find them in the catalogue.
    if (Date.now() < deadline) {
      const { results: stubs } = await db
        .prepare(
          `SELECT t.id, t.name,
                  (SELECT a.name FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                    WHERE ta.track_id = t.id ORDER BY ta.position LIMIT 1) AS artist
             FROM tracks t WHERE ${STUB("t.id")} AND t.search_status IS NULL
            ORDER BY t.priority DESC LIMIT ?`,
        )
        .bind(LIMITS.spotifySearches)
        .all<{ id: string; name: string; artist: string | null }>();
      for (const stub of stubs) {
        if (Date.now() >= deadline) break;
        try {
          const artist = stub.artist && stub.artist !== "Unknown artist" ? stub.artist : null;
          const match =
            stub.name === "Unknown track" ? null : pickSearchMatch(await client.searchTracks(stub.name, artist), stub.name, artist);
          if (match?.id) {
            await db.batch([
              ...trackStatements(env, match, now),
              db.prepare("UPDATE listens SET track_id = ?1, song_id = ?1 WHERE track_id = ?2").bind(match.id, stub.id),
              db.prepare("UPDATE tracks SET search_status = 'found' WHERE id = ?").bind(stub.id),
              // These listens now name a real track: the next cleanup re-checks duplicates across the timeline.
              db.prepare(
                `INSERT INTO sync_state (key, value, updated_at) VALUES ('${STATE_DUPS_RECHECK}', ?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
              ).bind(`${now}.${crypto.randomUUID().slice(0, 8)}`, now),
            ]);
            touched.push(match.id);
          } else {
            await db.prepare("UPDATE tracks SET search_status = 'missing' WHERE id = ?").bind(stub.id).run();
          }
          done++;
        } catch (err) {
          if (isLaneError(err)) throw err;
          await markError(env, "tracks", "search_status")(stub);
        }
      }
    }
  } catch (err) {
    if (err instanceof SpotifyError && err.status === 429) {
      await backOff(env, "spotify", err.retryAfterSec ?? 60);
      return { done, note: `rate limited (${err.retryAfterSec ?? "?"}s)`, tracks: touched, artists: artistsTouched };
    }
    if (err instanceof ReauthRequiredError) return { done, note: "needs re-authorisation", tracks: touched, artists: artistsTouched };
    throw err;
  }
  return { done, tracks: touched, artists: artistsTouched };
}

async function deezerLane(env: Env, now: number, deadline: number): Promise<LaneResult> {
  const db = env.DB;
  let done = 0;
  const touched: string[] = [];
  const { results } = await db
    .prepare(`SELECT id, isrc FROM tracks WHERE ${QUEUES.deezer.where} ORDER BY priority DESC LIMIT ?`)
    .bind(LIMITS.deezer)
    .all<{ id: string; isrc: string | null }>();

  try {
    await pool(results, 2, deadline, async ({ id, isrc }) => {
      if (!isrc) {
        await db.prepare("UPDATE tracks SET deezer_status = 'missing' WHERE id = ?").bind(id).run();
        done++;
        return;
      }
      const dz = await deezerTrackByIsrc(isrc);
      if (!dz?.id) {
        await db.prepare("UPDATE tracks SET deezer_status = 'missing' WHERE id = ?").bind(id).run();
        done++;
        return;
      }
      const albumId = dz.album?.id ?? null;
      const writes: D1PreparedStatement[] = [
        db.prepare("UPDATE tracks SET deezer_status = 'ok', deezer_id = ?, deezer_album_id = ? WHERE id = ?").bind(dz.id, albumId, id),
      ];
      if (albumId) {
        const known = await db.prepare("SELECT 1 AS x FROM deezer_albums WHERE id = ?").bind(albumId).first();
        if (!known) {
          const genres = await deezerAlbumGenres(albumId);
          writes.push(
            db.prepare("INSERT OR REPLACE INTO deezer_albums (id, genres, fetched_at) VALUES (?, ?, ?)").bind(albumId, JSON.stringify(genres ?? []), now),
          );
        }
        writes.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO track_genres (track_id, genre)
               SELECT ?1, value FROM json_each((SELECT genres FROM deezer_albums WHERE id = ?2))`,
            )
            .bind(id, albumId),
        );
      }
      await db.batch(writes);
      if (albumId) touched.push(id);
      done++;
    }, markError(env, "tracks", "deezer_status"));
  } catch (err) {
    if (err instanceof RateLimited) {
      await backOff(env, "deezer", err.retryAfterSec);
      return { done, note: err.message, tracks: touched };
    }
    throw err;
  }
  return { done, tracks: touched };
}

function featuresStatement(env: Env, id: string, f: Features, source: string, now: number): D1PreparedStatement {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return env.DB.prepare(
    // An upsert, not INSERT OR REPLACE: REPLACE deletes without firing delete
    // triggers, and the stored totals need the previous values (0005_rollups.sql).
    `INSERT INTO audio_features
       (track_id, source, acousticness, danceability, energy, instrumentalness, liveness, loudness,
        speechiness, tempo, valence, musical_key, mode, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (track_id) DO UPDATE SET
       source = excluded.source, acousticness = excluded.acousticness, danceability = excluded.danceability,
       energy = excluded.energy, instrumentalness = excluded.instrumentalness, liveness = excluded.liveness,
       loudness = excluded.loudness, speechiness = excluded.speechiness, tempo = excluded.tempo,
       valence = excluded.valence, musical_key = excluded.musical_key, mode = excluded.mode, fetched_at = excluded.fetched_at`,
  ).bind(
    id,
    source,
    n(f.acousticness),
    n(f.danceability),
    n(f.energy),
    n(f.instrumentalness),
    n(f.liveness),
    n(f.loudness),
    n(f.speechiness),
    n(f.tempo),
    n(f.valence),
    n(f.key),
    n(f.mode),
    now,
  );
}

async function featuresLane(env: Env, now: number, deadline: number): Promise<LaneResult> {
  const db = env.DB;
  let done = 0;
  const touched: string[] = [];
  try {
    // 1. Known to ReccoBeats by Spotify id: one request per 40 tracks.
    const { results: batch } = await db
      .prepare(`SELECT id FROM tracks WHERE ${QUEUES.features.where} ORDER BY priority DESC LIMIT ?`)
      .bind(LIMITS.featureBatch)
      .all<{ id: string }>();
    if (batch.length) {
      const found = await reccobeatsFeatures(batch.map((r) => r.id));
      const writes: D1PreparedStatement[] = [];
      for (const { id } of batch) {
        const f = found.get(id);
        if (f) {
          writes.push(featuresStatement(env, id, f, "reccobeats", now));
          writes.push(db.prepare("UPDATE tracks SET features_status = 'reccobeats' WHERE id = ?").bind(id));
          touched.push(id);
        } else {
          writes.push(db.prepare("UPDATE tracks SET features_status = 'pending_analysis' WHERE id = ?").bind(id));
        }
      }
      await db.batch(writes);
      done += batch.length;
    }

    // 2. Everything else: analyse the 30 s preview (needs the Deezer match first).
    const { results: pending } = await db
      .prepare(
        `SELECT id, deezer_id FROM tracks WHERE ${QUEUES.analysis.where} ORDER BY priority DESC LIMIT ?`,
      )
      .bind(LIMITS.analyses)
      .all<{ id: string; deezer_id: number | null }>();
    await pool(pending, 2, deadline, async ({ id, deezer_id }) => {
      let features: Features | null = null;
      if (deezer_id) {
        const dz = await deezerTrack(deezer_id);
        const audio = dz?.preview ? await fetchPreview(dz.preview) : null;
        if (audio) features = await reccobeatsAnalyse(audio);
      }
      await db.batch(
        features
          ? [featuresStatement(env, id, features, "analysis", now), db.prepare("UPDATE tracks SET features_status = 'analysis' WHERE id = ?").bind(id)]
          : [db.prepare("UPDATE tracks SET features_status = 'missing' WHERE id = ?").bind(id)],
      );
      if (features) touched.push(id);
      done++;
    }, markError(env, "tracks", "features_status"));
  } catch (err) {
    if (err instanceof RateLimited) {
      await backOff(env, "features", err.retryAfterSec);
      return { done, note: err.message, tracks: touched };
    }
    throw err;
  }
  return { done, tracks: touched };
}

async function musicbrainzLane(env: Env, _now: number, deadline: number): Promise<LaneResult> {
  const db = env.DB;
  let done = 0;
  const touched: string[] = [];
  const { results } = await db
    .prepare(`SELECT id, name FROM artists WHERE ${QUEUES.musicbrainz.where} ORDER BY priority DESC LIMIT ?`)
    .bind(LIMITS.musicbrainz)
    .all<{ id: string; name: string }>();

  try {
    for (const artist of results) {
      if (Date.now() + 3000 >= deadline) break;
      try {
        const want = normName(artist.name);
        const candidates = await musicbrainzFindArtist(artist.name);
        const match = candidates.find((c) => c.score >= 90 && normName(c.name) === want);
        await sleep(1100); // MusicBrainz: at most one request per second
        const genres = match ? await musicbrainzArtistGenres(match.id) : null;
        if (match) await sleep(1100);

        const writes: D1PreparedStatement[] = [
          db
            .prepare("UPDATE artists SET mb_status = ?, mb_id = ? WHERE id = ?")
            .bind(match && genres ? "ok" : "missing", match?.id ?? null, artist.id),
        ];
        for (const g of (genres ?? []).filter((g) => g.count > 0).slice(0, 12)) {
          writes.push(
            db
              .prepare(
                `INSERT INTO artist_tags (artist_id, tag, votes) VALUES (?, ?, ?)
                 ON CONFLICT (artist_id, tag) DO UPDATE SET votes = excluded.votes WHERE votes != excluded.votes`,
              )
              .bind(artist.id, g.name, g.count),
          );
        }
        await db.batch(writes);
        if (writes.length > 1) touched.push(artist.id);
        done++;
      } catch (err) {
        if (isLaneError(err)) throw err;
        await markError(env, "artists", "mb_status")(artist);
      }
    }
  } catch (err) {
    if (err instanceof RateLimited) {
      await backOff(env, "musicbrainz", err.retryAfterSec);
      return { done, note: err.message, artists: touched };
    }
    throw err;
  }
  return { done, artists: touched };
}

// ---------------------------------------------------------------------------

/**
 * Is anything queued for a lane that isn't waiting out a rate limit? Mirrors
 * the lanes' own queries, so a minute with nothing it can do stops here: no
 * lease, no "last run" write, no lane queries. Work queued only for a lane
 * that's backing off (Spotify's metadata, for hours at a time) is left alone
 * until the wait ends.
 */
export async function pumpHasWork(env: Env, now = Date.now()): Promise<boolean> {
  const open = (lane: Lane) => `COALESCE((SELECT CAST(value AS INTEGER) FROM sync_state WHERE key = 'backoff_${lane}'), 0) <= ?1`;
  const row = await env.DB.prepare(
    `SELECT (${open("spotify")} AND (EXISTS (SELECT 1 FROM tracks WHERE ${QUEUES.meta.where})
                                   OR EXISTS (SELECT 1 FROM artists WHERE ${QUEUES.artistImages.where})
                                   OR EXISTS (SELECT 1 FROM tracks WHERE ${STUB("id")} AND search_status IS NULL)))
         OR (${open("deezer")} AND EXISTS (SELECT 1 FROM tracks WHERE ${QUEUES.deezer.where}))
         OR (${open("features")} AND (EXISTS (SELECT 1 FROM tracks WHERE ${QUEUES.features.where})
                                     OR EXISTS (SELECT 1 FROM tracks WHERE ${QUEUES.analysis.where})))
         OR (${open("musicbrainz")} AND EXISTS (SELECT 1 FROM artists WHERE ${QUEUES.musicbrainz.where})) AS work`,
  )
    .bind(now)
    .first<{ work: number }>();
  return Boolean(row?.work);
}

/**
 * Do these tracks/artists have listens in periods the cache treats as closed?
 * Then what was just found for them (artwork, credits, genres, features) changes
 * stored answers about the past; otherwise only recent ones.
 */
export async function touchesHistory(env: Env, tracks: string[], artists: string[], now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM listens l WHERE l.song_id IN (SELECT value FROM json_each(?1)) AND l.ts < ?3)
         OR EXISTS (SELECT 1 FROM track_artists ta JOIN listens l ON l.song_id = ta.track_id
                     WHERE ta.artist_id IN (SELECT value FROM json_each(?2)) AND l.ts < ?3) AS old`,
  )
    .bind(JSON.stringify(tracks), JSON.stringify(artists), now - CLOSED_AFTER_MS)
    .first<{ old: number }>();
  return Boolean(row?.old);
}

/**
 * Take the pump lease atomically: crons are at-least-once and a slow tick can
 * overlap the next, and two pumps would fetch the same items twice.
 */
async function takeLease(env: Env, now: number, ms: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE sync_state.value IS NULL OR CAST(sync_state.value AS INTEGER) < ?3
     RETURNING value`,
  )
    .bind(LEASE_KEY, String(now + ms), now)
    .first<{ value: string }>();
  return row !== null;
}

export interface PumpResult {
  job: string;
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

/** A minute with nothing a lane can take: a "last run" heartbeat now and then, and any cache bump that's due. */
export async function pumpIdle(env: Env, now = Date.now()): Promise<PumpResult> {
  await touchState(env, STATE_PUMP_LAST_RUN, now, IDLE_HEARTBEAT_EVERY_MS);
  await flushPendingBumps(env, now);
  return { job: "pump", ok: true, detail: { idle: true } };
}

export async function runPump(env: Env, now = Date.now(), budgetMs = 40_000): Promise<PumpResult> {
  if (!(await pumpHasWork(env, now))) return pumpIdle(env, now);
  if (!(await takeLease(env, now, budgetMs + 15_000))) {
    return { job: "pump", ok: true, detail: { skipped: "another run holds the lease" } };
  }
  const deadline = now + budgetMs;
  const lanes: [Lane, (env: Env, now: number, deadline: number) => Promise<LaneResult>][] = [
    ["spotify", spotifyLane],
    ["deezer", deezerLane],
    ["features", featuresLane],
    ["musicbrainz", musicbrainzLane],
  ];

  const detail: Record<string, unknown> = {};
  try {
    const settled = await Promise.allSettled(
      lanes.map(async ([name, lane]) => {
        if (await backedOff(env, name, now)) return [name, { done: 0, note: "backing off" }] as const;
        return [name, await lane(env, now, deadline)] as const;
      }),
    );
    settled.forEach((s, i) => {
      const name = lanes[i]![0];
      detail[name] = s.status === "fulfilled" ? s.value[1] : { done: 0, error: String(s.reason instanceof Error ? s.reason.message : s.reason).slice(0, 300) };
    });
    await setState(env, STATE_PUMP_LAST_RUN, String(now), now);
    // New artwork, credits and genres reach stored answers within PUMP_BUMP_EVERY_MS.
    const results = Object.values(detail) as LaneResult[];
    const tracks = [...new Set(results.flatMap((r) => r.tracks ?? []))];
    const artists = [...new Set(results.flatMap((r) => r.artists ?? []))];
    if (tracks.length || artists.length) {
      const scope = (await touchesHistory(env, tracks, artists, now)) ? "history" : "live";
      await bumpDataVersion(env, scope, now, PUMP_BUMP_EVERY_MS);
    }
    await flushPendingBumps(env, now);
    // Keep the job result readable: counts, not id lists.
    for (const r of results) {
      delete r.tracks;
      delete r.artists;
    }
  } finally {
    await setState(env, LEASE_KEY, "0").catch(() => {});
  }
  const errors = Object.values(detail).filter((d) => (d as { error?: string }).error);
  return { job: "pump", ok: errors.length === 0, detail, ...(errors.length ? { error: `${errors.length} lane(s) failed` } : {}) };
}
