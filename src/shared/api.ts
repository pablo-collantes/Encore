// Response shapes of the dashboard API (/api/*). The Worker builds these and
// the web app consumes them, so this file is the contract between the two.
//
// Conventions:
//   * Timestamps are unix milliseconds (UTC). Durations are milliseconds.
//   * Range queries take `from` (inclusive) and `to` (exclusive) as unix ms, and
//     `tz` as an IANA zone name ("Europe/Madrid"); buckets/clock/day counts are
//     computed in that zone, DST included.
//   * "streams" = every listening event, including skips; "plays" = streams of
//     30 s or more (Spotify's own definition of a play). Minutes always use the
//     real ms_played where Spotify gave it, and the track length for live
//     plays (`msEstimated`), which are only reported once >30 s were played.
//   * Lists take `limit` and `offset` and return `total`.

import type { ListenKind } from "./exportFormats";

export type Bucket = "day" | "week" | "month" | "year";
export type GenreSource = "deezer" | "musicbrainz";
export type ListenSource = "extended" | "account" | "live";

export type Role = "admin" | "user";

/**
 * Who is signed in. Accounts are invite-only: an admin enters an email and the
 * invitee sets a password from the emailed link. Admins can do everything;
 * users can only look (every write, raw-data and Spotify-connect route is
 * admin-only). The API key acts as an admin with `via: "api_key"`.
 */
export interface Me {
  id: string;
  email: string | null;
  name: string | null;
  role: Role;
  via: "session" | "api_key";
}

// POST /api/auth/login | /api/auth/set-password -> { me }; GET /api/auth/me -> { me }
// POST /api/auth/forgot-password | /api/auth/reset-password | /api/auth/logout -> { ok: true }
// Errors from every auth endpoint: { error: string } with a sentence fit to show.

/** GET /api/admin/users */
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  disabled: boolean;
  /** False until the invitee has set a password. */
  activated: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** When the newest invite/reset link was issued, if any. */
  lastLinkAt: number | null;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

/**
 * POST /api/admin/users {email, name?, role, sendEmail} and
 * POST /api/admin/users/:id/link {sendEmail}. The link is ALWAYS returned, so
 * the admin can hand it over even when email fails.
 */
export interface AdminLinkResponse {
  user?: AdminUser;
  kind: "invite" | "reset";
  url: string;
  emailed: boolean;
  /** Why the email wasn't sent (safe to show; never contains a token). */
  emailDetail?: string;
}

export interface ArtistLite {
  id: string;
  name: string;
  imageUrl: string | null;
}

export interface AlbumLite {
  id: string;
  name: string;
  imageUrl: string | null;
  releaseYear: number | null;
}

export interface TrackLite {
  id: string;
  name: string;
  artists: ArtistLite[];
  album: AlbumLite | null;
  durationMs: number | null;
}

export interface Totals {
  ms: number;
  streams: number;
  plays: number;
  skips: number;
  tracks: number;
  artists: number;
  albums: number;
  /** Distinct local days with any listening. */
  activeDays: number;
  /** Podcast + audiobook listening, already included in `ms`. */
  spokenMs: number;
}

// GET /api/me
export interface MeResponse {
  me: Me;
}

// GET /api/summary — all-time facts the range picker needs.
export interface SummaryResponse {
  firstTs: number | null;
  lastTs: number | null;
  totalMs: number;
  totalStreams: number;
  /** Canonical (non-duplicate) streams per source. */
  sources: Record<ListenSource, number>;
  years: number[];
}

// GET /api/overview?from&to&tz
export interface OverviewResponse {
  totals: Totals;
  /** The same-length period immediately before `from`, for deltas. */
  previous: Totals | null;
}

// GET /api/timeline?from&to&tz&bucket[&artist|&track|&album|&genre&genreSource]
export interface TimelinePoint {
  /** Bucket start in local time: "2025-03-14" (day/week), "2025-03" (month), "2025" (year). */
  t: string;
  ms: number;
  plays: number;
  streams: number;
}
export interface TimelineResponse {
  bucket: Bucket;
  points: TimelinePoint[];
}

// GET /api/top/artists?from&to&limit&offset&q&sort=ms|plays
export interface ArtistStat extends ArtistLite {
  rank: number;
  ms: number;
  plays: number;
  streams: number;
  tracks: number;
  firstTs: number;
  lastTs: number;
}
export interface TopArtistsResponse {
  total: number;
  items: ArtistStat[];
}

// GET /api/top/tracks?from&to&limit&offset&q&artist&album&sort=ms|plays|skips
export interface TrackStat extends TrackLite {
  rank: number;
  ms: number;
  plays: number;
  streams: number;
  skips: number;
  firstTs: number;
  lastTs: number;
  energy: number | null;
  valence: number | null;
}
export interface TopTracksResponse {
  total: number;
  items: TrackStat[];
}

