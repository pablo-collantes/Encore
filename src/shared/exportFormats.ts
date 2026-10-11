// Spotify's privacy-download formats -> one common row shape (ImportRow).
//
// The browser parses the zip (so a 100 MB export never has to fit in one Worker
// request) and uploads ImportRows in chunks; the Worker validates them again
// with `validateImportRow` before anything touches D1.
//
// Formats handled:
//   * Extended streaming history: Streaming_History_Audio_*.json, Streaming_History_Video_*.json
//     (and the pre-2023 endsong_*.json). Lifetime history; track/episode URIs,
//     ms_played, skip/shuffle/platform/country. `ts` is when the stream ended (UTC).
//   * Account data: StreamingHistory_music_*.json, StreamingHistory_podcast_*.json
//     (and the older StreamingHistoryN.json). Last ~12 months only, names but no
//     URIs, minute-precision `endTime` (UTC).
//   * Recognised but not listening history: YourLibrary.json, Playlist*.json,
//     Userdata.json, SearchQueries.json, ... (reported as skipped).

export type ImportSource = "extended" | "account";
export type ListenKind = "track" | "episode" | "audiobook";

/** One listening event, as uploaded to POST /api/imports/:id/rows. */
export interface ImportRow {
  /** Unix ms when the stream ENDED (Spotify's convention in both export formats). */
  ts: number;
  src: ImportSource;
  kind: ListenKind;
  /** spotify:track:…, spotify:episode:…, or an audiobook chapter URI. */
  uri?: string | null;
  track?: string | null;
  artist?: string | null;
  album?: string | null;
  episode?: string | null;
  show?: string | null;
  ms: number;
  platform?: string | null;
  country?: string | null;
  reasonStart?: string | null;
  reasonEnd?: string | null;
  shuffle?: boolean | null;
  skipped?: boolean | null;
  offline?: boolean | null;
  incognito?: boolean | null;
}

export type ExportFileKind =
  | "extended_audio"
  | "extended_video"
  | "account_music"
  | "account_podcast"
  | "account_legacy"
  | "other";

export interface ParsedExportFile {
  name: string;
  kind: ExportFileKind;
  rows: ImportRow[];
  /** Entries present in the file but not importable (no timestamp, ads, …). */
  dropped: number;
  firstTs: number | null;
  lastTs: number | null;
  /** Why an `other` file was skipped, for the UI. */
  note?: string;
}

const base = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Decide a file's format from its name, falling back to sniffing the first entry. */
export function classifyExportFile(path: string, sample?: unknown): ExportFileKind {
  const name = base(path);
  if (/^Streaming_History_Audio_.*\.json$/i.test(name) || /^endsong_\d+\.json$/i.test(name)) return "extended_audio";
  if (/^Streaming_History_Video_.*\.json$/i.test(name)) return "extended_video";
  if (/^StreamingHistory_music_\d+\.json$/i.test(name)) return "account_music";
  if (/^StreamingHistory_podcast_\d+\.json$/i.test(name)) return "account_podcast";
  if (/^StreamingHistory\d+\.json$/i.test(name)) return "account_legacy";

  // Renamed files: sniff the shape of the first entry.
  if (Array.isArray(sample) && sample.length > 0 && typeof sample[0] === "object" && sample[0]) {
    const first = sample[0] as Record<string, unknown>;
    if ("ts" in first && "ms_played" in first) return "extended_audio";
    if ("endTime" in first && "trackName" in first) return "account_music";
    if ("endTime" in first && "episodeName" in first) return "account_podcast";
  }
  return "other";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Account-data `endTime` is "YYYY-MM-DD HH:MM" in UTC. */
export function parseEndTime(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0);
  return Number.isFinite(ms) ? ms : null;
}

/** One extended-history entry -> ImportRow, or null when it isn't a real listen. */
export function fromExtended(e: Record<string, unknown>): ImportRow | null {
  const ts = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
  if (!Number.isFinite(ts)) return null;
  const ms = Math.max(0, Math.round(num(e.ms_played) ?? 0));

  const trackUri = str(e.spotify_track_uri);
  const episodeUri = str(e.spotify_episode_uri);
  const audiobookUri = str(e.audiobook_chapter_uri) ?? str(e.audiobook_uri);
  const common = {
    ts,
    src: "extended" as const,
    ms,
    platform: str(e.platform),
    country: str(e.conn_country),
    reasonStart: str(e.reason_start),
    reasonEnd: str(e.reason_end),
    shuffle: bool(e.shuffle),
    skipped: bool(e.skipped),
    offline: bool(e.offline),
    incognito: bool(e.incognito_mode),
  };

  const trackName = str(e.master_metadata_track_name);
  if (trackUri || trackName) {
    return {
      ...common,
      kind: "track",
      uri: trackUri,
      track: trackName,
      artist: str(e.master_metadata_album_artist_name),
      album: str(e.master_metadata_album_album_name),
    };
  }
  const episodeName = str(e.episode_name);
  if (episodeUri || episodeName) {
    return { ...common, kind: "episode", uri: episodeUri, episode: episodeName, show: str(e.episode_show_name) };
  }
  const chapter = str(e.audiobook_chapter_title);
  const book = str(e.audiobook_title);
  if (audiobookUri || chapter || book) {
    return { ...common, kind: "audiobook", uri: audiobookUri, episode: chapter ?? book, show: book };
  }
  // Ads, and entries Spotify has stripped all metadata from.
  return null;
}

