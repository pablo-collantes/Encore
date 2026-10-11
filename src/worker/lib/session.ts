// Dashboard sessions for invite-only accounts. The cookie
// holds a random token; D1 stores only its SHA-256. The role is read from
// `users` on every request, never from the cookie or the client.

import type { Me, Role } from "../../shared/api";
import type { Env } from "../types";
import { generateToken, parseCookie, sha256Hex } from "./security";

export const SESSION_COOKIE = "encore_session";
const SESSION_TTL_MS = 30 * 86_400_000;
/** Sliding expiry: a session used within its last 15 days is extended. */
const RENEW_BELOW_MS = 15 * 86_400_000;

export interface ResolvedSession {
  me: Me;
  /** Set when the expiry was extended and the cookie must be re-sent. */
  renewed: { token: string; expiresAt: number } | null;
}

export async function createSession(env: Env, userId: string, userAgent: string | null, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const token = generateToken();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(await sha256Hex(token), userId, now, expiresAt, now, userAgent?.slice(0, 300) ?? null),
  ]);
  return { token, expiresAt };
}

export async function resolveSession(env: Env, token: string | null, now = Date.now()): Promise<ResolvedSession | null> {
  if (!token || token.length > 200) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, s.last_seen_at, u.email, u.name, u.role, u.disabled, u.password_hash <> '' AS activated
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  )
    .bind(id)
    .first<{ user_id: string; expires_at: number; last_seen_at: number; email: string; name: string | null; role: string; disabled: number; activated: number }>();
  if (!row) return null;
  if (row.expires_at <= now || row.disabled || !row.activated) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }

  let renewed: ResolvedSession["renewed"] = null;
  if (row.expires_at - now < RENEW_BELOW_MS) {
    const expiresAt = now + SESSION_TTL_MS;
    await env.DB.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?").bind(expiresAt, now, id).run();
    renewed = { token, expiresAt };
  } else if (now - row.last_seen_at > 3_600_000) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, id).run();
  }

  return {
    me: { id: row.user_id, email: row.email, name: row.name, role: (row.role === "admin" ? "admin" : "user") as Role, via: "session" },
    renewed,
  };
}

export function sessionFromRequest(env: Env, request: Request): Promise<ResolvedSession | null> {
  return resolveSession(env, parseCookie(request.headers.get("Cookie"), SESSION_COOKIE));
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
}

/** Sign an account out everywhere (password reset, disable, delete). */
export function userSessionsDelete(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId);
}

/** Set-Cookie value for a session token. Host-only (no Domain): apps on sibling subdomains never see it. */
export function sessionCookie(token: string, expiresAt: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
}
