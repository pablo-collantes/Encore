// The cleanup pass: turns rows from three sources into one trustworthy timeline.
//
// Runs after every import (scoped to the import's time range) and hourly from
// the maintenance cron. The hourly run re-checks the whole history only when
// some listens changed which track they are (STATE_DUPS_RECHECK: a name-only
// listen matched to a real track, versions merged); otherwise only the last
// few days, where new live plays land. It matches names (steps 2-3) only after
// the catalogue changed in a way they could act on (STATE_NAMES_RECHECK).
// Every step is idempotent and writes only rows whose answer changed.
//
//   1. name keys     fill normalised names on rows written before they existed
//   2. resolve       Account-data listens (names only) -> real track ids, when a
//                    track with the same name + artist is known
//   3. merge stubs   name-only artists/albums/shows -> the real entity, once
//                    enrichment has found it; drop stubs nothing points at
//   4. versions      tracks sharing an ISRC (single vs album release, relinks)
//                    count as one song: listens.song_id -> the most-played id
//   5. duplicates    the same stream from two sources: keep the best copy
//                    (extended > live > account), point the rest at it (dup_of)
//   6. priorities    total listening per track/artist, so enrichment does the
//                    things you actually listen to first (kept by the stored
//                    totals once they exist: src/worker/stats/rollup.ts)

import type { Env } from "./types";
import type { CleanupResult } from "../shared/api";
import { bumpDataVersion, CLOSED_AFTER_MS } from "./lib/cache";
import { getState, setState } from "./lib/db";
import { STATE_ROLL_READY } from "./stats/rollup";
import { normName, trackNameKey } from "../shared/normalize";

/** Set (to a unique stamp) when listens changed which track they are since the last whole-history duplicate check. */
export const STATE_DUPS_RECHECK = "dups_recheck";
/** When the last whole-history check ran (absent: never, so the next hourly run does one). */
const STATE_DUPS_FULL_AT = "dups_full_at";
/**
 * Set by trigger (migration 0007) on each catalogue change name matching could
 * act on: a new track, artist, album, show, episode or credit, a changed name
 * key, album or show, a removed credit, a name-only listen added or removed,
 * a listen moved to another track. Cleared by the matching.
 */
export const STATE_NAMES_RECHECK = "names_recheck";

const DAY = 86_400_000;

const changes = (results: D1Result[]) => results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);

// `id >= 'name:' AND id < 'name;'` selects the `name:` stubs through the
// primary-key index (LIKE can't use it: SQLite's LIKE is case-insensitive).
const STUB = (col: string) => `(${col} >= 'name:' AND ${col} < 'name;')`;

