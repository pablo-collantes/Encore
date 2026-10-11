-- Encore: one de-duplicated listening timeline across every source, the
-- enrichment the dashboard needs (genres, audio features, artwork), the
-- dashboard's sign-in sessions, and Spotify's own top lists.
--
-- Sources of listening:
--   extended  Spotify "Extended streaming history" export (lifetime; URIs,
--             real ms_played, skips, platform, country)
--   account   Spotify "Account data" export (last ~12 months; names only,
--             minute-precision end time)
--   live      the recently-played collector (`plays`), mirrored in by trigger
--
-- The same stream can arrive from several sources. Every row is kept, and the
-- cleanup pass (src/worker/cleanup.ts) points lower-priority copies at the row
-- that supersedes them via `dup_of` (priority: extended > live > account).
-- Stats only ever read `dup_of IS NULL`.

-- ---------------------------------------------------------------------------
-- Dashboard sign-in
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,    -- sha256(cookie value); the raw token is never stored
  spotify_user_id TEXT NOT NULL,       -- must equal auth_tokens.spotify_user_id to be valid
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  user_agent      TEXT
);

CREATE INDEX idx_sessions_expires ON sessions (expires_at);

ALTER TABLE auth_tokens ADD COLUMN image_url TEXT;

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------

CREATE TABLE imports (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT    NOT NULL DEFAULT 'uploading',  -- uploading | done | failed
  files         TEXT    NOT NULL DEFAULT '[]',         -- JSON [{name, kind, rows}]
  rows_received INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  first_ts      INTEGER,
  last_ts       INTEGER,
  duplicates    INTEGER
);

-- ---------------------------------------------------------------------------
-- The timeline
-- ---------------------------------------------------------------------------

