import type {
  Env,
  FullArtist,
  PlaybackState,
  PlayHistoryItem,
  SimplifiedAlbum,
  SimplifiedArtist,
  SpotifyEpisode,
  SpotifyImage,
  SpotifyTrack,
} from "./types";

import { fnv1aHex, normName, trackNameKey } from "../shared/normalize";

export { fnv1aHex };

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/ingest.test.ts — no D1 required)
// ---------------------------------------------------------------------------

/**
 * Tracks the user added from local files have `id: null`. Rather than drop them
 * (losing real listening data) we mint a deterministic id from their metadata so
 * the same local file always maps to the same row.
 */
export function trackKey(track: SpotifyTrack): string | null {
  if (track.id) return track.id;
  if (!track.name) return null;
  const artist = (track.artists ?? []).map((a) => a.name).join("/");
  return `local:${fnv1aHex(`${track.name}|${artist}|${track.duration_ms ?? 0}`)}`;
}

export function episodeKey(episode: SpotifyEpisode): string | null {
  if (episode.id) return episode.id;
  if (!episode.name) return null;
  return `local:${fnv1aHex(`${episode.name}|${episode.duration_ms ?? 0}`)}`;
}

/** Spotify's `played_at` is ISO-8601; we key plays on unix ms. */
export function parsePlayedAt(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** `release_date` precision varies (2021 / 2021-03 / 2021-03-04); take the year. */
export function releaseYear(releaseDate: string | undefined | null): number | null {
  if (!releaseDate) return null;
  const m = /^(\d{4})/.exec(releaseDate);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/** Largest available image, which is the first entry in Spotify's arrays. */
export function pickImage(images: SpotifyImage[] | undefined): string | null {
  return images?.[0]?.url ?? null;
}

export function boolInt(value: boolean | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

export interface LastSample {
  sampled_at: number;
  item_type: string | null;
  track_id: string | null;
  episode_id: string | null;
  item_name: string | null;
  progress_ms: number | null;
  is_playing: number;
  device_id: string | null;
  context_uri: string | null;
}

export interface SampleCandidate {
  sampled_at: number;
  item_type: string;
  item_id: string | null;
  item_name: string | null;
  progress_ms: number | null;
  is_playing: boolean;
  device_id: string | null;
  context_uri: string | null;
}

/** Write a heartbeat sample at most this often while playback is unchanged. */
export const SAMPLE_HEARTBEAT_MS = 5 * 60 * 1000;

/** Progress drift beyond this means the user seeked or restarted the track. */
export const SEEK_TOLERANCE_MS = 30_000;

/**
 * Decides whether a player poll is worth a row. Idle minutes and mid-track
 * minutes are dropped, so a day of not listening costs zero writes while every
 * actual transition is still captured.
 */
export function sampleChanged(
  prev: LastSample | null,
  next: SampleCandidate,
  heartbeatMs = SAMPLE_HEARTBEAT_MS,
): { changed: boolean; reason: string } {
  if (!prev) return { changed: true, reason: "first-sample" };

  const prevId = prev.track_id ?? prev.episode_id ?? prev.item_name;
  const nextId = next.item_id ?? next.item_name;
  if (prevId !== nextId) return { changed: true, reason: "item-changed" };
  if ((prev.is_playing === 1) !== next.is_playing) return { changed: true, reason: "play-state-changed" };
  if ((prev.device_id ?? null) !== next.device_id) return { changed: true, reason: "device-changed" };
  if ((prev.context_uri ?? null) !== next.context_uri) return { changed: true, reason: "context-changed" };

  if (next.is_playing && prev.progress_ms !== null && next.progress_ms !== null) {
    const elapsed = next.sampled_at - prev.sampled_at;
    const expected = prev.progress_ms + elapsed;
    if (Math.abs(next.progress_ms - expected) > SEEK_TOLERANCE_MS) {
      return { changed: true, reason: "seek-detected" };
    }
  }

  if (next.is_playing && next.sampled_at - prev.sampled_at >= heartbeatMs) {
    return { changed: true, reason: "heartbeat" };
  }

  return { changed: false, reason: "unchanged" };
}

// ---------------------------------------------------------------------------
// Statement builders
// ---------------------------------------------------------------------------

/**
 * The `DO UPDATE` half of an upsert that leaves an unchanged row alone. D1
 * bills every rewritten row and index entry, and the collectors send the same
 * track, album and artists again every few minutes while something plays
 * (a re-sent track used to cost ~25 row writes; unchanged it now costs none).
 * `sets` are compared; `also` are written with them but never count as a
 * change on their own; `orWhen` forces the update.
 */
export function updateIfChanged(table: string, sets: Record<string, string>, also: Record<string, string> = {}, orWhen?: string): string {
  const assign = Object.entries({ ...sets, ...also }).map(([col, expr]) => `${col} = ${expr}`);
  const changed = Object.entries(sets).map(([col, expr]) => `${table}.${col} IS NOT ${expr}`);
  if (orWhen) changed.push(orWhen);
  return `DO UPDATE SET ${assign.join(", ")} WHERE ${changed.join(" OR ")}`;
}

/** last_seen_at is informational: refresh it at most daily. */
const DAILY = (table: string) => `${table}.last_seen_at IS NULL OR ${table}.last_seen_at < excluded.last_seen_at - 86400000`;

/**
 * Upsert an artist stub. `enriched_at` is deliberately left untouched so the
 * hourly enrichment pass still picks up artists first seen as track stubs.
 */
function artistStub(env: Env, artist: SimplifiedArtist, now: number): D1PreparedStatement | null {
  if (!artist.id) return null;
  return env.DB.prepare(
    `INSERT INTO artists (id, name, uri, name_key, first_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) ${updateIfChanged("artists", {
       name: "excluded.name",
       uri: "COALESCE(excluded.uri, artists.uri)",
       name_key: "excluded.name_key",
     })}`,
  ).bind(artist.id, artist.name ?? "", artist.uri ?? null, normName(artist.name), now);
}

function albumStub(env: Env, album: SimplifiedAlbum, now: number): D1PreparedStatement | null {
  if (!album.id) return null;
  return env.DB.prepare(
    `INSERT INTO albums (id, name, uri, album_type, release_date, release_date_precision,
                         release_year, total_tracks, image_url, name_key, first_seen_at, enriched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) ${updateIfChanged("albums", {
       name: "excluded.name",
       uri: "COALESCE(excluded.uri, albums.uri)",
       image_url: "COALESCE(excluded.image_url, albums.image_url)",
       album_type: "COALESCE(excluded.album_type, albums.album_type)",
       release_date: "COALESCE(excluded.release_date, albums.release_date)",
       release_date_precision: "COALESCE(excluded.release_date_precision, albums.release_date_precision)",
       release_year: "COALESCE(excluded.release_year, albums.release_year)",
       total_tracks: "COALESCE(excluded.total_tracks, albums.total_tracks)",
       name_key: "excluded.name_key",
     })}`,
  ).bind(
    album.id,
    album.name ?? "",
    album.uri ?? null,
    album.album_type ?? null,
    album.release_date ?? null,
    album.release_date_precision ?? null,
    releaseYear(album.release_date),
    album.total_tracks ?? null,
    pickImage(album.images),
    normName(album.name),
    now,
    now,
  );
}

/**
 * Every statement needed to record a track and its relationships, in
 * foreign-key-safe order: artists, album, album_artists, track, track_artists.
 */
export function trackStatements(env: Env, track: SpotifyTrack, now: number): D1PreparedStatement[] {
  const id = trackKey(track);
  if (!id) return [];

  const statements: D1PreparedStatement[] = [];
  const album = track.album;
  const trackArtists = track.artists ?? [];
  const albumArtists = album?.artists ?? [];

  for (const artist of [...trackArtists, ...albumArtists]) {
    const stmt = artistStub(env, artist, now);
    if (stmt) statements.push(stmt);
  }

  if (album?.id) {
    const stmt = albumStub(env, album, now);
    if (stmt) statements.push(stmt);
    albumArtists.forEach((artist, position) => {
      if (!artist.id) return;
      statements.push(
        env.DB.prepare(
          `INSERT INTO album_artists (album_id, artist_id, position) VALUES (?, ?, ?)
           ON CONFLICT(album_id, artist_id) ${updateIfChanged("album_artists", { position: "excluded.position" })}`,
        ).bind(album.id, artist.id, position),
      );
    });
  }

  // A full track object is the metadata lookup's result too: mark it done so
  // the enrichment pump doesn't fetch it again. Local files can't be looked up.
  const isLocal = Boolean(track.is_local || !track.id);
  statements.push(
    env.DB.prepare(
      `INSERT INTO tracks (id, name, uri, album_id, duration_ms, explicit, popularity,
                           track_number, disc_number, isrc, is_local, raw, name_key,
                           meta_status, enriched_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) ${updateIfChanged(
         "tracks",
         {
           name: "excluded.name",
           uri: "COALESCE(excluded.uri, tracks.uri)",
           album_id: "COALESCE(excluded.album_id, tracks.album_id)",
           duration_ms: "COALESCE(excluded.duration_ms, tracks.duration_ms)",
           explicit: "COALESCE(excluded.explicit, tracks.explicit)",
           popularity: "COALESCE(excluded.popularity, tracks.popularity)",
           track_number: "COALESCE(excluded.track_number, tracks.track_number)",
           disc_number: "COALESCE(excluded.disc_number, tracks.disc_number)",
           isrc: "COALESCE(excluded.isrc, tracks.isrc)",
           name_key: "excluded.name_key",
           meta_status: "excluded.meta_status",
           enriched_at: "COALESCE(tracks.enriched_at, excluded.enriched_at)",
         },
         // The JSON differs between endpoints for the same track, so it only
         // comes along with a real change.
         { raw: "COALESCE(excluded.raw, tracks.raw)", last_seen_at: "excluded.last_seen_at" },
         DAILY("tracks"),
       )}`,
    ).bind(
      id,
      track.name ?? "",
      track.uri ?? null,
      album?.id ?? null,
      track.duration_ms ?? null,
      boolInt(track.explicit),
      track.popularity ?? null,
      track.track_number ?? null,
      track.disc_number ?? null,
      track.external_ids?.isrc ?? null,
      isLocal ? 1 : 0,
      JSON.stringify(track),
      trackNameKey(track.name, trackArtists[0]?.name),
      isLocal ? "missing" : "ok",
      now,
      now,
      now,
    ),
  );

  // An import may have filed this track under a name-only artist stub; the real
  // credits below replace it.
  if (trackArtists.some((a) => a.id)) {
    statements.push(
      env.DB.prepare("DELETE FROM track_artists WHERE track_id = ? AND artist_id LIKE 'name:%'").bind(id),
    );
  }

  trackArtists.forEach((artist, position) => {
    if (!artist.id) return;
    statements.push(
      env.DB.prepare(
        `INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)
         ON CONFLICT(track_id, artist_id) ${updateIfChanged("track_artists", { position: "excluded.position" })}`,
      ).bind(id, artist.id, position),
    );
  });

  return statements;
}

export function episodeStatements(env: Env, episode: SpotifyEpisode, now: number): D1PreparedStatement[] {
  const id = episodeKey(episode);
  if (!id) return [];

  const statements: D1PreparedStatement[] = [];
  const show = episode.show;

  if (show?.id) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO shows (id, name, uri, publisher, image_url, raw, name_key, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) ${updateIfChanged("shows", {
           name: "excluded.name",
           publisher: "COALESCE(excluded.publisher, shows.publisher)",
           image_url: "COALESCE(excluded.image_url, shows.image_url)",
           name_key: "excluded.name_key",
         })}`,
      ).bind(show.id, show.name ?? "", show.uri ?? null, show.publisher ?? null, pickImage(show.images), JSON.stringify(show), normName(show.name), now),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO episodes (id, name, uri, show_id, duration_ms, release_date, explicit,
                             description, image_url, raw, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) ${updateIfChanged(
         "episodes",
         {
           name: "excluded.name",
           show_id: "COALESCE(excluded.show_id, episodes.show_id)",
           duration_ms: "COALESCE(excluded.duration_ms, episodes.duration_ms)",
         },
         { raw: "COALESCE(excluded.raw, episodes.raw)", last_seen_at: "excluded.last_seen_at" },
         DAILY("episodes"),
       )}`,
    ).bind(
      id,
      episode.name ?? "",
      episode.uri ?? null,
      show?.id ?? null,
      episode.duration_ms ?? null,
      episode.release_date ?? null,
      boolInt(episode.explicit),
      episode.description ? episode.description.slice(0, 2000) : null,
      pickImage(episode.images),
      JSON.stringify(episode),
      now,
      now,
    ),
  );

  return statements;
}

/**
 * Statements for one page of recently-played items. `INSERT OR IGNORE` on the
 * played_at primary key is what makes re-polling an overlapping window free of
 * duplicates, so overlapping crons and cron retries are both safe.
 */
export function playStatements(env: Env, items: PlayHistoryItem[], now: number): { statements: D1PreparedStatement[]; maxPlayedAt: number | null } {
  const statements: D1PreparedStatement[] = [];
  let maxPlayedAt: number | null = null;

  for (const item of items) {
    const playedAt = parsePlayedAt(item.played_at);
    const id = item.track ? trackKey(item.track) : null;
    if (playedAt === null || !id) continue;

    statements.push(...trackStatements(env, item.track, now));
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO plays
           (played_at, played_at_iso, track_id, duration_ms, context_type, context_uri, source, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, 'recently_played', ?)`,
      ).bind(
        playedAt,
        new Date(playedAt).toISOString(),
        id,
        item.track.duration_ms ?? null,
        item.context?.type ?? null,
        item.context?.uri ?? null,
        now,
      ),
    );

    if (maxPlayedAt === null || playedAt > maxPlayedAt) maxPlayedAt = playedAt;
  }

  return { statements, maxPlayedAt };
}

/** Turn a /me/player response into the shape sampleChanged() compares. */
export function toSampleCandidate(state: PlaybackState | null, sampledAt: number): SampleCandidate {
  if (!state || !state.item) {
    return {
      sampled_at: sampledAt,
      item_type: state ? (state.currently_playing_type ?? "unknown") : "none",
      item_id: null,
      item_name: null,
      progress_ms: null,
      is_playing: Boolean(state?.is_playing),
      device_id: state?.device?.id ?? null,
      context_uri: state?.context?.uri ?? null,
    };
  }

  const isEpisode = state.currently_playing_type === "episode" || state.item.type === "episode";
  const id = isEpisode ? episodeKey(state.item as SpotifyEpisode) : trackKey(state.item as SpotifyTrack);

  return {
    sampled_at: sampledAt,
    item_type: isEpisode ? "episode" : (state.currently_playing_type ?? "track"),
    item_id: id,
    item_name: state.item.name ?? null,
    progress_ms: state.progress_ms ?? null,
    is_playing: Boolean(state.is_playing),
    device_id: state.device?.id ?? null,
    context_uri: state.context?.uri ?? null,
  };
}

export function sampleStatements(
  env: Env,
  state: PlaybackState | null,
  candidate: SampleCandidate,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const isEpisode = candidate.item_type === "episode";

  // Entity rows must exist before the sample's foreign keys point at them.
  if (state?.item && candidate.item_id) {
    statements.push(
      ...(isEpisode
        ? episodeStatements(env, state.item as SpotifyEpisode, candidate.sampled_at)
        : trackStatements(env, state.item as SpotifyTrack, candidate.sampled_at)),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO playback_samples
         (sampled_at, spotify_timestamp, item_type, track_id, episode_id, item_name, progress_ms,
          duration_ms, is_playing, device_id, device_name, device_type, volume_percent,
          shuffle_state, repeat_state, context_type, context_uri)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      candidate.sampled_at,
      state?.timestamp ?? null,
      candidate.item_type,
      isEpisode ? null : candidate.item_id,
      isEpisode ? candidate.item_id : null,
      candidate.item_name,
      candidate.progress_ms,
      state?.item?.duration_ms ?? null,
      candidate.is_playing ? 1 : 0,
      candidate.device_id,
      state?.device?.name ?? null,
      state?.device?.type ?? null,
      state?.device?.volume_percent ?? null,
      boolInt(state?.shuffle_state),
      state?.repeat_state ?? null,
      state?.context?.type ?? null,
      candidate.context_uri,
    ),
  );

  return statements;
}

/**
 * Upsert a full artist object (single /artists/{id}, or /me/top/artists).
 * Dev-mode apps get no genres/popularity/followers; those stay as stored.
 * enriched_at keeps the first lookup's time (only "is it set" matters), so a
 * daily top-list snapshot doesn't rewrite 150 unchanged artists.
 */
export function artistEnrichmentStatement(env: Env, artist: FullArtist, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO artists (id, name, uri, genres, popularity, followers, image_url, raw, name_key, first_seen_at, enriched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) ${updateIfChanged(
       "artists",
       {
         name: "excluded.name",
         uri: "COALESCE(excluded.uri, artists.uri)",
         genres: "COALESCE(excluded.genres, artists.genres)",
         popularity: "COALESCE(excluded.popularity, artists.popularity)",
         followers: "COALESCE(excluded.followers, artists.followers)",
         image_url: "COALESCE(excluded.image_url, artists.image_url)",
         name_key: "excluded.name_key",
         enriched_at: "COALESCE(artists.enriched_at, excluded.enriched_at)",
       },
       { raw: "excluded.raw" },
     )}`,
  ).bind(
    artist.id,
    artist.name ?? "",
    artist.uri ?? null,
    artist.genres?.length ? JSON.stringify(artist.genres) : null,
    artist.popularity ?? null,
    artist.followers?.total ?? null,
    pickImage(artist.images),
    JSON.stringify(artist),
    normName(artist.name),
    now,
    now,
  );
}
