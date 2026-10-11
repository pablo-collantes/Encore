-- Stored listening totals ("rollups"): All time and every calendar year are
-- worked out once and kept here, then only adjusted for what changes. A new
-- listen adds its minutes to its day, year, song, artist, genres and so on; it
-- never makes the dashboard read the rest of the timeline again.
--
-- src/worker/stats/rollup.ts keeps these tables up to date (the "fold"):
--   * new listens: every listens row above the watermark (sync_state roll_wm)
--   * changed or deleted listens at or below it: the triggers below copy each
--     one's previous state into roll_log, so the fold can take it back out and
--     add the current state in
--   * enrichment that changes what a listen counts towards (a track's artists,
--     album, genres or audio features, an artist's genres, an episode's show):
--     the triggers mark the track/artist in roll_dirty and keep its previous
--     mapping in roll_old_*, so the fold can move just that track's listens
-- Periods: p = 0 is All time, p = 2024 is the calendar year 2024 in the stats
-- time zone (STATS_TZ in wrangler.jsonc). Days, weeks and months are local too.

-- ---------------------------------------------------------------------------
-- Change capture
-- ---------------------------------------------------------------------------

-- Previous state of a listen already counted in the totals (one row per
-- listen: the state the totals still reflect).
CREATE TABLE roll_log (
  listen_id    INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  ms_played    INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  song_id      TEXT,
  episode_id   TEXT,
  skipped      INTEGER,
  platform     TEXT,
  country      TEXT,
  reason_start TEXT,
  reason_end   TEXT,
  shuffle      INTEGER,
  offline      INTEGER,
  counted      INTEGER NOT NULL   -- 1 = dup_of IS NULL
);

CREATE INDEX idx_roll_log_song ON roll_log (song_id);

-- kind: ta (a track's artists changed), tg (its genres), feat (its audio
-- features), tags (an artist's genres), art / alb / show (an artist, album or
-- show whose totals must be summed again).
CREATE TABLE roll_dirty (
  kind TEXT NOT NULL,
  key  TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);

CREATE TABLE roll_old_ta (track_id TEXT NOT NULL, artist_id TEXT NOT NULL, PRIMARY KEY (track_id, artist_id));
CREATE TABLE roll_old_tg (track_id TEXT NOT NULL, genre TEXT NOT NULL, PRIMARY KEY (track_id, genre));
CREATE TABLE roll_old_tags (artist_id TEXT NOT NULL, tag TEXT NOT NULL, votes INTEGER NOT NULL, PRIMARY KEY (artist_id, tag));
CREATE TABLE roll_old_feat (
  track_id         TEXT PRIMARY KEY,
  energy           REAL,
  valence          REAL,
  danceability     REAL,
  acousticness     REAL,
  instrumentalness REAL,
  speechiness      REAL,
  liveness         REAL,
  tempo            REAL,
  loudness         REAL
);

-- Time ranges whose listening sessions must be worked out again.
CREATE TABLE roll_sess_dirty (id INTEGER PRIMARY KEY, lo INTEGER NOT NULL, hi INTEGER NOT NULL);

-- ---------------------------------------------------------------------------
-- The totals
-- ---------------------------------------------------------------------------

