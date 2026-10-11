import type { AuthRow, Env, TokenResponse } from "./types";
import { getState, logApiCall, setState } from "./lib/db";

const ACCOUNTS = "https://accounts.spotify.com";
const TOKEN_URL = `${ACCOUNTS}/api/token`;

/**
 * Scopes we request. Deliberately read-only — nothing here can modify playback
 * or touch the user's library.
 */
export const SCOPES = [
  "user-read-recently-played", // GET /me/player/recently-played
  "user-read-playback-state", // GET /me/player
  "user-read-currently-playing", // narrower currently-playing endpoint
  "user-read-private", // GET /me (account id, display name, country)
  "user-top-read", // GET /me/top/{tracks,artists}: Spotify's own top lists (the Receiptify view)
] as const;

/** Refresh when the access token has less than this left, to absorb clock skew. */
const REFRESH_MARGIN_MS = 120_000;

/** Spotify documents a 6-month refresh-token lifetime that refreshing does not extend. */
export const REFRESH_TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

export const STATE_KEY_AUTH_ERROR = "auth_error";

export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

function basicAuth(env: Env): string {
  return `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`;
}

// --- Signed OAuth state -----------------------------------------------------

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/**
 * Why an authorization round-trip was started. Only one reason now:
 *   connect  /auth/spotify (an admin's session or the API key) — (re)connects the
 *            collected account: new scopes, a fresh refresh token. Signing in to
 *            the dashboard is email + password (src/worker/routes/auth.ts).
 */
export type AuthPurpose = "connect";

export interface VerifiedState {
  purpose: AuthPurpose;
  next: string;
}

/**
 * The `state` round-trips through Spotify unauthenticated, so it is signed with
 * STATE_SECRET and timestamped. This is what stops a stranger who finds the
 * callback URL from binding their own Spotify account to your database.
 */
export async function createState(env: Env, purpose: AuthPurpose = "connect", next = "/", now = Date.now()): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${nonce}.${now}.${purpose}.${b64url(new TextEncoder().encode(next))}`;
  return `${payload}.${await hmac(env.STATE_SECRET, payload)}`;
}

export async function verifyState(env: Env, state: string | null, now = Date.now()): Promise<VerifiedState | null> {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 5) return null;
  const [nonce, tsRaw, purpose, nextB64, sig] = parts as [string, string, string, string, string];
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) return null;
  // 15-minute window: long enough to log in, short enough to be useless later.
  if (Math.abs(now - ts) > 15 * 60 * 1000) return null;
  if (purpose !== "connect") return null;
  const expected = await hmac(env.STATE_SECRET, `${nonce}.${ts}.${purpose}.${nextB64}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  let next = "/";
  try {
    const bin = atob(nextB64.replace(/-/g, "+").replace(/_/g, "/"));
    next = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    next = "/";
  }
  return { purpose, next: safeNext(next) };
}

/** Same-origin path to land on after sign-in; anything else becomes "/". */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/auth/") || raw.startsWith("/login")) return "/";
  return raw.slice(0, 500);
}

// --- Authorization ----------------------------------------------------------

export async function buildAuthorizeUrl(
  env: Env,
  opts: { purpose?: AuthPurpose; next?: string; redirectUri?: string } = {},
  now = Date.now(),
): Promise<string> {
  const purpose = opts.purpose ?? "connect";
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: opts.redirectUri ?? env.SPOTIFY_REDIRECT_URI,
    scope: SCOPES.join(" "),
    state: await createState(env, purpose, opts.next ?? "/", now),
    // Always show the consent screen, so you can see which account you're on.
    // The code exchange returns a fresh refresh token.
    show_dialog: "true",
  });
  return `${ACCOUNTS}/authorize?${params.toString()}`;
}

