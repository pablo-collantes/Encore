// Clients for the free, keyless services that replace what Spotify stopped
// giving new apps (genres, audio features). Each throws RateLimited when the
// service asks us to slow down, so the pump can back that lane off.

// MusicBrainz asks for contact details here; add your site or repository URL.
const UA = "Encore/0.2 (self-hosted listening archive)";
const TIMEOUT_MS = 15_000;

export class RateLimited extends Error {
  constructor(
    readonly service: string,
    readonly retryAfterSec: number,
  ) {
    super(`${service} rate limited; retry after ${retryAfterSec}s`);
    this.name = "RateLimited";
  }
}

async function getJson<T>(service: string, url: string, init: RequestInit = {}): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, {
    ...init,
    // Cron runs execute wherever Cloudflare has room, and Deezer localises genre
    // names by the caller's country (Japanese from a Tokyo colo) unless asked.
    headers: { "user-agent": UA, accept: "application/json", "accept-language": "en", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429 || res.status === 503) {
    const retry = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    throw new RateLimited(service, Number.isFinite(retry) ? retry : 60);
  }
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // Deezer's CDN refuses some Cloudflare egress IPs outright ("Access Denied",
    // seen 2026-10-06) while others get through. That says nothing about the
    // track, so back the lane off and let a later run try from another IP.
    if (res.status === 403 && body.includes("Access Denied")) throw new RateLimited(service, 120);
    throw new Error(`${service} HTTP ${res.status}: ${body}`);
  }
  return { status: res.status, data: (await res.json()) as T };
}

// ---------------------------------------------------------------------------
// Deezer: ISRC -> track (album id, 30 s preview) -> album genres. No key; the
// documented quota is 50 requests / 5 s per IP.
// ---------------------------------------------------------------------------

interface DeezerError {
  error?: { type?: string; message?: string; code?: number };
}

export interface DeezerTrack extends DeezerError {
  id?: number;
  title?: string;
  preview?: string;
  bpm?: number;
  album?: { id: number };
  artist?: { id: number; name: string };
}

function deezerCheck<T extends DeezerError>(data: T | null): T | null {
  if (!data) return null;
  if (data.error) {
    // code 4 = quota exceeded; 800 = no data for this id/ISRC.
    if (data.error.code === 4) throw new RateLimited("deezer", 10);
    return null;
  }
  return data;
}

export async function deezerTrackByIsrc(isrc: string): Promise<DeezerTrack | null> {
  const { data } = await getJson<DeezerTrack>("deezer", `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
  const t = deezerCheck(data);
  return t?.id ? t : null;
}

export async function deezerTrack(id: number): Promise<DeezerTrack | null> {
  const { data } = await getJson<DeezerTrack>("deezer", `https://api.deezer.com/track/${id}`);
  const t = deezerCheck(data);
  return t?.id ? t : null;
}

export async function deezerAlbumGenres(id: number): Promise<string[] | null> {
  const { data } = await getJson<DeezerError & { genres?: { data?: { name: string }[] } }>(
    "deezer",
    `https://api.deezer.com/album/${id}`,
  );
  const album = deezerCheck(data);
  if (!album) return null;
  return (album.genres?.data ?? []).map((g) => g.name).filter(Boolean);
}

// ---------------------------------------------------------------------------
// ReccoBeats: audio features by Spotify id (batches of up to 40), or computed
// from an uploaded audio clip when it doesn't know the track.
// ---------------------------------------------------------------------------

export interface Features {
  acousticness?: number;
  danceability?: number;
  energy?: number;
  instrumentalness?: number;
  liveness?: number;
  loudness?: number;
  speechiness?: number;
  tempo?: number;
  valence?: number;
  key?: number;
  mode?: number;
}

/** Map of Spotify track id -> features, for the ids ReccoBeats knows. */
export async function reccobeatsFeatures(spotifyIds: string[]): Promise<Map<string, Features>> {
  const out = new Map<string, Features>();
  if (spotifyIds.length === 0) return out;
  const { data } = await getJson<{ content?: (Features & { href?: string })[] }>(
    "reccobeats",
    `https://api.reccobeats.com/v1/audio-features?ids=${spotifyIds.slice(0, 40).join(",")}`,
  );
  for (const item of data?.content ?? []) {
    // Results are keyed by ReccoBeats' own ids; the Spotify id is in `href`.
    const m = /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(item.href ?? "");
    if (m) out.set(m[1]!, item);
  }
  return out;
}

/** Analyse an audio clip (a Deezer 30 s preview). */
export async function reccobeatsAnalyse(audio: ArrayBuffer): Promise<Features | null> {
  const form = new FormData();
  form.append("audioFile", new Blob([audio], { type: "audio/mpeg" }), "preview.mp3");
  const { data } = await getJson<Features>("reccobeats", "https://api.reccobeats.com/v1/analysis/audio-features", {
    method: "POST",
    body: form,
  });
  return data && typeof data.energy === "number" ? data : null;
}

/** Download a preview clip (signed Deezer CDN URL, valid for minutes). */
export async function fetchPreview(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": UA } });
  if (res.status === 403) throw new RateLimited("deezer", 120); // same CDN block as above
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return buf.byteLength > 10_000 && buf.byteLength < 5_000_000 ? buf : null;
}

// ---------------------------------------------------------------------------
// MusicBrainz: artist name -> MBID -> community genres. Max 1 request/second
// per client, and a descriptive User-Agent is mandatory.
// ---------------------------------------------------------------------------

export async function musicbrainzFindArtist(name: string): Promise<{ id: string; name: string; score: number }[]> {
  const q = `artist:"${name.replace(/["\\]/g, " ")}"`;
  const { data } = await getJson<{ artists?: { id: string; name: string; score: number }[] }>(
    "musicbrainz",
    `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=5`,
  );
  return data?.artists ?? [];
}

export async function musicbrainzArtistGenres(mbid: string): Promise<{ name: string; count: number }[] | null> {
  const { data } = await getJson<{ genres?: { name: string; count: number }[] }>(
    "musicbrainz",
    `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?inc=genres&fmt=json`,
  );
  return data ? (data.genres ?? []) : null;
}
