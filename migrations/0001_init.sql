-- Spotify collection: initial schema.
--
-- Conventions:
--   * All timestamps are INTEGER unix milliseconds (SQLite has no date type).
--     Where a human-readable copy is useful we keep a parallel ISO-8601 TEXT column.
--   * Booleans are INTEGER 0/1.
--   * Entity tables (tracks/albums/artists/episodes/shows) are content-addressed by
--     Spotify ID and upserted, so the play log stays skinny and the raw API JSON is
--     stored exactly once per entity rather than once per play.

-- ---------------------------------------------------------------------------
-- Auth + bookkeeping
-- ---------------------------------------------------------------------------

-- Single-row table holding the OAuth tokens for the one account we track.
-- The CHECK constraint makes "there is only ever one row" a schema guarantee.
CREATE TABLE auth_tokens (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  access_token      TEXT    NOT NULL,
  refresh_token     TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL,  -- access token expiry (unix ms)
  scope             TEXT    NOT NULL,
  spotify_user_id   TEXT,
  display_name      TEXT,
  -- When the refresh token was first issued. Spotify documents a 6-month
  -- refresh-token lifetime that refreshing does NOT extend, so /health uses
  -- this to warn before collection silently dies.
  authorized_at     INTEGER NOT NULL,
  last_refreshed_at INTEGER,
  refresh_count     INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

-- Cursors and small bits of collector state, e.g. the recently-played watermark.
CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);

-- Diagnostic log of outbound Spotify calls. Pruned by the hourly cron per
-- API_LOG_RETENTION_DAYS.
CREATE TABLE api_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  called_at    INTEGER NOT NULL,
  job          TEXT    NOT NULL,  -- 'sample' | 'recent' | 'enrich' | 'auth' | 'manual'
  endpoint     TEXT    NOT NULL,
  status       INTEGER,           -- HTTP status, NULL if the request threw
  duration_ms  INTEGER,
  items        INTEGER NOT NULL DEFAULT 0,  -- rows ingested as a result
  error        TEXT
);

CREATE INDEX idx_api_calls_called_at ON api_calls (called_at DESC);
CREATE INDEX idx_api_calls_error ON api_calls (called_at DESC) WHERE error IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Entities
-- ---------------------------------------------------------------------------

CREATE TABLE artists (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  uri           TEXT,
  -- genres/popularity/followers are marked deprecated in Spotify's docs but
  -- still populated today. We snapshot them while they exist; NULL is normal.
  genres        TEXT,     -- JSON array of strings
  popularity    INTEGER,
  followers     INTEGER,
  image_url     TEXT,
  raw           TEXT,     -- full artist object JSON, from the enrichment pass
  first_seen_at INTEGER NOT NULL,
  -- NULL means "seen only as a stub on a track object; full record not fetched yet".
  enriched_at   INTEGER
);

CREATE INDEX idx_artists_enrich_queue ON artists (first_seen_at) WHERE enriched_at IS NULL;
CREATE INDEX idx_artists_name ON artists (name);

CREATE TABLE albums (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  uri                    TEXT,
  album_type             TEXT,     -- album | single | compilation
  release_date           TEXT,     -- as returned; precision varies
  release_date_precision TEXT,     -- year | month | day
  release_year           INTEGER,  -- parsed leading 4 digits, for cheap grouping
  total_tracks           INTEGER,
  label                  TEXT,     -- enrichment only
  popularity             INTEGER,  -- enrichment only
  genres                 TEXT,     -- JSON array, enrichment only
  image_url              TEXT,
  raw                    TEXT,
  first_seen_at          INTEGER NOT NULL,
  enriched_at            INTEGER
);

CREATE INDEX idx_albums_enrich_queue ON albums (first_seen_at) WHERE enriched_at IS NULL;

CREATE TABLE tracks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  uri           TEXT,
  album_id      TEXT REFERENCES albums (id),
  duration_ms   INTEGER,
  explicit      INTEGER,
  popularity    INTEGER,
  track_number  INTEGER,
  disc_number   INTEGER,
  isrc          TEXT,
  is_local      INTEGER NOT NULL DEFAULT 0,
  raw           TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE INDEX idx_tracks_album ON tracks (album_id);
