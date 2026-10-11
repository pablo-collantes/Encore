-- The enrichment pump's queues, each indexed by exactly what its lane takes.
--
-- A queue index that also holds rows its lane skips is walked to the end every
-- minute the queue is empty. On 2026-10-07 the Deezer lane read all 18,616
-- tracks still waiting for Spotify metadata, every minute, to return none;
-- preview analysis walked 4k tracks still waiting for Deezer, and the artist
-- image and MusicBrainz lanes 5.4k name-only artists each.
--
-- With each WHERE equal to its lane's (QUEUES in src/worker/enrich/pump.ts),
-- taking the next items, or asking whether there are any, reads only rows that
-- qualify: none when the queue is empty.

DROP INDEX idx_tracks_deezer_queue;
CREATE INDEX idx_tracks_deezer_queue ON tracks (priority DESC)
  WHERE deezer_status IS NULL AND meta_status = 'ok';

-- Was (features_status, priority DESC): SQLite preferred seeking it on
-- 'pending_analysis' to the analysis queue below, and walked every track
-- waiting for Deezer again. Only the features lane reads it now.
DROP INDEX idx_tracks_features_queue;
CREATE INDEX idx_tracks_features_queue ON tracks (priority DESC)
  WHERE features_status IS NULL;

CREATE INDEX idx_tracks_analysis_queue ON tracks (priority DESC)
  WHERE features_status = 'pending_analysis' AND deezer_status IN ('ok', 'missing');

DROP INDEX idx_artists_enrich_queue;
CREATE INDEX idx_artists_enrich_queue ON artists (priority DESC)
  WHERE enriched_at IS NULL AND NOT (id >= 'name:' AND id < 'name;') AND id NOT LIKE 'local:%';

DROP INDEX idx_artists_mb_queue;
CREATE INDEX idx_artists_mb_queue ON artists (priority DESC)
  WHERE mb_status IS NULL AND NOT (id >= 'name:' AND id < 'name;') AND id NOT LIKE 'local:%';
