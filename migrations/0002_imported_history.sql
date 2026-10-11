-- Optional: holds Spotify's "Extended Streaming History" GDPR export.
--
-- Why a separate table instead of writing into `plays`:
--   * The export identifies tracks only by URI plus free-text names. Most of
--     those tracks have no row in `tracks`, so they could not satisfy the FK.
--   * The export carries fields live polling cannot see at all — actual
--     ms_played, skipped, reason_start/reason_end, platform, country.
--   * Keeping it separate means a re-import can be truncated and redone without
--     ever touching continuously-collected data.
--
-- `v_all_plays` unions both sources into one timeline for querying.

CREATE TABLE imported_plays (
  -- Composite natural key: the export can legitimately contain two entries with
  -- the same timestamp (e.g. an offline sync replaying), but not for the same URI.
  played_at     INTEGER NOT NULL,   -- unix ms; the export's `ts` is play STOP time
  played_at_iso TEXT    NOT NULL,
  item_uri      TEXT,               -- spotify:track:... or spotify:episode:...
  item_type     TEXT    NOT NULL DEFAULT 'track',
  track_name    TEXT,
  artist_name   TEXT,
  album_name    TEXT,
  episode_name  TEXT,
  show_name     TEXT,
  ms_played     INTEGER,
  reason_start  TEXT,
  reason_end    TEXT,
  skipped       INTEGER,
  shuffle       INTEGER,
  offline       INTEGER,
  platform      TEXT,
  conn_country  TEXT,
  imported_at   INTEGER NOT NULL,
  PRIMARY KEY (played_at, item_uri)
);

CREATE INDEX idx_imported_played_at ON imported_plays (played_at);
CREATE INDEX idx_imported_uri ON imported_plays (item_uri);
CREATE INDEX idx_imported_artist ON imported_plays (artist_name);

-- Unified timeline. `ms_played` is only ever populated for imported rows; live
-- rows report NULL because the recently-played endpoint does not expose it.
CREATE VIEW v_all_plays AS
SELECT
  played_at,
  played_at_iso,
  'live'                AS origin,
  track_id              AS item_id,
  track_name,
  artist_names          AS artist_name,
  album_name,
  duration_ms,
  NULL                  AS ms_played,
  NULL                  AS skipped,
  context_uri
FROM v_plays
UNION ALL
SELECT
  played_at,
  played_at_iso,
  'import'              AS origin,
  item_uri              AS item_id,
  COALESCE(track_name, episode_name) AS track_name,
  COALESCE(artist_name, show_name)   AS artist_name,
  album_name,
  NULL                  AS duration_ms,
  ms_played,
  skipped,
  NULL                  AS context_uri
FROM imported_plays;
