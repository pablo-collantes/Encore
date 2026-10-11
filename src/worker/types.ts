export interface Env {
  DB: D1Database;
  /** The built web app (vite build -> dist/client), served by the assets binding. */
  ASSETS: Fetcher;
  /** Native rate limiters (wrangler.jsonc `ratelimits`). Absent in some local runtimes. */
  RL_AUTH?: RateLimit;
  RL_API?: RateLimit;
  /** This Worker, through its fetch handler, so the call runs at the placement region. */
  SELF?: Fetcher;
  /** Cloudflare Email Sending (invites, password resets). Absent in some local runtimes. */
  EMAIL?: SendEmail;
  /** Workers KV: cached dashboard answers (src/worker/lib/cache.ts). Absent in unit tests. */
  CACHE?: KVNamespace;
  /** This deploy's version id; cache keys start with it. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;

  // Secrets (wrangler secret put / .dev.vars)
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  API_KEY: string;
  STATE_SECRET: string;

  // Vars (wrangler.jsonc)
  SPOTIFY_REDIRECT_URI: string;
  ENVIRONMENT: string;
  API_LOG_RETENTION_DAYS: string;
  /** IANA zone of the stored All time / yearly totals (src/worker/stats/rollup.ts). */
  STATS_TZ?: string;
  APP_NAME: string;
  /** Fallback base for emailed links; normally they use the request's own origin. */
  APP_URL: string;
  EMAIL_FROM: string;

  /** Optional override of the Spotify API base, for pointing at a local mock. */
  SPOTIFY_API_BASE?: string;
}

// --- Spotify API shapes (only the fields we actually read) -------------------

export interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

export interface SimplifiedArtist {
  id: string | null;
  name: string;
  uri?: string;
  type?: string;
}

export interface FullArtist extends SimplifiedArtist {
  id: string;
  genres?: string[];
  popularity?: number;
  followers?: { total: number | null };
  images?: SpotifyImage[];
}

export interface SimplifiedAlbum {
  id: string | null;
  name: string;
  uri?: string;
  album_type?: string;
  release_date?: string;
  release_date_precision?: string;
  total_tracks?: number;
  images?: SpotifyImage[];
  artists?: SimplifiedArtist[];
}

export interface FullAlbum extends SimplifiedAlbum {
  id: string;
  label?: string;
  popularity?: number;
  genres?: string[];
}

export interface SpotifyTrack {
  id: string | null;
  /** Present when Spotify relinked the requested track to a playable one. */
  linked_from?: { id: string | null };
  name: string;
  uri?: string;
  album?: SimplifiedAlbum;
  artists?: SimplifiedArtist[];
  duration_ms?: number;
  explicit?: boolean;
  popularity?: number;
  track_number?: number;
  disc_number?: number;
  external_ids?: { isrc?: string };
  is_local?: boolean;
  type?: string;
}

export interface SpotifyShow {
  id: string;
  name: string;
  uri?: string;
  publisher?: string;
  images?: SpotifyImage[];
}

export interface SpotifyEpisode {
  id: string | null;
  name: string;
  uri?: string;
  show?: SpotifyShow;
  duration_ms?: number;
  release_date?: string;
  explicit?: boolean;
  description?: string;
  images?: SpotifyImage[];
  type?: string;
}

export interface PlaybackContext {
  type?: string;
  uri?: string;
}

export interface PlayHistoryItem {
  track: SpotifyTrack;
  played_at: string;
  context: PlaybackContext | null;
}

export interface RecentlyPlayedResponse {
  items: PlayHistoryItem[];
  next: string | null;
  cursors: { after?: string; before?: string } | null;
  limit: number;
}

export interface PlaybackState {
  device?: {
    id: string | null;
    name?: string;
    type?: string;
    volume_percent?: number | null;
    is_active?: boolean;
  } | null;
  repeat_state?: string;
  shuffle_state?: boolean;
  context?: PlaybackContext | null;
  timestamp?: number;
  progress_ms?: number | null;
  is_playing?: boolean;
  item?: SpotifyTrack | SpotifyEpisode | null;
  currently_playing_type?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface AuthRow {
  id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  spotify_user_id: string | null;
  display_name: string | null;
  image_url: string | null;
  authorized_at: number;
  last_refreshed_at: number | null;
  refresh_count: number;
  updated_at: number;
}

/** A single entry from Spotify's "Extended Streaming History" GDPR export. */
export interface StreamingHistoryEntry {
  ts?: string;
  ms_played?: number;
  master_metadata_track_name?: string | null;
  master_metadata_album_artist_name?: string | null;
  master_metadata_album_album_name?: string | null;
  spotify_track_uri?: string | null;
  episode_name?: string | null;
  episode_show_name?: string | null;
  spotify_episode_uri?: string | null;
  reason_start?: string | null;
  reason_end?: string | null;
  skipped?: boolean | null;
  shuffle?: boolean | null;
  offline?: boolean | null;
  platform?: string | null;
  conn_country?: string | null;
}

export type TopTimeRange = "short_term" | "medium_term" | "long_term";

export interface Paging<T> {
  items: T[];
  next: string | null;
  total?: number;
}
