// Auth-only API client for the PUBLIC bundle. The sign-in pages import this and
// nothing else server-facing, so a signed-out visitor reading the bundle sees
// these six endpoints and no map of the data or admin API (that client lives in
// app/lib/api.ts, behind /protected/).
import type { Me } from "@shared/api";

/** A failed auth call. `message` is a sentence fit to show; `status` is 0 when the server wasn't reached. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const NETWORK = "Couldn't reach the server.";
const RATE_LIMITED = "Too many attempts. Wait a minute and try again.";

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AuthError(NETWORK, 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: unknown };
  if (!res.ok) {
    if (res.status === 429) throw new AuthError(RATE_LIMITED, 429);
    const message = typeof data.error === "string" && data.error ? data.error : "Something went wrong. Please try again.";
    throw new AuthError(message, res.status);
  }
  return data;
}

/** null = not signed in (401). Throws AuthError on network/server failure so the gate can say so. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return (await request<{ me: Me }>("/api/auth/me")).me;
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) return null;
    throw err;
  }
}

export const login = (email: string, password: string) =>
  request<{ me: Me }>("/api/auth/login", { email, password }).then((r) => r.me);

/** Accept an invite: sets the password and signs in. */
export const setPassword = (token: string, password: string) =>
  request<{ me: Me }>("/api/auth/set-password", { token, password }).then((r) => r.me);

/** Always succeeds for a well-formed request: the answer doesn't reveal whether the account exists. */
export const forgotPassword = (email: string) => request<{ ok: true }>("/api/auth/forgot-password", { email }).then(() => undefined);

/** New password from a reset link. Signs the account out everywhere; the user then signs in again. */
export const resetPassword = (token: string, password: string) =>
  request<{ ok: true }>("/api/auth/reset-password", { token, password }).then(() => undefined);

const AUTH_PAGES = ["/login", "/forgot-password", "/set-password", "/reset-password"];

/** Same-origin path to return to after sign-in; anything else falls back to "/". */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/auth/")) return "/";
  if (AUTH_PAGES.some((p) => raw === p || raw.startsWith(`${p}?`) || raw.startsWith(`${p}#`) || raw.startsWith(`${p}/`))) return "/";
  return raw;
}

/** Signing out is a full navigation, so the app's memory goes with the session. */
export async function signOut(): Promise<void> {
  await request("/api/auth/logout", {}).catch(() => {});
  location.assign("/login");
}