/** One account-data entry -> ImportRow. `podcast` selects the episode shape. */
export function fromAccount(e: Record<string, unknown>, kind: "music" | "podcast" | "legacy"): ImportRow | null {
  const ts = parseEndTime(e.endTime);
  if (ts === null) return null;
  const ms = Math.max(0, Math.round(num(e.msPlayed) ?? 0));

  if (kind === "podcast" || (kind === "legacy" && str(e.episodeName))) {
    const episode = str(e.episodeName);
    if (!episode) return null;
    return { ts, src: "account", kind: "episode", episode, show: str(e.podcastName), ms };
  }
  const track = str(e.trackName);
  const artist = str(e.artistName);
  if (!track && !artist) return null;
  // "Unknown Track"/"Unknown Artist" rows are local files or removed content.
  return { ts, src: "account", kind: "track", track, artist, album: str(e.albumName), ms };
}

/** Parse one JSON file from an export. Never throws on bad content; reports it instead. */
export function parseExportFile(path: string, text: string): ParsedExportFile {
  const name = base(path);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { name, kind: "other", rows: [], dropped: 0, firstTs: null, lastTs: null, note: "not valid JSON" };
  }

  const kind = classifyExportFile(path, data);
  if (kind === "other" || !Array.isArray(data)) {
    return {
      name,
      kind: "other",
      rows: [],
      dropped: 0,
      firstTs: null,
      lastTs: null,
      note: "not listening history",
    };
  }

  const rows: ImportRow[] = [];
  let dropped = 0;
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      dropped++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const row =
      kind === "extended_audio" || kind === "extended_video"
        ? fromExtended(e)
        : fromAccount(e, kind === "account_music" ? "music" : kind === "account_podcast" ? "podcast" : "legacy");
    if (row) rows.push(row);
    else dropped++;
  }

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const r of rows) {
    if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
    if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
  }
  return { name, kind, rows, dropped, firstTs, lastTs };
}

/** Is this zip entry worth reading? (Skips the PDFs/readmes Spotify bundles.) */
export function isCandidateExportPath(path: string): boolean {
  const name = base(path);
  return /\.json$/i.test(name) && !name.startsWith("._") && !path.includes("__MACOSX");
}

// ---------------------------------------------------------------------------
// Server-side validation of uploaded rows
// ---------------------------------------------------------------------------

const MAX_TEXT = 500;
const clip = (v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : s.slice(0, MAX_TEXT);
};

/** Earliest plausible listen (Spotify launched 2008) and a little future slack. */
const MIN_TS = Date.UTC(2006, 0, 1);

/**
 * Re-check a row from the client. Returns a cleaned copy or null. The browser is
 * the owner's own, but a bad parser build must not be able to write garbage.
 */
export function validateImportRow(raw: unknown, now = Date.now()): ImportRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ts = num(r.ts);
  if (ts === null || ts < MIN_TS || ts > now + 86_400_000) return null;
  if (r.src !== "extended" && r.src !== "account") return null;
  if (r.kind !== "track" && r.kind !== "episode" && r.kind !== "audiobook") return null;
  const ms = num(r.ms);
  if (ms === null || ms < 0 || ms > 24 * 3_600_000) return null;
  const row: ImportRow = {
    ts: Math.round(ts),
    src: r.src,
    kind: r.kind,
    uri: clip(r.uri),
    track: clip(r.track),
    artist: clip(r.artist),
    album: clip(r.album),
    episode: clip(r.episode),
    show: clip(r.show),
    ms: Math.round(ms),
    platform: clip(r.platform),
    country: clip(r.country),
    reasonStart: clip(r.reasonStart),
    reasonEnd: clip(r.reasonEnd),
    shuffle: bool(r.shuffle),
    skipped: bool(r.skipped),
    offline: bool(r.offline),
    incognito: bool(r.incognito),
  };
  if (row.kind === "track" && !row.uri && !row.track) return null;
  if (row.kind !== "track" && !row.uri && !row.episode) return null;
  return row;
}