-- Per local day. Counts are of counted listens unless noted.
CREATE TABLE roll_days (
  day         TEXT PRIMARY KEY,               -- YYYY-MM-DD
  ms          INTEGER NOT NULL DEFAULT 0,
  streams     INTEGER NOT NULL DEFAULT 0,
  plays       INTEGER NOT NULL DEFAULT 0,     -- streams of 30 s or more
  skips       INTEGER NOT NULL DEFAULT 0,
  spoken_ms   INTEGER NOT NULL DEFAULT 0,
  extended    INTEGER NOT NULL DEFAULT 0,     -- streams per source
  account     INTEGER NOT NULL DEFAULT 0,
  live        INTEGER NOT NULL DEFAULT 0,
  dups        INTEGER NOT NULL DEFAULT 0,     -- hidden duplicates (not counted)
  e_sum       REAL    NOT NULL DEFAULT 0,     -- music: sum of energy x ms, and the ms that had it
  e_ms        REAL    NOT NULL DEFAULT 0,
  v_sum       REAL    NOT NULL DEFAULT 0,     -- valence
  v_ms        REAL    NOT NULL DEFAULT 0,
  d_sum       REAL    NOT NULL DEFAULT 0,     -- danceability
  d_ms        REAL    NOT NULL DEFAULT 0,
  new_songs   INTEGER NOT NULL DEFAULT 0,     -- songs / artists first heard this day
  new_artists INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_roll_days_empty ON roll_days (day) WHERE streams = 0 AND dups = 0 AND new_songs = 0 AND new_artists = 0;

CREATE TABLE roll_songs (
  song_id   TEXT    NOT NULL,
  p         INTEGER NOT NULL,
  ms        INTEGER NOT NULL,
  plays     INTEGER NOT NULL,
  streams   INTEGER NOT NULL,
  skips     INTEGER NOT NULL,
  first_ts  INTEGER NOT NULL,
  last_ts   INTEGER NOT NULL,
  first_day TEXT    NOT NULL,
  PRIMARY KEY (song_id, p)
);
CREATE INDEX idx_roll_songs_ms ON roll_songs (p, ms DESC);
CREATE INDEX idx_roll_songs_plays ON roll_songs (p, plays DESC, ms DESC);
-- Rows a fold emptied (only ever a handful, so deleting them reads nothing else).
CREATE INDEX idx_roll_songs_empty ON roll_songs (p) WHERE streams <= 0;
-- First listens ("discoveries" in any range) without reading the timeline.
CREATE INDEX idx_roll_songs_first ON roll_songs (first_ts) WHERE p = 0;

CREATE TABLE roll_artists (
  artist_id TEXT    NOT NULL,
  p         INTEGER NOT NULL,
  ms        INTEGER NOT NULL,
  plays     INTEGER NOT NULL,
  streams   INTEGER NOT NULL,
  tracks    INTEGER NOT NULL,
  first_ts  INTEGER NOT NULL,
  last_ts   INTEGER NOT NULL,
  first_day TEXT    NOT NULL,
  PRIMARY KEY (artist_id, p)
);
CREATE INDEX idx_roll_artists_ms ON roll_artists (p, ms DESC);
CREATE INDEX idx_roll_artists_plays ON roll_artists (p, plays DESC, ms DESC);
CREATE INDEX idx_roll_artists_first ON roll_artists (first_ts) WHERE p = 0;

CREATE TABLE roll_albums (
  album_id TEXT    NOT NULL,
  p        INTEGER NOT NULL,
  ms       INTEGER NOT NULL,
  plays    INTEGER NOT NULL,
  streams  INTEGER NOT NULL,
  tracks   INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts  INTEGER NOT NULL,
  PRIMARY KEY (album_id, p)
);
CREATE INDEX idx_roll_albums_ms ON roll_albums (p, ms DESC);
CREATE INDEX idx_roll_albums_plays ON roll_albums (p, plays DESC, ms DESC);

CREATE TABLE roll_episodes (
  episode_id TEXT    NOT NULL,
  p          INTEGER NOT NULL,
  ms         INTEGER NOT NULL,
  streams    INTEGER NOT NULL,
  last_ts    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  PRIMARY KEY (episode_id, p)
);
CREATE INDEX idx_roll_episodes_ms ON roll_episodes (p, ms DESC);
CREATE INDEX idx_roll_episodes_empty ON roll_episodes (p) WHERE streams <= 0;

CREATE TABLE roll_shows (
  show_id  TEXT    NOT NULL,
  p        INTEGER NOT NULL,
  ms       INTEGER NOT NULL,
  episodes INTEGER NOT NULL,
  last_ts  INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  PRIMARY KEY (show_id, p)
);
CREATE INDEX idx_roll_shows_ms ON roll_shows (p, ms DESC);

-- Everything else per period, as (key, ms, n). Families (rollup.ts):
--   tot spoken mt plays skips detailed shuffle offline src:* songs artists
--   albums days ss c:wd:h pf:* cc:* rs:* re:* mh:* mf:* mhe:* mhv:* meh:*
--   mvh:* mth:* mq:* gd:* gdc gm:* gmt gmc gac:*
CREATE TABLE roll_facts (
  p  INTEGER NOT NULL,
  k  TEXT    NOT NULL,
  ms REAL    NOT NULL DEFAULT 0,
  n  REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (p, k)
);

-- Genre timeline: listening per genre per local week (b = 'w2025:2025-12-29':
-- the year, then the week's Monday, so a week across New Year splits between
-- the two years) and month (b = 'm:2025-12'); genre '*' is all genres together.
CREATE TABLE roll_gb (
  src   TEXT NOT NULL,   -- d = Deezer, m = MusicBrainz
  genre TEXT NOT NULL,
  b     TEXT NOT NULL,
  ms    REAL NOT NULL,
  PRIMARY KEY (src, genre, b)
);

-- The artists behind each genre.
CREATE TABLE roll_garts (
  p         INTEGER NOT NULL,
  src       TEXT    NOT NULL,
  genre     TEXT    NOT NULL,
  artist_id TEXT    NOT NULL,
  ms        REAL    NOT NULL,      -- the artist's listening (not split between genres)
  n         INTEGER NOT NULL,      -- streams
  PRIMARY KEY (p, src, genre, artist_id)
);
CREATE INDEX idx_roll_garts_ms ON roll_garts (p, src, genre, ms DESC);
CREATE INDEX idx_roll_garts_empty ON roll_garts (p) WHERE n = 0;

-- Listening sessions (a gap of more than 30 minutes starts a new one).
CREATE TABLE roll_sessions (
  start INTEGER PRIMARY KEY,   -- first stream's start
  end   INTEGER NOT NULL,      -- last stream's end
  ms    INTEGER NOT NULL,
  p     INTEGER NOT NULL       -- local year of `start`
);
CREATE INDEX idx_roll_sessions_p ON roll_sessions (p, ms DESC);
CREATE INDEX idx_roll_sessions_ms ON roll_sessions (ms DESC);

-- Bumped whenever a period's totals change: part of the KV key of answers
-- built from them, so a past year's stored answers outlive new listening.
CREATE TABLE roll_pv (p INTEGER PRIMARY KEY, v INTEGER NOT NULL);

-- ---------------------------------------------------------------------------
-- Triggers: listens
--
-- Inserts in these triggers say ON CONFLICT DO NOTHING rather than INSERT OR
-- IGNORE: when the statement that fires a trigger is an upsert taking its DO
-- UPDATE path, SQLite replaces an OR IGNORE inside the trigger with its own
-- policy and the duplicate aborts the write.
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_roll_listen_update AFTER UPDATE ON listens
WHEN OLD.id <= (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key = 'roll_wm')
 AND (OLD.ts != NEW.ts OR OLD.ms_played != NEW.ms_played OR OLD.kind != NEW.kind OR OLD.source != NEW.source
      OR OLD.song_id IS NOT NEW.song_id OR OLD.episode_id IS NOT NEW.episode_id OR OLD.skipped IS NOT NEW.skipped
      OR OLD.platform IS NOT NEW.platform OR OLD.country IS NOT NEW.country
      OR OLD.reason_start IS NOT NEW.reason_start OR OLD.reason_end IS NOT NEW.reason_end
      OR OLD.shuffle IS NOT NEW.shuffle OR OLD.offline IS NOT NEW.offline
      OR (OLD.dup_of IS NULL) != (NEW.dup_of IS NULL))
BEGIN
  INSERT INTO roll_log
    (listen_id, ts, ms_played, kind, source, song_id, episode_id, skipped, platform, country,
     reason_start, reason_end, shuffle, offline, counted)
  VALUES (OLD.id, OLD.ts, OLD.ms_played, OLD.kind, OLD.source, OLD.song_id, OLD.episode_id, OLD.skipped,
          OLD.platform, OLD.country, OLD.reason_start, OLD.reason_end, OLD.shuffle, OLD.offline,
          OLD.dup_of IS NULL)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_listen_delete AFTER DELETE ON listens
WHEN OLD.id <= (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key = 'roll_wm')
BEGIN
  INSERT INTO roll_log
    (listen_id, ts, ms_played, kind, source, song_id, episode_id, skipped, platform, country,
     reason_start, reason_end, shuffle, offline, counted)
  VALUES (OLD.id, OLD.ts, OLD.ms_played, OLD.kind, OLD.source, OLD.song_id, OLD.episode_id, OLD.skipped,
          OLD.platform, OLD.country, OLD.reason_start, OLD.reason_end, OLD.shuffle, OLD.offline,
          OLD.dup_of IS NULL)
  ON CONFLICT DO NOTHING;
  -- SQLite hands the largest ids out again once they are deleted; pull the
  -- watermark down so a row that reuses one still counts as new.
  UPDATE sync_state SET value = (SELECT COALESCE(MAX(id), 0) FROM listens)
   WHERE key = 'roll_wm' AND CAST(value AS INTEGER) > (SELECT COALESCE(MAX(id), 0) FROM listens);
END;

-- ---------------------------------------------------------------------------
-- Triggers: what a listen counts towards. Each records the previous mapping
-- the first time it changes after a fold, and only for songs/artists/episodes
-- the totals already include.
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_roll_ta_insert AFTER INSERT ON track_artists
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id = NEW.track_id AND p = 0)
BEGIN
  INSERT INTO roll_old_ta (track_id, artist_id)
    SELECT track_id, artist_id FROM track_artists
     WHERE track_id = NEW.track_id AND artist_id != NEW.artist_id
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'ta' AND key = NEW.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('ta', NEW.track_id), ('art', NEW.artist_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_ta_delete AFTER DELETE ON track_artists
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id = OLD.track_id AND p = 0)
BEGIN
  INSERT INTO roll_old_ta (track_id, artist_id)
    SELECT track_id, artist_id FROM track_artists
     WHERE track_id = OLD.track_id
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'ta' AND key = OLD.track_id)
    UNION ALL
    SELECT OLD.track_id, OLD.artist_id
     WHERE NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'ta' AND key = OLD.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('ta', OLD.track_id), ('art', OLD.artist_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_ta_update AFTER UPDATE OF track_id, artist_id ON track_artists
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id IN (OLD.track_id, NEW.track_id) AND p = 0)
BEGIN
  INSERT INTO roll_old_ta (track_id, artist_id)
    SELECT track_id, artist_id FROM track_artists
     WHERE track_id = OLD.track_id AND NOT (track_id = NEW.track_id AND artist_id = NEW.artist_id)
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'ta' AND key = OLD.track_id)
    UNION ALL
    SELECT OLD.track_id, OLD.artist_id
     WHERE NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'ta' AND key = OLD.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_old_ta (track_id, artist_id)
    SELECT track_id, artist_id FROM track_artists
     WHERE track_id = NEW.track_id AND NEW.track_id != OLD.track_id AND artist_id != NEW.artist_id
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'ta' AND key = NEW.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key)
  VALUES ('ta', OLD.track_id), ('ta', NEW.track_id), ('art', OLD.artist_id), ('art', NEW.artist_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_tg_insert AFTER INSERT ON track_genres
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id = NEW.track_id AND p = 0)
BEGIN
  INSERT INTO roll_old_tg (track_id, genre)
    SELECT track_id, genre FROM track_genres
     WHERE track_id = NEW.track_id AND genre != NEW.genre
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tg' AND key = NEW.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('tg', NEW.track_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_tg_delete AFTER DELETE ON track_genres
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id = OLD.track_id AND p = 0)
BEGIN
  INSERT INTO roll_old_tg (track_id, genre)
    SELECT track_id, genre FROM track_genres
     WHERE track_id = OLD.track_id
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tg' AND key = OLD.track_id)
    UNION ALL
    SELECT OLD.track_id, OLD.genre
     WHERE NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tg' AND key = OLD.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('tg', OLD.track_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_tags_insert AFTER INSERT ON artist_tags
