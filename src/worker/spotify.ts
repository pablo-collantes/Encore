import type { Env, FullArtist, Paging, PlaybackState, RecentlyPlayedResponse, SpotifyTrack, TopTimeRange } from "./types";
import { getAccessToken } from "./auth";
import { logApiCall } from "./lib/db";

const DEFAULT_API = "https://api.spotify.com/v1";

/** Abort any Spotify call that hangs, so a cron tick can't burn its whole budget. */
const REQUEST_TIMEOUT_MS = 10_000;

export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSec: number | null,
  ) {
    super(`Spotify API ${status}: ${body.slice(0, 300)}`);
    this.name = "SpotifyError";
  }
}

export interface SpotifyResult<T> {
  /** null when Spotify answered 204 No Content (nothing is playing). */
  data: T | null;
  status: number;
}

export class SpotifyClient {
  private token: string | null = null;

  /**
   * @param logSuccess  write an api_calls row for successful calls too. The
   *   per-minute collectors and the enrichment pump make thousands of calls a
   *   day, so they log failures only; each row costs D1 writes to add and again
   *   to prune.
   */
  constructor(
    private readonly env: Env,
    private readonly job: string,
    private readonly logSuccess = true,
  ) {}

  private async accessToken(): Promise<string> {
    if (!this.token) this.token = await getAccessToken(this.env);
    return this.token;
  }

  private async request<T>(path: string, attempt = 0): Promise<SpotifyResult<T>> {
    const token = await this.accessToken();
    const started = Date.now();
    // SPOTIFY_API_BASE exists so the collectors can be pointed at a local mock
    // during development; unset (the normal case) it is the real API.
    const base = this.env.SPOTIFY_API_BASE || DEFAULT_API;
    const url = path.startsWith("http") ? path : `${base}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      await logApiCall(this.env, {
        job: this.job,
        endpoint: path,
        status: null,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // 401 once means the token died early (revoked scope, password change).
    // Drop it and let getAccessToken refresh, but only retry once.
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      await this.env.DB.prepare("UPDATE auth_tokens SET expires_at = 0 WHERE id = 1").run();
      return this.request<T>(path, attempt + 1);
    }

    if (res.status === 204) {
      if (this.logSuccess) await logApiCall(this.env, { job: this.job, endpoint: path, status: 204, durationMs: Date.now() - started });
      return { data: null, status: 204 };
    }

    if (!res.ok) {
      const body = await res.text();
      const retryAfter = res.headers.get("retry-after");
      await logApiCall(this.env, {
        job: this.job,
        endpoint: path,
        status: res.status,
        durationMs: Date.now() - started,
        error: retryAfter ? `${body} (Retry-After: ${retryAfter}s)` : body,
      });
      throw new SpotifyError(res.status, body, retryAfter ? Number.parseInt(retryAfter, 10) : null);
    }

    const data = (await res.json()) as T;
    if (this.logSuccess) {
      await logApiCall(this.env, { job: this.job, endpoint: path, status: res.status, durationMs: Date.now() - started });
    }
    return { data, status: res.status };
  }

  /**
   * Completed plays, newest-window first. `after` is a unix-ms cursor; Spotify
   * only reports tracks played for more than 30 seconds and does not include
   * podcast episodes here.
   */
  async recentlyPlayed(opts: { after?: number; limit?: number } = {}): Promise<RecentlyPlayedResponse | null> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.after !== undefined) params.set("after", String(opts.after));
    const { data } = await this.request<RecentlyPlayedResponse>(`/me/player/recently-played?${params}`);
    return data;
  }

  /** Raw URL variant, for following the `next` cursor while paging. */
  async recentlyPlayedPage(url: string): Promise<RecentlyPlayedResponse | null> {
    const { data } = await this.request<RecentlyPlayedResponse>(url);
    return data;
  }

  /** Current player state, including podcasts. null when nothing is playing. */
  async currentPlayback(): Promise<PlaybackState | null> {
    const { data } = await this.request<PlaybackState>("/me/player?additional_types=track,episode");
    return data;
  }

  // Development-mode apps (verified 2026-10-06) get 403 on every batch lookup
  // (/tracks?ids=, /artists?ids=, /albums?ids=), so metadata comes one item at a
  // time. Single /artists/{id} returns images but no genres/popularity/followers.

  /** One full track object; null if Spotify no longer has it (404). */
  async track(id: string): Promise<SpotifyTrack | null> {
    try {
      const { data } = await this.request<SpotifyTrack>(`/tracks/${encodeURIComponent(id)}`);
      return data;
    } catch (err) {
      if (err instanceof SpotifyError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  /** One artist (id, name, images); null on 404. */
  async artist(id: string): Promise<FullArtist | null> {
    try {
      const { data } = await this.request<FullArtist>(`/artists/${encodeURIComponent(id)}`);
      return data;
    } catch (err) {
      if (err instanceof SpotifyError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  /** Best few catalogue matches for a track + artist name. */
  async searchTracks(track: string, artist: string | null, limit = 5): Promise<SpotifyTrack[]> {
    const clean = (s: string) => s.replace(/["]/g, " ").trim();
    const q = artist ? `track:"${clean(track)}" artist:"${clean(artist)}"` : `track:"${clean(track)}"`;
    const params = new URLSearchParams({ q, type: "track", limit: String(limit) });
    const { data } = await this.request<{ tracks: Paging<SpotifyTrack> }>(`/search?${params}`);
    return data?.tracks.items ?? [];
  }

  /** Spotify's own top tracks for a time range (needs user-top-read). */
  async topTracks(range: TopTimeRange, limit = 50): Promise<SpotifyTrack[]> {
    const { data } = await this.request<Paging<SpotifyTrack>>(`/me/top/tracks?time_range=${range}&limit=${limit}`);
    return data?.items ?? [];
  }

  /** Spotify's own top artists for a time range (needs user-top-read). */
  async topArtists(range: TopTimeRange, limit = 50): Promise<FullArtist[]> {
    const { data } = await this.request<Paging<FullArtist>>(`/me/top/artists?time_range=${range}&limit=${limit}`);
    return data?.items ?? [];
  }
}