// GET /api/top/albums?from&to&limit&offset&q&artist&sort=ms|plays
export interface AlbumStat extends AlbumLite {
  rank: number;
  artists: ArtistLite[];
  ms: number;
  plays: number;
  streams: number;
  tracks: number;
  firstTs: number;
  lastTs: number;
}
export interface TopAlbumsResponse {
  total: number;
  items: AlbumStat[];
}

// GET /api/top/genres?from&to&source&limit
export interface GenreStat {
  genre: string;
  /** Listening time attributed to this genre (split evenly across a track's genres). */
  ms: number;
  plays: number;
  artists: number;
  topArtists: ArtistLite[];
}
export interface TopGenresResponse {
  source: GenreSource;
  /** Share (0..1) of music listening time that has any genre yet. */
  coverage: number;
  items: GenreStat[];
}

// GET /api/genres/timeline?from&to&tz&bucket&source&top
export interface GenreTimelineResponse {
  bucket: Bucket;
  genres: string[];
  points: { t: string; values: Record<string, number>; otherMs: number }[];
}

// GET /api/clock?from&to&tz[&artist|&track]
export interface ClockResponse {
  /** cells[weekday][hour] = ms; weekday 0 = Monday … 6 = Sunday, local time. */
  cells: number[][];
  maxMs: number;
}

// GET /api/mood?from&to&tz
export interface AudioFeatures {
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  speechiness: number | null;
  liveness: number | null;
  /** BPM */
  tempo: number | null;
  /** dB, typically -60..0 */
  loudness: number | null;
}
export interface MoodTrack {
  id: string;
  name: string;
  artist: string;
  imageUrl: string | null;
  energy: number;
  valence: number;
  ms: number;
}
export interface MoodResponse {
  /** Share (0..1) of music listening time with audio features. */
  coverage: number;
  /** Listening-time-weighted averages. */
  averages: AudioFeatures;
  byHour: { hour: number; energy: number | null; valence: number | null; ms: number }[];
  byPeriod: { t: string; energy: number | null; valence: number | null; danceability: number | null }[];
  bucket: Bucket;
  /** 10 bins over 0..1, value = ms. */
  energyHistogram: number[];
  valenceHistogram: number[];
  /** 10-BPM bins from 60 to 200, value = ms. */
  tempoHistogram: { bpm: number; ms: number }[];
  /**
   * ms by mood, from energy (e) and valence (v), split at 0.5: energetic
   * (e >= 0.8, v >= 0.5), happy (other e >= 0.5, v >= 0.5), tense (e >= 0.5,
   * v < 0.5), calm (e < 0.5, v >= 0.5), sad (e < 0.5, v < 0.5).
   */
  quadrants: { happy: number; energetic: number; tense: number; sad: number; calm: number };
  /** Top tracks by time, for the energy/valence scatter. */
  tracks: MoodTrack[];
  extremes: {
    mostEnergetic: MoodTrack[];
    calmest: MoodTrack[];
    happiest: MoodTrack[];
    saddest: MoodTrack[];
  };
}

// GET /api/history?before&limit&q&from&to&artist&track&album&kind&source&skipped&includeDuplicates
export interface ListenRow {
  id: number;
  ts: number;
  kind: ListenKind;
  source: ListenSource;
  msPlayed: number;
  /** true when msPlayed is the track length rather than a measured value. */
  msEstimated: boolean;
  skipped: boolean | null;
  reasonStart: string | null;
  reasonEnd: string | null;
  platform: string | null;
  country: string | null;
  shuffle: boolean | null;
  offline: boolean | null;
  contextUri: string | null;
  /** Non-null when this row is a duplicate hidden from stats (only with includeDuplicates=1). */
  dupOf: number | null;
  track: TrackLite | null;
  episode: { id: string; name: string; show: { id: string; name: string; imageUrl: string | null } | null } | null;
}
export interface HistoryResponse {
  items: ListenRow[];
  /** Opaque cursor for the next (older) page, or null at the end. */
  nextBefore: string | null;
  /**
   * True when there are older listens but this view has shown its
   * HISTORY_MAX_ROWS; the rest is in the download (GET /api/history/export).
   */
  capped: boolean;
}

/** Listens per History page, and how far back the page can scroll. */
export const HISTORY_PAGE_SIZE = 50;
export const HISTORY_MAX_ROWS = 400;

// GET /api/artists/:id
export interface ArtistDetailResponse {
  artist: ArtistLite & {
    spotifyUrl: string | null;
    genres: { deezer: string[]; musicbrainz: string[] };
  };
  totals: Totals;
  rankAllTime: number | null;
  firstListen: { ts: number; track: TrackLite | null } | null;
  lastListen: { ts: number; track: TrackLite | null } | null;
  features: AudioFeatures | null;
}

// GET /api/tracks/:id
export interface TrackDetailResponse {
  track: TrackLite & {
    isrc: string | null;
    explicit: boolean | null;
    releaseDate: string | null;
    spotifyUrl: string | null;
    genres: string[];
  };
  totals: Totals;
  rankAllTime: number | null;
  firstListen: number | null;
  lastListen: number | null;
  features: AudioFeatures | null;
  featuresSource: "reccobeats" | "analysis" | null;
  reasonsEnd: { reason: string; streams: number }[];
  /** Other Spotify ids for the same recording (same ISRC), merged into this one. */
  versions: TrackLite[];
}

