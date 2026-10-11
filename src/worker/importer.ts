// Loads uploaded export rows into the timeline.
//
// The browser parses Spotify's zip and posts ImportRows in chunks
// (src/shared/exportFormats.ts). Each chunk becomes ONE D1 batch (one
// transaction): entity stubs first (artists, albums, tracks, shows, episodes —
// foreign keys are enforced), then the listens. Every insert is
// `INSERT OR IGNORE` on a natural key, so re-uploading an export, or two
// exports that overlap, never double-counts.
//
// Rows travel to SQLite as one JSON parameter expanded with json_each(), which
// sidesteps D1's 100-bound-parameter limit and keeps a 5,000-row chunk to a
// handful of statements.

import type { Env } from "./types";
import { validateImportRow, type ImportRow } from "../shared/exportFormats";
import {
  albumStubId,
  artistStubId,
  episodeStubId,
  idFromUri,
  normName,
  showStubId,
  trackNameKey,
  trackStubId,
} from "../shared/normalize";

/** Rows accepted per POST /api/imports/:id/rows. */
export const MAX_ROWS_PER_REQUEST = 5000;

/** Rows per json_each() statement: keeps each JSON parameter well under D1's 2 MB value cap. */
const ROWS_PER_STATEMENT = 1000;

interface ListenInsert {
  ts: number;
  s: string;
  k: string;
  ik: string;
  t: string | null;
  e: string | null;
  nk: string;
  ms: number;
  sk: number | null;
  rs: string | null;
  re: string | null;
  sh: number | null;
  of: number | null;
  ic: number | null;
  pl: string | null;
  co: string | null;
}

export interface PreparedChunk {
  listens: ListenInsert[];
  artists: { id: string; name: string; nk: string }[];
  albums: { id: string; name: string; nk: string; artist: string }[];
  tracks: { id: string; name: string; uri: string | null; album: string | null; nk: string; artist: string; stub: number }[];
  shows: { id: string; name: string; nk: string }[];
  episodes: { id: string; name: string; uri: string | null; show: string }[];
  firstTs: number | null;
  lastTs: number | null;
}

const b = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v ? 1 : 0);

/**
 * Turn validated rows into listens plus the entity stubs they need. Pure, so
 * it is unit-tested directly. Tracks known only by name get a `name:` id that
 * the cleanup pass later swaps for a real one.
 */
export function prepareChunk(rows: ImportRow[]): PreparedChunk {
  const out: PreparedChunk = { listens: [], artists: [], albums: [], tracks: [], shows: [], episodes: [], firstTs: null, lastTs: null };
  const seenArtists = new Set<string>();
  const seenAlbums = new Set<string>();
  const seenTracks = new Set<string>();
  const seenShows = new Set<string>();
  const seenEpisodes = new Set<string>();

  for (const row of rows) {
    let trackId: string | null = null;
    let episodeId: string | null = null;
    let nameKey: string;
    let itemKey: string;

    if (row.kind === "track") {
      const realId = idFromUri(row.uri, "track");
      const trackName = row.track ?? "Unknown track";
      const artistName = row.artist ?? "Unknown artist";
      nameKey = trackNameKey(trackName, artistName);
      trackId = realId ?? trackStubId(trackName, artistName);
      itemKey = realId ?? nameKey;

      const artistId = artistStubId(artistName);
      if (!seenArtists.has(artistId)) {
        seenArtists.add(artistId);
        out.artists.push({ id: artistId, name: artistName, nk: normName(artistName) });
      }
      let albumId: string | null = null;
      if (row.album) {
        albumId = albumStubId(artistName, row.album);
        if (!seenAlbums.has(albumId)) {
          seenAlbums.add(albumId);
          out.albums.push({ id: albumId, name: row.album, nk: normName(row.album), artist: artistId });
        }
      }
      if (!seenTracks.has(trackId)) {
        seenTracks.add(trackId);
        out.tracks.push({
          id: trackId,
          name: trackName,
          uri: realId ? `spotify:track:${realId}` : null,
          album: albumId,
          nk: nameKey,
          artist: artistId,
          stub: realId ? 0 : 1,
        });
      }
    } else {
      const realId = idFromUri(row.uri, "episode");
      const showName = row.show ?? (row.kind === "audiobook" ? "Unknown audiobook" : "Unknown show");
      const episodeName = row.episode ?? "Unknown episode";
      nameKey = `${normName(episodeName)}|${normName(showName)}`;
      episodeId = realId ?? episodeStubId(showName, episodeName);
      itemKey = realId ?? row.uri ?? nameKey;

      const showId = showStubId(showName);
      if (!seenShows.has(showId)) {
        seenShows.add(showId);
        out.shows.push({ id: showId, name: showName, nk: normName(showName) });
      }
      if (!seenEpisodes.has(episodeId)) {
        seenEpisodes.add(episodeId);
        out.episodes.push({ id: episodeId, name: episodeName, uri: realId ? `spotify:episode:${realId}` : null, show: showId });
      }
    }

    out.listens.push({
      ts: row.ts,
      s: row.src,
      k: row.kind,
      ik: itemKey,
      t: trackId,
      e: episodeId,
      nk: nameKey,
      ms: row.ms,
      sk: b(row.skipped),
      rs: row.reasonStart ?? null,
      re: row.reasonEnd ?? null,
      sh: b(row.shuffle),
      of: b(row.offline),
      ic: b(row.incognito),
      pl: row.platform ?? null,
      co: row.country ?? null,
    });
    if (out.firstTs === null || row.ts < out.firstTs) out.firstTs = row.ts;
    if (out.lastTs === null || row.ts > out.lastTs) out.lastTs = row.ts;
  }
  return out;
}