CREATE INDEX idx_tracks_name ON tracks (name);
CREATE INDEX idx_tracks_isrc ON tracks (isrc) WHERE isrc IS NOT NULL;

CREATE TABLE track_artists (
  track_id  TEXT    NOT NULL REFERENCES tracks (id),
  artist_id TEXT    NOT NULL REFERENCES artists (id),
  position  INTEGER NOT NULL,  -- 0 = primary/credited-first artist
  PRIMARY KEY (track_id, artist_id)
);

CREATE INDEX idx_track_artists_artist ON track_artists (artist_id);

CREATE TABLE album_artists (
  album_id  TEXT    NOT NULL REFERENCES albums (id),
  artist_id TEXT    NOT NULL REFERENCES artists (id),
  position  INTEGER NOT NULL,
  PRIMARY KEY (album_id, artist_id)
);

CREATE INDEX idx_album_artists_artist ON album_artists (artist_id);

-- Podcasts. Reachable only via the /me/player sampler: the recently-played
-- endpoint documents that it does not return podcast episodes.
CREATE TABLE shows (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  uri           TEXT,
  publisher     TEXT,
  image_url     TEXT,
  raw           TEXT,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE episodes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  uri           TEXT,
  show_id       TEXT REFERENCES shows (id),
  duration_ms   INTEGER,
  release_date  TEXT,
  explicit      INTEGER,
  description   TEXT,
  image_url     TEXT,
  raw           TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE INDEX idx_episodes_show ON episodes (show_id);

-- ---------------------------------------------------------------------------
-- The actual listening data
-- ---------------------------------------------------------------------------

-- Completed plays. `played_at` (unix ms, from Spotify) is the primary key, which
-- makes ingestion idempotent: re-polling the same window is INSERT OR IGNORE and
-- can never create duplicates, no matter how often crons overlap or retry.
--
-- Spotify only reports a track here once it has been played for >30s, and only
-- keeps a rolling window of the last 50 items — hence the 5-minute poll.
CREATE TABLE plays (
  played_at     INTEGER PRIMARY KEY,
  played_at_iso TEXT    NOT NULL,
  track_id      TEXT    REFERENCES tracks (id),
  duration_ms   INTEGER,           -- track length at time of play (denormalised on purpose)
  context_type  TEXT,              -- playlist | album | artist | collection | NULL
  context_uri   TEXT,
  source        TEXT    NOT NULL DEFAULT 'recently_played',  -- or 'import'
  ingested_at   INTEGER NOT NULL
);

CREATE INDEX idx_plays_track ON plays (track_id);
CREATE INDEX idx_plays_context ON plays (context_uri) WHERE context_uri IS NOT NULL;
CREATE INDEX idx_plays_ingested ON plays (ingested_at);

-- Point-in-time samples of the player, one per minute-cron tick — but only
-- written when something actually changed (different item, play/pause flip,
-- device change, or a seek). Idle time costs no rows.
--
-- This is the only source for: podcast listening, tracks skipped before the 30s
-- threshold, playback context/device, and shuffle/repeat state.
CREATE TABLE playback_samples (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at           INTEGER NOT NULL,  -- our clock, unix ms
  spotify_timestamp    INTEGER,           -- Spotify's own `timestamp` field
  item_type            TEXT,              -- track | episode | ad | unknown | none
  track_id             TEXT REFERENCES tracks (id),
  episode_id           TEXT REFERENCES episodes (id),
  item_name            TEXT,              -- denormalised for local/unresolvable items
  progress_ms          INTEGER,
  duration_ms          INTEGER,
  is_playing           INTEGER NOT NULL DEFAULT 0,
  device_id            TEXT,
  device_name          TEXT,
  device_type          TEXT,
  volume_percent       INTEGER,
  shuffle_state        INTEGER,
  repeat_state         TEXT,
  context_type         TEXT,
  context_uri          TEXT
);

CREATE INDEX idx_samples_sampled_at ON playback_samples (sampled_at DESC);
CREATE INDEX idx_samples_track ON playback_samples (track_id, sampled_at);
CREATE INDEX idx_samples_episode ON playback_samples (episode_id, sampled_at);

-- ---------------------------------------------------------------------------
-- Views: the read-friendly layer. Cheap, no storage, redefinable in a later
-- migration without touching the underlying data.
-- ---------------------------------------------------------------------------

-- One row per play, flattened with artist/album names already joined.
CREATE VIEW v_plays AS
SELECT
  p.played_at,
  p.played_at_iso,
  p.track_id,
  t.name                                              AS track_name,
  t.duration_ms,
  t.popularity                                        AS track_popularity,
  t.explicit,
  al.id                                               AS album_id,
  al.name                                             AS album_name,
  al.release_date,
  al.release_year,
  (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
     FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
    WHERE ta.track_id = t.id)                         AS artist_names,
  (SELECT a.id
     FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
    WHERE ta.track_id = t.id
    ORDER BY ta.position LIMIT 1)                     AS primary_artist_id,
  p.context_type,
  p.context_uri,
  p.source
FROM plays p
LEFT JOIN tracks t ON t.id = p.track_id
LEFT JOIN albums al ON al.id = t.album_id;

CREATE VIEW v_top_tracks AS
SELECT
  t.id            AS track_id,
  t.name          AS track_name,
  (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
     FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
    WHERE ta.track_id = t.id)                      AS artist_names,
  COUNT(*)        AS play_count,
  SUM(COALESCE(p.duration_ms, t.duration_ms, 0)) AS approx_ms,
  MIN(p.played_at) AS first_played_at,
  MAX(p.played_at) AS last_played_at
FROM plays p
JOIN tracks t ON t.id = p.track_id
GROUP BY t.id;

CREATE VIEW v_top_artists AS
SELECT
  a.id       AS artist_id,
  a.name     AS artist_name,
  a.genres,
  COUNT(*)   AS play_count,
  COUNT(DISTINCT p.track_id) AS distinct_tracks,
  SUM(COALESCE(p.duration_ms, t.duration_ms, 0)) AS approx_ms,
  MAX(p.played_at) AS last_played_at
FROM plays p
JOIN tracks t ON t.id = p.track_id
JOIN track_artists ta ON ta.track_id = t.id
JOIN artists a ON a.id = ta.artist_id
GROUP BY a.id;

-- Listening per UTC day. Shift the divisor if you'd rather bucket by local time.
CREATE VIEW v_daily AS
SELECT
  date(played_at / 1000, 'unixepoch')            AS day,
  COUNT(*)                                       AS play_count,
  COUNT(DISTINCT track_id)                       AS distinct_tracks,
  SUM(COALESCE(duration_ms, 0)) / 60000          AS approx_minutes
FROM plays
GROUP BY day;

-- Groups consecutive samples of the same item into contiguous listening spans.
-- Useful for podcasts and for spotting tracks abandoned before the 30s mark
-- (which therefore never reach `plays`).
CREATE VIEW v_sample_spans AS
SELECT
  MIN(sampled_at)                    AS started_at,
  MAX(sampled_at)                    AS last_seen_at,
  item_type,
  COALESCE(track_id, episode_id)     AS item_id,
  item_name,
  MIN(progress_ms)                   AS min_progress_ms,
  MAX(progress_ms)                   AS max_progress_ms,
  duration_ms,
  COUNT(*)                           AS sample_count,
  device_name,
  context_uri
FROM (
  SELECT
    s.*,
    ROW_NUMBER() OVER (ORDER BY sampled_at)
      - ROW_NUMBER() OVER (PARTITION BY COALESCE(track_id, episode_id, item_name, 'none')
                           ORDER BY sampled_at) AS span_group
  FROM playback_samples s
)
GROUP BY span_group, COALESCE(track_id, episode_id, item_name, 'none')
ORDER BY started_at DESC;