CREATE TABLE listens (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,   -- unix ms when the stream ENDED (Spotify's convention everywhere)
  source       TEXT    NOT NULL CHECK (source IN ('extended', 'account', 'live')),
  kind         TEXT    NOT NULL CHECK (kind IN ('track', 'episode', 'audiobook')),
  -- Identity within its source, so re-uploading the same export is a no-op.
  item_key     TEXT    NOT NULL,
  track_id     TEXT,               -- tracks.id: Spotify id, or a `name:` / `local:` synthetic
  -- The track the stats group on: track_id, or the canonical version of the
  -- same recording (same ISRC) once the cleanup pass has found one.
  song_id      TEXT,
  episode_id   TEXT,               -- episodes.id (Spotify id or `name:` synthetic)
  -- normName(track)|normName(artist) (episodes: episode|show). Used to match
  -- name-only rows to known tracks and to spot the same stream across sources.
  name_key     TEXT,
  ms_played    INTEGER NOT NULL,
  ms_estimated INTEGER NOT NULL DEFAULT 0,  -- 1 = ms_played is the track length (live plays)
  skipped      INTEGER,
  reason_start TEXT,
  reason_end   TEXT,
  shuffle      INTEGER,
  offline      INTEGER,
  incognito    INTEGER,
  platform     TEXT,
  country      TEXT,
  context_uri  TEXT,
  dup_of       INTEGER,            -- NULL = counted; else the id of the listen that supersedes it
  import_id    TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (source, ts, item_key, ms_played)
);

-- The stats workhorse: every aggregate filters `dup_of IS NULL` and a ts range,
-- and reads only these columns, so this partial index covers them.
CREATE INDEX idx_listens_canon ON listens (ts, kind, song_id, ms_played) WHERE dup_of IS NULL;
CREATE INDEX idx_listens_source_ts ON listens (source, ts);
CREATE INDEX idx_listens_song_ts ON listens (song_id, ts);
CREATE INDEX idx_listens_track ON listens (track_id);
CREATE INDEX idx_listens_episode ON listens (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX idx_listens_import ON listens (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX idx_listens_name_only ON listens (name_key) WHERE track_id LIKE 'name:%';

-- Live plays join the timeline the moment the collector writes them. If an
-- extended-history row for the same stream is already there, the live copy is
-- born a duplicate. (recently-played `played_at` is the stream's END time,
-- verified against the 1-minute player samples, same as the export's `ts`.)
CREATE TRIGGER trg_plays_to_listens AFTER INSERT ON plays
BEGIN
  INSERT OR IGNORE INTO listens
    (ts, source, kind, item_key, track_id, song_id, name_key, ms_played, ms_estimated,
     context_uri, created_at, dup_of)
  VALUES (
    NEW.played_at, 'live', 'track', COALESCE(NEW.track_id, 'unknown'), NEW.track_id,
    COALESCE((SELECT canonical_id FROM tracks WHERE id = NEW.track_id), NEW.track_id),
    (SELECT name_key FROM tracks WHERE id = NEW.track_id),
    COALESCE(NEW.duration_ms, (SELECT duration_ms FROM tracks WHERE id = NEW.track_id), 0), 1,
    NEW.context_uri, NEW.ingested_at,
    (SELECT e.id FROM listens e
      WHERE e.source = 'extended'
        AND e.ts BETWEEN NEW.played_at - 90000 AND NEW.played_at + 90000
        AND (e.track_id = NEW.track_id
             OR e.name_key = (SELECT name_key FROM tracks WHERE id = NEW.track_id))
      ORDER BY abs(e.ts - NEW.played_at) LIMIT 1)
  );
END;

-- ---------------------------------------------------------------------------
-- Entity columns for cleanup + enrichment
-- ---------------------------------------------------------------------------

ALTER TABLE tracks ADD COLUMN name_key TEXT;
ALTER TABLE tracks ADD COLUMN canonical_id TEXT;      -- same-ISRC version the stats merge this into
ALTER TABLE tracks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;  -- total ms listened; enrichment order
ALTER TABLE tracks ADD COLUMN meta_status TEXT;       -- NULL pending | ok | missing (GET /tracks/{id})
ALTER TABLE tracks ADD COLUMN enriched_at INTEGER;
ALTER TABLE tracks ADD COLUMN deezer_id INTEGER;
ALTER TABLE tracks ADD COLUMN deezer_album_id INTEGER;
ALTER TABLE tracks ADD COLUMN deezer_status TEXT;     -- NULL pending | ok | missing
ALTER TABLE tracks ADD COLUMN features_status TEXT;   -- NULL pending | reccobeats | pending_analysis | analysis | missing
ALTER TABLE tracks ADD COLUMN search_status TEXT;     -- `name:` tracks: NULL pending | found | missing

CREATE INDEX idx_tracks_name_key ON tracks (name_key);
CREATE INDEX idx_tracks_meta_queue ON tracks (priority DESC) WHERE meta_status IS NULL;
CREATE INDEX idx_tracks_deezer_queue ON tracks (priority DESC) WHERE deezer_status IS NULL;
CREATE INDEX idx_tracks_features_queue ON tracks (features_status, priority DESC);
CREATE INDEX idx_tracks_canonical ON tracks (canonical_id) WHERE canonical_id IS NOT NULL;

ALTER TABLE artists ADD COLUMN name_key TEXT;
ALTER TABLE artists ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artists ADD COLUMN mb_id TEXT;
ALTER TABLE artists ADD COLUMN mb_status TEXT;        -- NULL pending | ok | missing

CREATE INDEX idx_artists_name_key ON artists (name_key);
CREATE INDEX idx_artists_mb_queue ON artists (priority DESC) WHERE mb_status IS NULL;

ALTER TABLE albums ADD COLUMN name_key TEXT;

CREATE INDEX idx_albums_name_key ON albums (name_key);

ALTER TABLE shows ADD COLUMN name_key TEXT;

-- Tracks first seen as full Spotify objects (everything collected so far) need
-- no metadata lookup.
UPDATE tracks SET meta_status = 'ok', enriched_at = first_seen_at
 WHERE raw IS NOT NULL AND id NOT LIKE 'local:%';
UPDATE tracks SET meta_status = 'missing', deezer_status = 'missing', features_status = 'missing'
 WHERE id LIKE 'local:%';
-- Album lookups no longer add anything (dev-mode apps get no label/popularity);
-- the album stub from the track object is the record.
UPDATE albums SET enriched_at = COALESCE(enriched_at, first_seen_at);

-- ---------------------------------------------------------------------------
-- Enrichment results
-- ---------------------------------------------------------------------------

-- Energy, mood and tempo. Spotify retired audio-features for new apps in 2024;
-- these come from ReccoBeats, either by Spotify id or by analysing the track's
-- 30-second Deezer preview.
CREATE TABLE audio_features (
  track_id         TEXT PRIMARY KEY,
  source           TEXT NOT NULL,      -- reccobeats | analysis
  acousticness     REAL,
  danceability     REAL,
  energy           REAL,
  instrumentalness REAL,
  liveness         REAL,
  loudness         REAL,
  speechiness      REAL,
  tempo            REAL,
  valence          REAL,
  musical_key      INTEGER,
  mode             INTEGER,
  fetched_at       INTEGER NOT NULL
);

-- Broad genres (Deezer's ~30, e.g. "Alternative", "Rap/Hip Hop"), per album,
-- found through the track's ISRC.
CREATE TABLE deezer_albums (
  id         INTEGER PRIMARY KEY,
  genres     TEXT NOT NULL DEFAULT '[]',   -- JSON array of names
  fetched_at INTEGER NOT NULL
);

CREATE TABLE track_genres (
  track_id TEXT NOT NULL,
  genre    TEXT NOT NULL,
  PRIMARY KEY (track_id, genre)
);

CREATE INDEX idx_track_genres_genre ON track_genres (genre);

-- Detailed genres (MusicBrainz's community-voted genres, e.g. "indie pop",
-- "post-punk revival"), per artist.
CREATE TABLE artist_tags (
  artist_id TEXT    NOT NULL,
  tag       TEXT    NOT NULL,
  votes     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (artist_id, tag)
);

CREATE INDEX idx_artist_tags_tag ON artist_tags (tag);

-- ---------------------------------------------------------------------------
-- Spotify's own top lists (GET /me/top/{tracks,artists}), snapshotted daily —
-- the same data Receiptify and similar apps show.
-- ---------------------------------------------------------------------------

CREATE TABLE top_snapshots (
  taken_at   INTEGER NOT NULL,
  time_range TEXT    NOT NULL,   -- short_term (~4 weeks) | medium_term (~6 months) | long_term (~1 year)
  kind       TEXT    NOT NULL,   -- track | artist
  rank       INTEGER NOT NULL,
  item_id    TEXT    NOT NULL,
  PRIMARY KEY (taken_at, time_range, kind, rank)
);

CREATE INDEX idx_top_snapshots_latest ON top_snapshots (kind, time_range, taken_at DESC);

-- ---------------------------------------------------------------------------
-- Backfill the timeline from what is already collected
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO listens
  (ts, source, kind, item_key, track_id, song_id, ms_played, ms_estimated, context_uri, created_at)
SELECT p.played_at, 'live', 'track', COALESCE(p.track_id, 'unknown'), p.track_id, p.track_id,
       COALESCE(p.duration_ms, t.duration_ms, 0), 1, p.context_uri, p.ingested_at
  FROM plays p LEFT JOIN tracks t ON t.id = p.track_id;

-- Rows loaded by the old /admin/import (migration 0002) move over too. Their
-- tracks get entity stubs the next time the cleanup pass runs.
INSERT OR IGNORE INTO listens
  (ts, source, kind, item_key, track_id, song_id, episode_id, ms_played, skipped, reason_start,
   reason_end, shuffle, offline, platform, country, created_at)
SELECT played_at, 'extended', item_type,
       COALESCE(item_uri, COALESCE(track_name, episode_name, '') || '|' || COALESCE(artist_name, show_name, '')),
       CASE WHEN item_uri LIKE 'spotify:track:%' THEN substr(item_uri, 15) END,
       CASE WHEN item_uri LIKE 'spotify:track:%' THEN substr(item_uri, 15) END,
       CASE WHEN item_uri LIKE 'spotify:episode:%' THEN substr(item_uri, 17) END,
       COALESCE(ms_played, 0), skipped, reason_start, reason_end, shuffle, offline, platform,
       conn_country, imported_at
  FROM imported_plays
 WHERE item_type IN ('track', 'episode');
