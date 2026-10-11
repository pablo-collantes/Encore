-- When the hourly cleanup has names to match.
--
-- Matching names (src/worker/cleanup.ts: name-only listens -> real tracks,
-- name-only artists and shows -> real ones, dropping stubs nothing uses) can
-- only find something after one of the changes below. On 2026-10-07 it read
-- ~220k rows every hour to find nothing. These triggers set the
-- 'names_recheck' flag (STATE_NAMES_RECHECK) and the hourly run matches only
-- when it's set. The matching clears it in the same transaction, so the
-- changes the matching itself makes don't call for another run.
--
-- Upserts that change nothing (the collectors re-send the same track every few
-- minutes) fire no UPDATE trigger, an INSERT OR IGNORE that ignores fires no
-- INSERT trigger, and setting the flag when it's already set writes nothing.
-- (Not INSERT OR IGNORE: an upsert that takes its DO UPDATE path imposes its
-- own conflict policy on the body of the trigger it fires, and the IGNORE is lost.)
--
-- Not watched, because only the matching does them: deleting stubs, re-pointing
-- credits at a real artist. Imports and deleting one also run the matching
-- themselves (a scoped cleanup).

CREATE TRIGGER trg_names_track_insert AFTER INSERT ON tracks
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_track_update AFTER UPDATE OF name_key, album_id ON tracks
WHEN OLD.name_key IS NOT NEW.name_key OR OLD.album_id IS NOT NEW.album_id
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_artist_insert AFTER INSERT ON artists
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_artist_update AFTER UPDATE OF name_key ON artists
WHEN OLD.name_key IS NOT NEW.name_key
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

-- A stub album arrives orphaned when an import names it for a track that's already known.
CREATE TRIGGER trg_names_album_insert AFTER INSERT ON albums
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_show_insert AFTER INSERT ON shows
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_show_update AFTER UPDATE OF name_key ON shows
WHEN OLD.name_key IS NOT NEW.name_key
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_episode_insert AFTER INSERT ON episodes
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_episode_update AFTER UPDATE OF show_id ON episodes
WHEN OLD.show_id IS NOT NEW.show_id
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_track_artist_insert AFTER INSERT ON track_artists
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

-- The metadata lookup drops a track's name-only credits, which can leave the stub artist unused.
CREATE TRIGGER trg_names_track_artist_delete AFTER DELETE ON track_artists
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_album_artist_insert AFTER INSERT ON album_artists
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_album_artist_delete AFTER DELETE ON album_artists
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_listen_insert AFTER INSERT ON listens
WHEN NEW.track_id >= 'name:' AND NEW.track_id < 'name;'
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

CREATE TRIGGER trg_names_listen_delete AFTER DELETE ON listens
WHEN OLD.track_id >= 'name:' AND OLD.track_id < 'name;'
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;

-- The name-only search files a stub's listens under the track it found, leaving the stub unused.
CREATE TRIGGER trg_names_listen_update AFTER UPDATE OF track_id ON listens
WHEN OLD.track_id IS NOT NEW.track_id
BEGIN
  INSERT INTO sync_state (key, value, updated_at)
  SELECT 'names_recheck', '1', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'names_recheck');
END;