// GET /api/albums/:id
export interface AlbumDetailResponse {
  album: AlbumLite & { artists: ArtistLite[]; spotifyUrl: string | null; albumType: string | null; totalTracks: number | null };
  totals: Totals;
  firstListen: number | null;
  lastListen: number | null;
  tracks: TrackStat[];
}

// GET /api/podcasts?from&to
export interface PodcastsResponse {
  shows: { id: string; name: string; imageUrl: string | null; kind: ListenKind; ms: number; episodes: number; lastTs: number }[];
  episodes: { id: string; name: string; show: string | null; ms: number; streams: number; lastTs: number }[];
}

// GET /api/habits?from&to&tz
export interface HabitsResponse {
  /** Only extended-history imports carry platform/country/reasons/shuffle/offline. */
  detailedCoverage: number;
  platforms: { name: string; ms: number; streams: number }[];
  countries: { code: string; ms: number; streams: number }[];
  reasonsStart: { reason: string; streams: number }[];
  reasonsEnd: { reason: string; streams: number }[];
  shuffleShare: number | null;
  offlineShare: number | null;
  skipRate: number | null;
  streaks: {
    longest: { days: number; from: string; to: string } | null;
    current: { days: number; from: string; to: string } | null;
  };
  byYear: { year: number; ms: number; plays: number; artists: number; tracks: number }[];
  /** First-ever listens per bucket: how much new music you found. */
  discoveries: { t: string; newArtists: number; newTracks: number }[];
  bucket: Bucket;
  sessions: { count: number; avgMs: number; longest: { start: number; end: number; ms: number } | null };
}

// GET /api/now
export interface NowResponse {
  playing: {
    isPlaying: boolean;
    sampledAt: number;
    progressMs: number | null;
    durationMs: number | null;
    device: string | null;
    track: TrackLite | null;
    episode: { id: string; name: string; show: string | null; imageUrl: string | null } | null;
  } | null;
  recent: ListenRow[];
}

// GET /api/spotify-top — Spotify's own top lists (the Receiptify view).
export type SpotifyTimeRange = "short_term" | "medium_term" | "long_term";
export interface SpotifyTopResponse {
  /** false until the user re-signs in and grants user-top-read. */
  scopeGranted: boolean;
  takenAt: number | null;
  ranges: Record<SpotifyTimeRange, { tracks: TrackLite[]; artists: ArtistLite[] }>;
}

// GET /api/data/status
export interface ImportBatch {
  id: string;
  createdAt: number;
  finishedAt: number | null;
  status: "uploading" | "done" | "failed";
  files: { name: string; kind: string; rows: number }[];
  rowsReceived: number;
  rowsInserted: number;
  firstTs: number | null;
  lastTs: number | null;
  duplicates: number | null;
}
export interface DataStatusResponse {
  /** Per local month: canonical streams by source, plus hidden duplicates. */
  coverage: { month: string; extended: number; account: number; live: number; duplicates: number }[];
  imports: ImportBatch[];
  /** When the enrichment pump last ran (a step, or its idle heartbeat). */
  lastPumpAt: number | null;
  /**
   * Per lookup service: when it may try again after being rate limited, or
   * null if it isn't waiting. (Progress isn't counted: that reads every track.)
   */
  waitingUntil: { spotify: number | null; deezer: number | null; features: number | null; musicbrainz: number | null };
  collector: {
    status: "ok" | "degraded" | "not_connected";
    sampleLastRunMinutesAgo: number | null;
    recentLastRunMinutesAgo: number | null;
    lastError: string | null;
  };
  auth: {
    connected: boolean;
    displayName: string | null;
    scopes: string[];
    missingScopes: string[];
    refreshTokenDaysRemaining: number | null;
  };
}

// POST /api/imports  {files:[{name,kind,rows}]}  -> { id }
export interface CreateImportResponse {
  id: string;
}
// POST /api/imports/:id/rows  {rows: ImportRow[]}  (max 5000 rows per request)
export interface ImportRowsResponse {
  received: number;
  accepted: number;
  inserted: number;
}
// POST /api/imports/:id/finish
export interface FinishImportResponse {
  batch: ImportBatch;
  cleanup: CleanupResult;
}
export interface CleanupResult {
  resolvedByName: number;
  duplicates: number;
  mergedArtists: number;
  ms: number;
}

// GET /api/search?q
export interface SearchResponse {
  artists: ArtistLite[];
  tracks: TrackLite[];
  albums: (AlbumLite & { artists: ArtistLite[] })[];
}

/** Error body for every non-2xx JSON response. */
export interface ApiError {
  error: string;
}

/** Scopes the app asks for; data status lists any the stored grant lacks. */
export const REQUIRED_SCOPES = [
  "user-read-recently-played",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-read-private",
  "user-top-read",
] as const;
