// Account management for admins, mounted at /api/admin.
// app.ts already requires the admin role for everything under /api/admin.
//
// The invite / reset link is ALWAYS returned to the admin, not only when email
// fails: email is a convenience and the link is the real delivery mechanism.
//
// Guards: an admin can't disable, demote or delete themselves, so there is
// always at least one enabled admin (the one making the change).

import { Hono } from "hono";
import type { AdminLinkResponse, AdminUser, Role } from "../../shared/api";
import type { AppEnv } from "../middleware";
import { issueToken } from "../lib/loginTokens";
import { inviteEmail, linkBase, resetEmail, sendEmail, type EmailResult } from "../lib/email";
import { userSessionsDelete } from "../lib/session";
import { cleanText, isValidEmail, normalizeEmail, objectBody } from "../lib/validate";

export const adminRoutes = new Hono<AppEnv>();

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  disabled: number;
  activated: number;
  created_at: number;
  last_login_at: number | null;
  last_link_at: number | null;
}

const USER_SELECT = `
  SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at, u.last_login_at,
         CASE WHEN u.password_hash = '' THEN 0 ELSE 1 END AS activated,
         (SELECT MAX(t.created_at) FROM login_tokens t WHERE t.user_id = u.id) AS last_link_at
    FROM users u`;

function userOut(r: UserRow): AdminUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: (r.role === "admin" ? "admin" : "user") as Role,
    disabled: !!r.disabled,
    activated: !!r.activated,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    lastLinkAt: r.last_link_at,
  };
}

const getUser = (db: D1Database, id: string) => db.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(id).first<UserRow>();

function linkResponse(kind: "invite" | "reset", url: string, send: EmailResult | null): AdminLinkResponse {
  return { kind, url, emailed: !!send?.ok, ...(send && !send.ok && send.detail ? { emailDetail: send.detail } : {}) };
}

// GET /api/admin/users
adminRoutes.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(`${USER_SELECT} ORDER BY u.created_at DESC, u.rowid DESC`).all<UserRow>();
  return c.json({ users: results.map(userOut) });
});

// POST /api/admin/users {email, name?, role, sendEmail}: create an invited account
adminRoutes.post("/users", async (c) => {
  const body = await objectBody(c);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return c.json({ error: "A valid email is required." }, 400);
  const name = cleanText(body.name, 120) || null;
  if (body.role !== undefined && body.role !== "admin" && body.role !== "user") return c.json({ error: "Role must be admin or user." }, 400);
  const role: Role = body.role === "admin" ? "admin" : "user";

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return c.json({ error: "An account with that email already exists." }, 409);

  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, '', ?, ?)")
    .bind(id, email, name, role, Date.now())
    .run();

  const token = await issueToken(c.env.DB, id, "invite");
  const mail = inviteEmail(c.env, linkBase(c.env, c.req.url), token, name);
  const send = body.sendEmail === true ? await sendEmail(c.env, { to: email, replyTo: c.get("me").email, ...mail }) : null;
  const user = await getUser(c.env.DB, id);
  return c.json({ user: userOut(user!), ...linkResponse("invite", mail.link, send) } satisfies AdminLinkResponse);
});

// POST /api/admin/users/:id/link {sendEmail}: a fresh invite (not activated) or reset (activated) link
adminRoutes.post("/users/:id/link", async (c) => {
  const body = await objectBody(c);
  if (body instanceof Response) return body;
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) return c.json({ error: "Not found." }, 404);
  if (user.disabled) return c.json({ error: "This account is disabled. Enable it first." }, 400);

  const kind = user.activated ? "reset" : "invite";
  const base = linkBase(c.env, c.req.url);
  const token = await issueToken(c.env.DB, user.id, kind);
  const mail = kind === "invite" ? inviteEmail(c.env, base, token, user.name) : resetEmail(c.env, base, token);
  const send =
    body.sendEmail === true ? await sendEmail(c.env, { to: user.email, replyTo: kind === "invite" ? c.get("me").email : null, ...mail }) : null;
  return c.json(linkResponse(kind, mail.link, send));
});

// PATCH /api/admin/users/:id {disabled?, role?}
adminRoutes.patch("/users/:id", async (c) => {
  const body = await objectBody(c);
  if (body instanceof Response) return body;
  const id = c.req.param("id");
  const self = id === c.get("me").id;
  const { disabled, role } = body;
  if (disabled !== undefined && typeof disabled !== "boolean") return c.json({ error: "disabled must be true or false." }, 400);
  if (role !== undefined && role !== "admin" && role !== "user") return c.json({ error: "Role must be admin or user." }, 400);
  if (disabled === undefined && role === undefined) return c.json({ error: "Nothing to change." }, 400);
  if (self && disabled === true) return c.json({ error: "You can't disable your own account." }, 400);
  if (self && role === "user") return c.json({ error: "You can't remove your own admin role." }, 400);

  if (!(await getUser(c.env.DB, id))) return c.json({ error: "Not found." }, 404);
  const stmts: D1PreparedStatement[] = [];
  if (disabled !== undefined) {
    stmts.push(c.env.DB.prepare("UPDATE users SET disabled = ? WHERE id = ?").bind(disabled ? 1 : 0, id));
    if (disabled) stmts.push(userSessionsDelete(c.env.DB, id));
  }
  if (role !== undefined) stmts.push(c.env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, id));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// DELETE /api/admin/users/:id: the account, its sessions and its links
adminRoutes.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  if (id === c.get("me").id) return c.json({ error: "You can't delete your own account." }, 400);
  const results = await c.env.DB.batch([
    userSessionsDelete(c.env.DB, id),
    c.env.DB.prepare("DELETE FROM login_tokens WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  if (!results.at(-1)?.meta.changes) return c.json({ error: "Not found." }, 404);
  return c.json({ ok: true });
});