WHEN EXISTS (SELECT 1 FROM roll_artists WHERE artist_id = NEW.artist_id AND p = 0)
BEGIN
  INSERT INTO roll_old_tags (artist_id, tag, votes)
    SELECT artist_id, tag, votes FROM artist_tags
     WHERE artist_id = NEW.artist_id AND tag != NEW.tag
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tags' AND key = NEW.artist_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('tags', NEW.artist_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_tags_update AFTER UPDATE ON artist_tags
WHEN EXISTS (SELECT 1 FROM roll_artists WHERE artist_id IN (OLD.artist_id, NEW.artist_id) AND p = 0)
 AND (OLD.artist_id != NEW.artist_id OR OLD.tag != NEW.tag OR OLD.votes != NEW.votes)
BEGIN
  INSERT INTO roll_old_tags (artist_id, tag, votes)
    SELECT artist_id, tag, votes FROM artist_tags
     WHERE artist_id = OLD.artist_id AND NOT (artist_id = NEW.artist_id AND tag = NEW.tag)
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tags' AND key = OLD.artist_id)
    UNION ALL
    SELECT OLD.artist_id, OLD.tag, OLD.votes
     WHERE NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tags' AND key = OLD.artist_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_old_tags (artist_id, tag, votes)
    SELECT artist_id, tag, votes FROM artist_tags
     WHERE artist_id = NEW.artist_id AND NEW.artist_id != OLD.artist_id AND tag != NEW.tag
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tags' AND key = NEW.artist_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('tags', OLD.artist_id), ('tags', NEW.artist_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_tags_delete AFTER DELETE ON artist_tags
WHEN EXISTS (SELECT 1 FROM roll_artists WHERE artist_id = OLD.artist_id AND p = 0)
BEGIN
  INSERT INTO roll_old_tags (artist_id, tag, votes)
    SELECT artist_id, tag, votes FROM artist_tags
     WHERE artist_id = OLD.artist_id
       AND NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tags' AND key = OLD.artist_id)
    UNION ALL
    SELECT OLD.artist_id, OLD.tag, OLD.votes
     WHERE NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'tags' AND key = OLD.artist_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('tags', OLD.artist_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_feat_insert AFTER INSERT ON audio_features
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id = NEW.track_id AND p = 0)
BEGIN
  INSERT INTO roll_dirty (kind, key) VALUES ('feat', NEW.track_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_feat_update AFTER UPDATE ON audio_features
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id = OLD.track_id AND p = 0)
 AND (OLD.track_id != NEW.track_id OR OLD.energy IS NOT NEW.energy OR OLD.valence IS NOT NEW.valence
      OR OLD.danceability IS NOT NEW.danceability OR OLD.acousticness IS NOT NEW.acousticness
      OR OLD.instrumentalness IS NOT NEW.instrumentalness OR OLD.speechiness IS NOT NEW.speechiness
      OR OLD.liveness IS NOT NEW.liveness OR OLD.tempo IS NOT NEW.tempo OR OLD.loudness IS NOT NEW.loudness)