const chunked = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Statements for one prepared chunk, in foreign-key-safe order. */
export function chunkStatements(env: Env, chunk: PreparedChunk, importId: string, now: number): { statements: D1PreparedStatement[]; listenStatements: number } {
  const db = env.DB;
  const j = (v: unknown) => JSON.stringify(v);
  const statements: D1PreparedStatement[] = [];
  const x = (field: string) => `json_extract(value, '$.${field}')`;

  for (const part of chunked(chunk.artists, ROWS_PER_STATEMENT)) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO artists (id, name, name_key, first_seen_at)
           SELECT ${x("id")}, ${x("name")}, ${x("nk")}, ?2 FROM json_each(?1)`,
        )
        .bind(j(part), now),
    );
  }
  for (const part of chunked(chunk.albums, ROWS_PER_STATEMENT)) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO albums (id, name, name_key, first_seen_at, enriched_at)
           SELECT ${x("id")}, ${x("name")}, ${x("nk")}, ?2, ?2 FROM json_each(?1)`,
        )
        .bind(j(part), now),
      db
        .prepare(
          `INSERT OR IGNORE INTO album_artists (album_id, artist_id, position)
           SELECT ${x("id")}, ${x("artist")}, 0 FROM json_each(?1)`,
        )
        .bind(j(part)),
    );
  }
  for (const part of chunked(chunk.tracks, ROWS_PER_STATEMENT)) {
    // Real ids queue for metadata/genre/feature lookups (status NULL); name-only
    // stubs can't be looked up until the cleanup/search pass resolves them.
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO tracks
             (id, name, uri, album_id, name_key, is_local, meta_status, deezer_status, features_status,
              first_seen_at, last_seen_at)
           SELECT ${x("id")}, ${x("name")}, ${x("uri")}, ${x("album")}, ${x("nk")}, 0,
                  CASE ${x("stub")} WHEN 1 THEN 'stub' END,
                  CASE ${x("stub")} WHEN 1 THEN 'skip' END,
                  CASE ${x("stub")} WHEN 1 THEN 'skip' END,
                  ?2, ?2
             FROM json_each(?1)`,
        )
        .bind(j(part), now),
      // Only tracks with no credits yet get the stub artist: a track already
      // collected live keeps its real artists.
      db
        .prepare(
          `INSERT OR IGNORE INTO track_artists (track_id, artist_id, position)
           SELECT tid, aid, 0 FROM (SELECT ${x("id")} AS tid, ${x("artist")} AS aid FROM json_each(?1))
            WHERE NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = tid)`,
        )
        .bind(j(part)),
    );
  }
  for (const part of chunked(chunk.shows, ROWS_PER_STATEMENT)) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO shows (id, name, name_key, first_seen_at)
           SELECT ${x("id")}, ${x("name")}, ${x("nk")}, ?2 FROM json_each(?1)`,
        )
        .bind(j(part), now),
    );
  }
  for (const part of chunked(chunk.episodes, ROWS_PER_STATEMENT)) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO episodes (id, name, uri, show_id, first_seen_at, last_seen_at)
           SELECT ${x("id")}, ${x("name")}, ${x("uri")}, ${x("show")}, ?2, ?2 FROM json_each(?1)`,
        )
        .bind(j(part), now),
    );
  }

  let listenStatements = 0;
  for (const part of chunked(chunk.listens, ROWS_PER_STATEMENT)) {
    listenStatements++;
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO listens
             (ts, source, kind, item_key, track_id, song_id, episode_id, name_key, ms_played, ms_estimated,
              skipped, reason_start, reason_end, shuffle, offline, incognito, platform, country,
              import_id, created_at)
           SELECT ${x("ts")}, ${x("s")}, ${x("k")}, ${x("ik")}, ${x("t")},
                  COALESCE((SELECT canonical_id FROM tracks WHERE id = ${x("t")}), ${x("t")}),
                  ${x("e")}, ${x("nk")}, ${x("ms")}, 0,
                  ${x("sk")}, ${x("rs")}, ${x("re")}, ${x("sh")}, ${x("of")}, ${x("ic")}, ${x("pl")}, ${x("co")},
                  ?2, ?3
             FROM json_each(?1)`,
        )
        .bind(j(part), importId, now),
    );
  }
  return { statements, listenStatements };
}

export interface InsertResult {
  received: number;
  accepted: number;
  inserted: number;
}

/** Validate, prepare and write one uploaded chunk, then update the batch's counters. */
export async function insertImportRows(env: Env, importId: string, raw: unknown[], now = Date.now()): Promise<InsertResult> {
  const rows: ImportRow[] = [];
  for (const r of raw) {
    const row = validateImportRow(r, now);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return { received: raw.length, accepted: 0, inserted: 0 };

  const chunk = prepareChunk(rows);
  const { statements, listenStatements } = chunkStatements(env, chunk, importId, now);
  const results = await env.DB.batch(statements);
  // The listen inserts are the last statements in the batch.
  const inserted = results.slice(-listenStatements).reduce((n, r) => n + (r.meta.changes ?? 0), 0);

  await env.DB.prepare(
    `UPDATE imports
        SET rows_received = rows_received + ?2,
            rows_inserted = rows_inserted + ?3,
            first_ts = MIN(COALESCE(first_ts, ?4), ?4),
            last_ts  = MAX(COALESCE(last_ts, ?5), ?5)
      WHERE id = ?1`,
  )
    .bind(importId, rows.length, inserted, chunk.firstTs, chunk.lastTs)
    .run();

  return { received: raw.length, accepted: rows.length, inserted };
}