async function postToken(env: Env, body: URLSearchParams, job: string): Promise<TokenResponse> {
  const started = Date.now();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuth(env),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await res.text();
  await logApiCall(env, {
    job,
    endpoint: "POST accounts/api/token",
    status: res.status,
    durationMs: Date.now() - started,
    error: res.ok ? null : text,
  });

  if (!res.ok) {
    // invalid_grant means the refresh token is dead: expired, revoked, or the
    // user changed their password. Only a fresh /auth/login can fix it.
    if (text.includes("invalid_grant")) {
      throw new ReauthRequiredError(`Spotify rejected the grant (${res.status}): ${text}`);
    }
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

export interface SpotifyProfile {
  id: string;
  display_name: string | null;
  images?: { url: string }[];
}

/** Exchange an authorization code for tokens plus the profile they belong to. Stores nothing. */
export async function exchangeCode(
  env: Env,
  code: string,
  redirectUri = env.SPOTIFY_REDIRECT_URI,
): Promise<{ token: TokenResponse; profile: SpotifyProfile | null }> {
  const token = await postToken(
    env,
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    "auth",
  );
  if (!token.refresh_token) {
    throw new Error("Spotify did not return a refresh_token; cannot collect unattended");
  }
  return { token, profile: await fetchProfile(env, token.access_token) };
}

/** Store tokens from a code exchange as the active grant (the account being collected). */
export async function storeGrant(env: Env, token: TokenResponse, profile: SpotifyProfile | null, now = Date.now()): Promise<AuthRow> {
  await env.DB.prepare(
    `INSERT INTO auth_tokens
       (id, access_token, refresh_token, expires_at, scope, spotify_user_id, display_name, image_url,
        authorized_at, last_refreshed_at, refresh_count, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token   = excluded.access_token,
       refresh_token  = excluded.refresh_token,
       expires_at     = excluded.expires_at,
       scope          = excluded.scope,
       spotify_user_id= excluded.spotify_user_id,
       display_name   = excluded.display_name,
       image_url      = excluded.image_url,
       authorized_at  = excluded.authorized_at,
       last_refreshed_at = NULL,
       refresh_count  = 0,
       updated_at     = excluded.updated_at`,
  )
    .bind(
      token.access_token,
      token.refresh_token ?? "",
      now + token.expires_in * 1000,
      token.scope ?? SCOPES.join(" "),
      profile?.id ?? null,
      profile?.display_name ?? null,
      profile?.images?.[0]?.url ?? null,
      now,
      now,
    )
    .run();

  await setState(env, STATE_KEY_AUTH_ERROR, null, now);

  const row = await getAuthRow(env);
  if (!row) throw new Error("Failed to persist tokens");
  return row;
}

/** Exchange an authorization code for tokens and store them as the active grant. */
export async function exchangeCodeForTokens(env: Env, code: string, now = Date.now()): Promise<AuthRow> {
  const { token, profile } = await exchangeCode(env, code);
  return storeGrant(env, token, profile, now);
}

export async function getAuthRow(env: Env): Promise<AuthRow | null> {
  return await env.DB.prepare("SELECT * FROM auth_tokens WHERE id = 1").first<AuthRow>();
}

async function fetchProfile(env: Env, accessToken: string): Promise<SpotifyProfile | null> {
  try {
    const base = env.SPOTIFY_API_BASE || "https://api.spotify.com/v1";
    const res = await fetch(`${base}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as SpotifyProfile;
  } catch {
    return null; // Profile is cosmetic; never block authorization on it.
  }
}

/**
 * Returns a usable access token, refreshing first if it is expired or close to it.
 *
 * Note on concurrency: the 1-minute and 5-minute crons can tick simultaneously
 * and both decide to refresh. Spotify tolerates this — the old refresh token
 * keeps working — and whichever write lands last wins. If Spotify ever does
 * rotate and invalidate, the next tick simply re-authenticates from the stored
 * value, so the failure mode is one skipped poll rather than a broken pipeline.
 */
export async function getAccessToken(env: Env, now = Date.now()): Promise<string> {
  const row = await getAuthRow(env);
  if (!row) {
    throw new ReauthRequiredError("No Spotify grant stored yet — visit /auth/login to connect an account");
  }

  if (row.expires_at - now > REFRESH_MARGIN_MS) {
    return row.access_token;
  }

  try {
    const token = await postToken(
      env,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token }),
      "auth",
    );

    await env.DB.prepare(
      `UPDATE auth_tokens
          SET access_token = ?,
              refresh_token = ?,
              expires_at = ?,
              scope = ?,
              last_refreshed_at = ?,
              refresh_count = refresh_count + 1,
              updated_at = ?
        WHERE id = 1`,
    )
      .bind(
        token.access_token,
        // Spotify may or may not rotate the refresh token; when it is absent the
        // docs say to keep using the existing one.
        token.refresh_token ?? row.refresh_token,
        now + token.expires_in * 1000,
        token.scope ?? row.scope,
        now,
        now,
      )
      .run();

    await setState(env, STATE_KEY_AUTH_ERROR, null, now);
    return token.access_token;
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      await setState(env, STATE_KEY_AUTH_ERROR, `${now}: ${err.message}`, now);
    }
    throw err;
  }
}

export interface AuthHealth {
  connected: boolean;
  spotifyUserId: string | null;
  displayName: string | null;
  scope: string | null;
  accessTokenExpiresInSec: number | null;
  authorizedAt: string | null;
  lastRefreshedAt: string | null;
  refreshCount: number | null;
  refreshTokenExpiresAt: string | null;
  refreshTokenDaysRemaining: number | null;
  needsReauthSoon: boolean;
  lastAuthError: string | null;
}

export async function authHealth(env: Env, now = Date.now()): Promise<AuthHealth> {
  const row = await getAuthRow(env);
  const lastAuthError = await getState(env, STATE_KEY_AUTH_ERROR);

  if (!row) {
    return {
      connected: false,
      spotifyUserId: null,
      displayName: null,
      scope: null,
      accessTokenExpiresInSec: null,
      authorizedAt: null,
      lastRefreshedAt: null,
      refreshCount: null,
      refreshTokenExpiresAt: null,
      refreshTokenDaysRemaining: null,
      needsReauthSoon: true,
      lastAuthError,
    };
  }

  const refreshExpiry = row.authorized_at + REFRESH_TOKEN_LIFETIME_MS;
  const daysRemaining = Math.floor((refreshExpiry - now) / 86_400_000);

  return {
    connected: true,
    spotifyUserId: row.spotify_user_id,
    displayName: row.display_name,
    scope: row.scope,
    accessTokenExpiresInSec: Math.round((row.expires_at - now) / 1000),
    authorizedAt: new Date(row.authorized_at).toISOString(),
    lastRefreshedAt: row.last_refreshed_at ? new Date(row.last_refreshed_at).toISOString() : null,
    refreshCount: row.refresh_count,
    refreshTokenExpiresAt: new Date(refreshExpiry).toISOString(),
    refreshTokenDaysRemaining: daysRemaining,
    needsReauthSoon: daysRemaining <= 14 || Boolean(lastAuthError),
    lastAuthError,
  };
}