/** Fill missing name_key columns. SQL can't normalise names, so this runs in JS. */
async function backfillNameKeys(env: Env): Promise<number> {
  const db = env.DB;
  let updated = 0;

  for (let round = 0; round < 20; round++) {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.name,
                (SELECT a.name FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                  WHERE ta.track_id = t.id ORDER BY ta.position LIMIT 1) AS artist
           FROM tracks t WHERE t.name_key IS NULL LIMIT 1000`,
      )
      .all<{ id: string; name: string; artist: string | null }>();
    if (results.length === 0) break;
    const rows = results.map((r) => ({ id: r.id, k: trackNameKey(r.name, r.artist) }));
    await db
      .prepare(
        `UPDATE tracks SET name_key = j.k
           FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.k') AS k FROM json_each(?1)) j
          WHERE tracks.id = j.id`,
      )
      .bind(JSON.stringify(rows))
      .run();
    updated += rows.length;
  }

  for (const table of ["artists", "albums", "shows"] as const) {
    for (let round = 0; round < 20; round++) {
      const { results } = await db
        .prepare(`SELECT id, name FROM ${table} WHERE name_key IS NULL LIMIT 1000`)
        .all<{ id: string; name: string }>();
      if (results.length === 0) break;
      const rows = results.map((r) => ({ id: r.id, k: normName(r.name) }));
      await db
        .prepare(
          `UPDATE ${table} SET name_key = j.k
             FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.k') AS k FROM json_each(?1)) j
            WHERE ${table}.id = j.id`,
        )
        .bind(JSON.stringify(rows))
        .run();
      updated += rows.length;
    }
  }
  return updated;
}

/** Point name-only listens at a real track with the same name + artist. */
function resolveByName(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `UPDATE listens
        SET track_id = r.id,
            song_id  = COALESCE((SELECT canonical_id FROM tracks WHERE id = r.id), r.id)
       FROM (SELECT name_key, MIN(id) AS id FROM tracks
              WHERE name_key IS NOT NULL AND NOT ${STUB("id")}
              GROUP BY name_key) r
      WHERE listens.track_id LIKE 'name:%' AND listens.name_key = r.name_key`,
  );
}

/** Merge name-only stubs into real entities and drop the ones nothing uses. */
function mergeStubs(db: D1Database): D1PreparedStatement[] {
  // A stub artist maps to a real one only when exactly one real artist has that
  // normalised name; ambiguous names wait for the track's own metadata lookup.
  const mapping = `(SELECT s.id AS stub,
                           (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(r.id) END FROM artists r
                             WHERE r.name_key = s.name_key AND NOT ${STUB("r.id")}) AS real
                      FROM artists s WHERE ${STUB("s.id")})`;

  return [
    db.prepare(
      `UPDATE OR IGNORE track_artists SET artist_id = m.real FROM ${mapping} m
        WHERE track_artists.artist_id = m.stub AND m.real IS NOT NULL`,
    ),
    db.prepare(
      `UPDATE OR IGNORE album_artists SET artist_id = m.real FROM ${mapping} m
        WHERE album_artists.artist_id = m.stub AND m.real IS NOT NULL`,
    ),
    // Whatever is left on a merged stub collided with an existing real credit.
    db.prepare(
      `DELETE FROM track_artists WHERE ${STUB("artist_id")}
          AND artist_id IN (SELECT stub FROM ${mapping} WHERE real IS NOT NULL)`,
    ),
    db.prepare(
      `DELETE FROM album_artists WHERE ${STUB("artist_id")}
          AND artist_id IN (SELECT stub FROM ${mapping} WHERE real IS NOT NULL)`,
    ),
    // Stub tracks whose listens all resolved to real tracks.
    db.prepare(
      `DELETE FROM track_artists WHERE ${STUB("track_id")}
          AND NOT EXISTS (SELECT 1 FROM listens l WHERE l.track_id = track_artists.track_id)`,
    ),
    db.prepare(`DELETE FROM tracks WHERE ${STUB("id")} AND NOT EXISTS (SELECT 1 FROM listens l WHERE l.track_id = tracks.id)`),
    // Stub albums no track points at any more (the metadata lookup moved them).
    db.prepare(
      `DELETE FROM album_artists WHERE ${STUB("album_id")}
          AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = album_artists.album_id)`,
    ),
    db.prepare(`DELETE FROM albums WHERE ${STUB("id")} AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = albums.id)`),
    db.prepare(
      `DELETE FROM artists WHERE ${STUB("id")}
          AND NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = artists.id)
          AND NOT EXISTS (SELECT 1 FROM album_artists aa WHERE aa.artist_id = artists.id)`,
    ),
    // Shows: an export only names the show; the player sampler knows the real one.
    db.prepare(
      `UPDATE episodes SET show_id = m.real
         FROM (SELECT s.id AS stub,
                      (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(r.id) END FROM shows r
                        WHERE r.name_key = s.name_key AND NOT ${STUB("r.id")}) AS real
                 FROM shows s WHERE ${STUB("s.id")}) m
        WHERE episodes.show_id = m.stub AND m.real IS NOT NULL`,
    ),
    db.prepare(`DELETE FROM shows WHERE ${STUB("id")} AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id)`),
  ];
}

/**
 * Name-only listens and stubs -> real entities, in one transaction that ends by
 * clearing STATE_NAMES_RECHECK. Its own changes set the flag again inside the
 * transaction, and nothing else can write there, so only a change made after
 * it calls for another run.
 */
async function matchNames(env: Env): Promise<{ resolvedByName: number; mergedArtists: number; changes: number }> {
  const db = env.DB;
  const stubs = mergeStubs(db);
  const results = await db.batch([
    resolveByName(db),
    ...stubs,
    db.prepare("DELETE FROM sync_state WHERE key = ?1").bind(STATE_NAMES_RECHECK),
  ]);
  const merged = results.slice(1, 1 + stubs.length);
  return { resolvedByName: results[0]?.meta.changes ?? 0, mergedArtists: merged[0]?.meta.changes ?? 0, changes: changes(merged) };
}

/**
 * Same recording, several Spotify ids (same ISRC): count them as one song.
 * Re-pointing listens scans the whole timeline, so it runs only when a
 * canonical id moved or on a whole-history run (the search lane files listens
 * under the found id, which may itself be a non-canonical version).
 */
async function mergeVersions(env: Env, full: boolean): Promise<number> {
  const db = env.DB;
  const canonical = db.prepare(
    `WITH dup AS (SELECT isrc FROM tracks WHERE isrc IS NOT NULL GROUP BY isrc HAVING COUNT(*) > 1),
          ranked AS (
            SELECT t.isrc, t.id,
                   ROW_NUMBER() OVER (PARTITION BY t.isrc
                     ORDER BY (SELECT COUNT(*) FROM listens l WHERE l.track_id = t.id) DESC, t.id) AS rn
              FROM tracks t JOIN dup ON dup.isrc = t.isrc),
          best AS (SELECT isrc, id FROM ranked WHERE rn = 1)
     UPDATE tracks SET canonical_id = CASE WHEN tracks.id = best.id THEN NULL ELSE best.id END
       FROM best
      WHERE tracks.isrc = best.isrc
        AND tracks.canonical_id IS NOT (CASE WHEN tracks.id = best.id THEN NULL ELSE best.id END)`,
  );
  const relink = db.prepare(
    `UPDATE listens SET song_id = COALESCE(t.canonical_id, t.id)
       FROM tracks t
      WHERE listens.track_id = t.id AND listens.song_id IS NOT COALESCE(t.canonical_id, t.id)`,
  );
  if (full) return changes(await db.batch([canonical, relink]));
  const moved = (await canonical.run()).meta.changes ?? 0;
  return moved > 0 ? moved + ((await relink.run()).meta.changes ?? 0) : 0;
}

/**
 * Mark cross-source duplicates inside [from, to]. Windows are generous on
 * purpose: Account data truncates the end time to the minute, and live plays
 * carry Spotify's played_at, which lands within seconds of the export's `ts`.
 *
 * Each row's answer is worked out afresh, but only rows whose answer changed
 * are written: the hourly pass covers the whole history, and D1 bills every
 * rewritten row (plus its index entries), so clearing and re-marking every
 * duplicate each hour cost ~50k writes an hour once an export overlapped.
 */
async function markDuplicates(env: Env, from: number, to: number): Promise<{ duplicates: number; changes: number }> {
  const db = env.DB;
  const match = (a: string, e: string) =>
    `(${e}.song_id = ${a}.song_id OR ${e}.track_id = ${a}.track_id OR ${e}.name_key = ${a}.name_key)`;

  // Live first: an account row may only point at a live play that is itself counted.
  const marked = await db.batch([
    // Live plays vs extended history.
    db
      .prepare(
        `UPDATE listens SET dup_of = m.eid FROM (
           SELECT a.id AS aid,
                  (SELECT e.id FROM listens e
                    WHERE e.source = 'extended' AND e.kind = a.kind
                      AND e.ts BETWEEN a.ts - 90000 AND a.ts + 90000
                      AND ${match("a", "e")}
                    ORDER BY abs(e.ts - a.ts) LIMIT 1) AS eid
             FROM listens a WHERE a.source = 'live' AND a.ts BETWEEN ?1 AND ?2) m
         WHERE listens.id = m.aid AND listens.dup_of IS NOT m.eid`,
      )
      .bind(from, to),
    // Account data vs extended history (same minute, same stream), else vs a
    // counted live play where no extended history covers the period.
    // COALESCE stops at the first match, so the live lookup only runs when needed.
    db
      .prepare(
        `UPDATE listens SET dup_of = m.eid FROM (
           SELECT a.id AS aid,
                  COALESCE(
                    (SELECT e.id FROM listens e
                      WHERE e.source = 'extended' AND e.kind = a.kind
                        AND e.ts >= a.ts - 60000 AND e.ts < a.ts + 120000
                        AND (e.ms_played = a.ms_played OR ${match("a", "e")})
                      ORDER BY abs(e.ts - a.ts - 30000) LIMIT 1),
                    (SELECT e.id FROM listens e
                      WHERE e.source = 'live' AND e.dup_of IS NULL
                        AND e.ts >= a.ts - 60000 AND e.ts < a.ts + 120000
                        AND ${match("a", "e")}
                      ORDER BY abs(e.ts - a.ts - 30000) LIMIT 1)) AS eid
             FROM listens a WHERE a.source = 'account' AND a.ts BETWEEN ?1 AND ?2) m
         WHERE listens.id = m.aid AND listens.dup_of IS NOT m.eid`,
      )
      .bind(from, to),
  ]);

  // Only live and account rows are ever marked (above), and (source, ts) is
  // indexed: without the source terms, counting a few days read every listen.
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM listens WHERE dup_of IS NOT NULL AND source IN ('live', 'account') AND ts BETWEEN ?1 AND ?2")
    .bind(from, to)
    .first<{ n: number }>();
  return { duplicates: row?.n ?? 0, changes: changes(marked) };
}

/** Total listening per track and artist: the enrichment pump works in this order. */
async function refreshPriorities(env: Env): Promise<number> {
  const db = env.DB;
  const results = await db.batch([
    db.prepare(
      `UPDATE tracks SET priority = agg.ms
         FROM (SELECT track_id, SUM(ms_played) AS ms FROM listens
                WHERE dup_of IS NULL AND track_id IS NOT NULL GROUP BY track_id) agg
        WHERE tracks.id = agg.track_id AND tracks.priority != agg.ms`,
    ),
    db.prepare(
      `UPDATE artists SET priority = agg.ms
         FROM (SELECT ta.artist_id, SUM(t.priority) AS ms FROM track_artists ta
                 JOIN tracks t ON t.id = ta.track_id GROUP BY ta.artist_id) agg
        WHERE artists.id = agg.artist_id AND artists.priority != agg.ms`,
    ),
  ]);
  return changes(results);
}

/**
 * @param opts.from/to  an import's time range: duplicates are checked there.
 * @param opts.full     check the whole history even if nothing seems to have changed.
 * Without either, the run is the hourly one (see the top of this file).
 */
export async function runCleanup(
  env: Env,
  opts: { from?: number; to?: number; full?: boolean } = {},
  now = Date.now(),
): Promise<CleanupResult> {
  const started = Date.now();
  const scoped = opts.from !== undefined || opts.to !== undefined;
  const [recheck, lastFull, rollReady] = await Promise.all([
    getState(env, STATE_DUPS_RECHECK),
    getState(env, STATE_DUPS_FULL_AT),
    getState(env, STATE_ROLL_READY),
  ]);
  const full = scoped || opts.full === true || recheck !== null || lastFull === null;

  await backfillNameKeys(env);
  // Read after the backfill: a name key it filled in sets the flag too.
  const names = full || (await getState(env, STATE_NAMES_RECHECK)) !== null
    ? await matchNames(env)
    : { resolvedByName: 0, mergedArtists: 0, changes: 0 };
  const resolvedByName = names.resolvedByName;
  const versions = await mergeVersions(env, full);
  // Listens that now name another track may now match a copy from another source anywhere in time.
  const wholeHistory = (full && !scoped) || resolvedByName + versions > 0;
  const from = opts.from ?? (wholeHistory ? 0 : now - CLOSED_AFTER_MS - DAY);
  const to = opts.to ?? now + DAY;
  const dups = await markDuplicates(env, from, to);
  // Once the stored totals exist, each fold keeps priorities for what it touched.
  const priorities = rollReady === "1" ? 0 : await refreshPriorities(env);

  // Stored dashboard answers are recomputed only if something they show changed.
  if (resolvedByName + names.changes + versions + dups.changes > 0) await bumpDataVersion(env, "history", now);
  else if (priorities > 0) await bumpDataVersion(env, "live", now); // all-time ranks
  if (wholeHistory && !scoped) {
    await setState(env, STATE_DUPS_FULL_AT, String(now), now);
    // Only the stamp this run saw: one set meanwhile still gets its whole-history check.
    if (recheck !== null) await env.DB.prepare("DELETE FROM sync_state WHERE key = ?1 AND value = ?2").bind(STATE_DUPS_RECHECK, recheck).run();
  }
  return { resolvedByName, duplicates: dups.duplicates, mergedArtists: names.mergedArtists, ms: Date.now() - started };
}