BEGIN
  INSERT INTO roll_old_feat
    (track_id, energy, valence, danceability, acousticness, instrumentalness, speechiness, liveness, tempo, loudness)
    SELECT OLD.track_id, OLD.energy, OLD.valence, OLD.danceability, OLD.acousticness, OLD.instrumentalness,
           OLD.speechiness, OLD.liveness, OLD.tempo, OLD.loudness
     WHERE NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'feat' AND key = OLD.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('feat', OLD.track_id), ('feat', NEW.track_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_feat_delete AFTER DELETE ON audio_features
WHEN EXISTS (SELECT 1 FROM roll_songs WHERE song_id = OLD.track_id AND p = 0)
BEGIN
  INSERT INTO roll_old_feat
    (track_id, energy, valence, danceability, acousticness, instrumentalness, speechiness, liveness, tempo, loudness)
    SELECT OLD.track_id, OLD.energy, OLD.valence, OLD.danceability, OLD.acousticness, OLD.instrumentalness,
           OLD.speechiness, OLD.liveness, OLD.tempo, OLD.loudness
     WHERE NOT EXISTS (SELECT 1 FROM roll_dirty WHERE kind = 'feat' AND key = OLD.track_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO roll_dirty (kind, key) VALUES ('feat', OLD.track_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_track_insert AFTER INSERT ON tracks
WHEN NEW.album_id IS NOT NULL AND EXISTS (SELECT 1 FROM roll_songs WHERE song_id = NEW.id AND p = 0)
BEGIN
  INSERT INTO roll_dirty (kind, key) VALUES ('alb', NEW.album_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_track_album AFTER UPDATE OF album_id ON tracks
WHEN OLD.album_id IS NOT NEW.album_id AND EXISTS (SELECT 1 FROM roll_songs WHERE song_id = NEW.id AND p = 0)
BEGIN
  INSERT INTO roll_dirty (kind, key)
    SELECT 'alb', OLD.album_id WHERE OLD.album_id IS NOT NULL
    UNION ALL SELECT 'alb', NEW.album_id WHERE NEW.album_id IS NOT NULL
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_episode_insert AFTER INSERT ON episodes
WHEN NEW.show_id IS NOT NULL AND EXISTS (SELECT 1 FROM roll_episodes WHERE episode_id = NEW.id AND p = 0)
BEGIN
  INSERT INTO roll_dirty (kind, key) VALUES ('show', NEW.show_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_roll_episode_show AFTER UPDATE OF show_id ON episodes
WHEN OLD.show_id IS NOT NEW.show_id AND EXISTS (SELECT 1 FROM roll_episodes WHERE episode_id = NEW.id AND p = 0)
BEGIN
  INSERT INTO roll_dirty (kind, key)
    SELECT 'show', OLD.show_id WHERE OLD.show_id IS NOT NULL
    UNION ALL SELECT 'show', NEW.show_id WHERE NEW.show_id IS NOT NULL
  ON CONFLICT DO NOTHING;
END;

-- ---------------------------------------------------------------------------
-- Triggers: counts derived from the totals themselves
-- ---------------------------------------------------------------------------

-- Distinct songs / artists / albums per period, and discoveries per day.
CREATE TRIGGER trg_roll_songs_insert AFTER INSERT ON roll_songs
BEGIN
  INSERT INTO roll_facts (p, k, n) VALUES (NEW.p, 'songs', 1) ON CONFLICT (p, k) DO UPDATE SET n = n + 1;
  INSERT INTO roll_days (day, new_songs) SELECT NEW.first_day, 1 WHERE NEW.p = 0
  ON CONFLICT (day) DO UPDATE SET new_songs = new_songs + 1;
END;

CREATE TRIGGER trg_roll_songs_delete AFTER DELETE ON roll_songs
BEGIN
  UPDATE roll_facts SET n = n - 1 WHERE p = OLD.p AND k = 'songs';
  UPDATE roll_days SET new_songs = new_songs - 1 WHERE day = OLD.first_day AND OLD.p = 0;
END;

CREATE TRIGGER trg_roll_songs_first AFTER UPDATE OF first_day ON roll_songs
WHEN NEW.p = 0 AND OLD.first_day != NEW.first_day
BEGIN
  UPDATE roll_days SET new_songs = new_songs - 1 WHERE day = OLD.first_day;
  INSERT INTO roll_days (day, new_songs) VALUES (NEW.first_day, 1)
  ON CONFLICT (day) DO UPDATE SET new_songs = new_songs + 1;
END;

CREATE TRIGGER trg_roll_artists_insert AFTER INSERT ON roll_artists
BEGIN
  INSERT INTO roll_facts (p, k, n) VALUES (NEW.p, 'artists', 1) ON CONFLICT (p, k) DO UPDATE SET n = n + 1;
  INSERT INTO roll_days (day, new_artists) SELECT NEW.first_day, 1 WHERE NEW.p = 0
  ON CONFLICT (day) DO UPDATE SET new_artists = new_artists + 1;
END;

CREATE TRIGGER trg_roll_artists_delete AFTER DELETE ON roll_artists
BEGIN
  UPDATE roll_facts SET n = n - 1 WHERE p = OLD.p AND k = 'artists';
  UPDATE roll_days SET new_artists = new_artists - 1 WHERE day = OLD.first_day AND OLD.p = 0;
END;

CREATE TRIGGER trg_roll_artists_first AFTER UPDATE OF first_day ON roll_artists
WHEN NEW.p = 0 AND OLD.first_day != NEW.first_day
BEGIN
  UPDATE roll_days SET new_artists = new_artists - 1 WHERE day = OLD.first_day;
  INSERT INTO roll_days (day, new_artists) VALUES (NEW.first_day, 1)
  ON CONFLICT (day) DO UPDATE SET new_artists = new_artists + 1;
END;

CREATE TRIGGER trg_roll_albums_insert AFTER INSERT ON roll_albums
BEGIN
  INSERT INTO roll_facts (p, k, n) VALUES (NEW.p, 'albums', 1) ON CONFLICT (p, k) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER trg_roll_albums_delete AFTER DELETE ON roll_albums
BEGIN
  UPDATE roll_facts SET n = n - 1 WHERE p = OLD.p AND k = 'albums';
END;

-- Distinct artists behind each genre.
CREATE TRIGGER trg_roll_garts_insert AFTER INSERT ON roll_garts
BEGIN
  INSERT INTO roll_facts (p, k, n) VALUES (NEW.p, 'gac:' || NEW.src || ':' || NEW.genre, 1)
  ON CONFLICT (p, k) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER trg_roll_garts_delete AFTER DELETE ON roll_garts
BEGIN
  UPDATE roll_facts SET n = n - 1 WHERE p = OLD.p AND k = 'gac:' || OLD.src || ':' || OLD.genre;
END;

-- Active days per period.
CREATE TRIGGER trg_roll_days_insert AFTER INSERT ON roll_days
WHEN NEW.streams > 0
BEGIN
  INSERT INTO roll_facts (p, k, n) VALUES (0, 'days', 1), (CAST(substr(NEW.day, 1, 4) AS INTEGER), 'days', 1)
  ON CONFLICT (p, k) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER trg_roll_days_update AFTER UPDATE OF streams ON roll_days
WHEN (OLD.streams > 0) != (NEW.streams > 0)
BEGIN
  INSERT INTO roll_facts (p, k, n)
  VALUES (0, 'days', CASE WHEN NEW.streams > 0 THEN 1 ELSE -1 END),
         (CAST(substr(NEW.day, 1, 4) AS INTEGER), 'days', CASE WHEN NEW.streams > 0 THEN 1 ELSE -1 END)
  ON CONFLICT (p, k) DO UPDATE SET n = n + excluded.n;
END;

CREATE TRIGGER trg_roll_days_delete AFTER DELETE ON roll_days
WHEN OLD.streams > 0
BEGIN
  UPDATE roll_facts SET n = n - 1 WHERE k = 'days' AND p IN (0, CAST(substr(OLD.day, 1, 4) AS INTEGER));
END;

-- Session count and total per period.
CREATE TRIGGER trg_roll_sessions_insert AFTER INSERT ON roll_sessions
BEGIN
  INSERT INTO roll_facts (p, k, ms, n) VALUES (0, 'ss', NEW.ms, 1), (NEW.p, 'ss', NEW.ms, 1)
  ON CONFLICT (p, k) DO UPDATE SET ms = ms + excluded.ms, n = n + 1;
END;

CREATE TRIGGER trg_roll_sessions_update AFTER UPDATE ON roll_sessions
BEGIN
  UPDATE roll_facts SET ms = ms - OLD.ms, n = n - 1 WHERE k = 'ss' AND p IN (0, OLD.p);
  INSERT INTO roll_facts (p, k, ms, n) VALUES (0, 'ss', NEW.ms, 1), (NEW.p, 'ss', NEW.ms, 1)
  ON CONFLICT (p, k) DO UPDATE SET ms = ms + excluded.ms, n = n + 1;
END;

CREATE TRIGGER trg_roll_sessions_delete AFTER DELETE ON roll_sessions
BEGIN
  UPDATE roll_facts SET ms = ms - OLD.ms, n = n - 1 WHERE k = 'ss' AND p IN (0, OLD.p);
END;
