// Single-use invite / reset links, in `login_tokens`
// (`auth_tokens` is the Spotify grant).

import { generateToken, sha256Hex } from "./security";

export type TokenKind = "invite" | "reset";

export const INVITE_TTL_MS = 7 * 86_400_000;
export const RESET_TTL_MS = 3_600_000;

/**
 * Mint a link token and return the raw value (only its hash is stored). Any
 * earlier unused token of the same kind for this user is retired in the same
 * batch, so a resend never leaves two live links to one account.
 */
export async function issueToken(db: D1Database, userId: string, kind: TokenKind, now = Date.now()): Promise<string> {
  const token = generateToken();
  await db.batch([
    db.prepare("UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL").bind(now, userId, kind),
    db
      .prepare("INSERT INTO login_tokens (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), userId, kind, now, now + (kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS)),
  ]);
  return token;
}

/**
 * Validate and spend a token in one statement, so two concurrent submits can't
 * both succeed. Returns the user id, or null if invalid, expired or used.
 */
export async function consumeToken(db: D1Database, token: unknown, kind: TokenKind, now = Date.now()): Promise<string | null> {
  if (typeof token !== "string" || !token || token.length > 200) return null;
  const row = await db
    .prepare(
      `UPDATE login_tokens SET used_at = ?1
        WHERE token_hash = ?2 AND kind = ?3 AND used_at IS NULL AND expires_at > ?1
        RETURNING user_id`,
    )
    .bind(now, await sha256Hex(token), kind)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Retire every outstanding link for a user (after a password is set). */
export function retireTokens(db: D1Database, userId: string, now = Date.now()): D1PreparedStatement {
  return db.prepare("UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(now, userId);
}
