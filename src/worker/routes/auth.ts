// Dashboard sign-in: email + password, accept an invite,
// forgot / reset password, sign out, who am I. There is no sign-up: accounts
// exist only because an admin invited them (routes/admin.ts, scripts/invite-admin.mjs).
//
// Mounted at /api/auth. Everything except /me is on app.ts's public allowlist;
// each credential-taking endpoint is behind RL_AUTH on top of RL_API.

import { Hono } from "hono";
import type { Me, Role } from "../../shared/api";
import type { AppContext, AppEnv } from "../middleware";
import { rateLimit, requireAuth } from "../middleware";
import { dummyHash, hashPassword, validatePassword, verifyPassword } from "../lib/password";
import { consumeToken, issueToken, retireTokens } from "../lib/loginTokens";
import { linkBase, resetEmail, sendEmail } from "../lib/email";
import { clearSessionCookie, createSession, deleteSession, SESSION_COOKIE, sessionCookie, userSessionsDelete } from "../lib/session";
import { parseCookie } from "../lib/security";
import { isValidEmail, normalizeEmail, objectBody } from "../lib/validate";

export const authRoutes = new Hono<AppEnv>();

for (const path of ["/login", "/logout", "/set-password", "/forgot-password", "/reset-password"]) {
  authRoutes.use(path, rateLimit("RL_AUTH"));
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  password_hash: string;
  disabled: number;
}

const userMe = (u: Pick<UserRow, "id" | "email" | "name" | "role">): Me => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: (u.role === "admin" ? "admin" : "user") as Role,
  via: "session",
});

const getUser = (db: D1Database, by: "id" | "email", value: string) =>
  db.prepare(`SELECT id, email, name, role, password_hash, disabled FROM users WHERE ${by} = ?`).bind(value).first<UserRow>();

/** Sign this browser in: drop whatever session it held, start a new one, set the cookie. */
async function startSession(c: AppContext, userId: string): Promise<void> {
  const previous = parseCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (previous) await deleteSession(c.env, previous);
  const { token, expiresAt } = await createSession(c.env, userId, c.req.header("User-Agent") ?? null);
  c.header("Set-Cookie", sessionCookie(token, expiresAt, new URL(c.req.url).protocol === "https:"), { append: true });
}

// POST /api/auth/login {email, password}
authRoutes.post("/login", async (c) => {
  const body = await objectBody(c);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  const password = body.password;
  if (!email || typeof password !== "string" || !password) return c.json({ error: "Email and password are required." }, 400);

  const user = await getUser(c.env.DB, "email", email);
  const invalid = () => c.json({ error: "Invalid email or password." }, 401);
  if (!user || user.disabled || !user.password_hash || password.length > 200) {
    await verifyPassword(password.slice(0, 200), await dummyHash()); // same work either way
    return invalid();
  }
  if (!(await verifyPassword(password, user.password_hash))) return invalid();

  await startSession(c, user.id);
  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(Date.now(), user.id).run();
  return c.json({ me: userMe(user) });
});

// POST /api/auth/set-password {token, password}: accept an invite, then sign in
authRoutes.post("/set-password", async (c) => {
  const body = await objectBody(c);
  if (body instanceof Response) return body;
  // Check the password before touching the token, so a too-short one doesn't burn the link.
  const pwErr = validatePassword(body.password);
  if (pwErr) return c.json({ error: pwErr }, 400);

  const invalid = () => c.json({ error: "This invite link is invalid, expired or already used. Ask the person who invited you for a new one." }, 400);
  const userId = await consumeToken(c.env.DB, body.token, "invite");
  if (!userId) return invalid();
  const user = await getUser(c.env.DB, "id", userId);
  if (!user) return invalid();
  if (user.disabled) return c.json({ error: "This account is disabled." }, 400);

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, last_login_at = ? WHERE id = ?").bind(await hashPassword(body.password as string), now, userId),
    retireTokens(c.env.DB, userId, now),
  ]);
  await startSession(c, userId);
  return c.json({ me: userMe(user) });
});

// POST /api/auth/forgot-password {email}: always {ok:true}, so it can't tell who has an account
authRoutes.post("/forgot-password", async (c) => {
  const body = await objectBody(c);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  if (isValidEmail(email)) {
    const env = c.env;
    const base = linkBase(env, c.req.url);
    // Look up, mint and send after responding: the response time is the same
    // whether or not the account exists.
    c.executionCtx.waitUntil(
      (async () => {
        const user = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND disabled = 0 AND password_hash <> ''")
          .bind(email)
          .first<{ id: string }>();
        if (!user) return;
        const token = await issueToken(env.DB, user.id, "reset");
        await sendEmail(env, { to: email, ...resetEmail(env, base, token) });
      })().catch((err) => console.error("[forgot-password] failed", err)),
    );
  }
  return c.json({ ok: true });
});

// POST /api/auth/reset-password {token, password}: new password, signed out everywhere
authRoutes.post("/reset-password", async (c) => {
  const body = await objectBody(c);
  if (body instanceof Response) return body;
  const pwErr = validatePassword(body.password);
  if (pwErr) return c.json({ error: pwErr }, 400);

  const invalid = () => c.json({ error: "This reset link is invalid, expired or already used." }, 400);
  const userId = await consumeToken(c.env.DB, body.token, "reset");
  if (!userId) return invalid();
  const user = await getUser(c.env.DB, "id", userId);
  if (!user) return invalid();
  if (user.disabled) return c.json({ error: "This account is disabled." }, 400);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(body.password as string), userId),
    retireTokens(c.env.DB, userId),
    userSessionsDelete(c.env.DB, userId),
  ]);
  return c.json({ ok: true });
});

// POST /api/auth/logout
authRoutes.post("/logout", async (c) => {
  const token = parseCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (token) await deleteSession(c.env, token);
  c.header("Set-Cookie", clearSessionCookie(new URL(c.req.url).protocol === "https:"));
  return c.json({ ok: true });
});

// GET /api/auth/me (not public: requireAuth runs first, and again here for safety)
authRoutes.get("/me", requireAuth, (c) => c.json({ me: c.get("me") }));
