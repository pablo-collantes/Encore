// Invite-only accounts end to end through the real Hono app on the Node SQLite
// D1 stand-in: nobody gets in or writes anything without an admin's invite.
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/worker/app";
import { issueToken } from "../src/worker/lib/loginTokens";
import { hashPassword, verifyPassword } from "../src/worker/lib/password";
import type { Env } from "../src/worker/types";
import { testEnv } from "./sqlite";

const ORIGIN = "http://127.0.0.1:8787";

let env: Env;
let pending: Promise<unknown>[];

function ctx(): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: "manual" }),
    env,
    ctx(),
  );
  await Promise.all(pending.splice(0));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers, cookie: sessionFrom(res.headers) };
}

function sessionFrom(headers: Headers): string | undefined {
  const set = headers.get("set-cookie") ?? "";
  const m = /encore_session=([^;]*)/.exec(set);
  return m && m[1] ? `encore_session=${m[1]}` : undefined;
}

async function makeAdmin(email = "admin@example.com", password = "correct horse battery"): Promise<string> {
  await env.DB.prepare("INSERT INTO users (id, email, name, role, created_at) VALUES ('admin-1', ?, 'Admin', 'admin', 0)").bind(email).run();
  const token = await issueToken(env.DB, "admin-1", "invite");
  const res = await call("POST", "/api/auth/set-password", { body: { token, password } });
  expect(res.status).toBe(200);
  return res.cookie!;
}

beforeEach(() => {
  env = testEnv().env;
  pending = [];
});

describe("passwords", () => {
  it("hashes with PBKDF2 at the Workers cap and verifies", async () => {
    const stored = await hashPassword("hunter22hunter22");
    expect(stored).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifyPassword("hunter22hunter22", stored)).toBe(true);
    expect(await verifyPassword("hunter22hunter23", stored)).toBe(false);
    // Over the cap is refused rather than attempted (it would throw at the edge).
    expect(await verifyPassword("x", stored.replace("$100000$", "$200000$"))).toBe(false);
  });
});

describe("anonymous visitors", () => {
  it("get 401 on every data, account and admin route, and there is no sign-up", async () => {
    for (const path of ["/api/summary", "/api/auth/me", "/api/me", "/api/admin/users", "/api/data/status", "/api/query", "/api/admin/poll"]) {
      expect((await call("GET", path)).status, path).toBe(401);
    }
    expect((await call("POST", "/api/imports", { body: { files: [] } })).status).toBe(401);
    expect((await call("POST", "/api/auth/register", { body: { email: "a@b.co", password: "12345678" } })).status).toBe(401);
    expect((await call("POST", "/api/auth/signup", { body: { email: "a@b.co", password: "12345678" } })).status).toBe(401);
  });

  it("can't sign in as anyone, and get the same answer for unknown and wrong", async () => {
    await makeAdmin();
    const unknown = await call("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "whatever123" } });
    const wrong = await call("POST", "/api/auth/login", { body: { email: "admin@example.com", password: "whatever123" } });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.json).toEqual(wrong.json);
    expect(unknown.cookie).toBeUndefined();
  });

  it("forgot-password always says ok", async () => {
    const res = await call("POST", "/api/auth/forgot-password", { body: { email: "nobody@example.com" } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens").first("n")).toBe(0);
  });

  it("cross-origin writes are refused", async () => {
    const res = await call("POST", "/api/auth/logout", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("can't start the Spotify connect flow", async () => {
    const res = await call("GET", "/auth/spotify");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fdata");
    const forged = await call("GET", "/auth/callback?code=x&state=forged");
    expect(forged.headers.get("location")).toBe("/data?spotify=state");
  });
});

describe("invites", () => {
  it("validate the password before spending the token, and a token works once", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u1', 'a@example.com', 'admin', 0)").run();
    const token = await issueToken(env.DB, "u1", "invite");
    expect((await call("POST", "/api/auth/set-password", { body: { token, password: "short" } })).status).toBe(400);
    const ok = await call("POST", "/api/auth/set-password", { body: { token, password: "long enough now" } });
    expect(ok.status).toBe(200);
    expect(ok.json.me).toMatchObject({ id: "u1", role: "admin" });
    expect(ok.cookie).toBeDefined();
    expect((await call("POST", "/api/auth/set-password", { body: { token, password: "long enough again" } })).status).toBe(400);
  });

  it("an invited user can look but not write, and never reach admin or raw data", async () => {
    const admin = await makeAdmin();
    const invite = await call("POST", "/api/admin/users", { cookie: admin, body: { email: "Friend@Example.com ", name: "Friend", role: "user", sendEmail: false } });
    expect(invite.status).toBe(200);
    expect(invite.json.user).toMatchObject({ email: "friend@example.com", role: "user", activated: false });
    expect(invite.json.url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/set-password#[\w-]{43}$/);
    expect(invite.json.emailed).toBe(false);

    const token = invite.json.url.split("#")[1];
    const user = (await call("POST", "/api/auth/set-password", { body: { token, password: "friend password" } })).cookie!;

    expect((await call("GET", "/api/summary", { cookie: user })).status).toBe(200);
    expect((await call("GET", "/api/data/status", { cookie: user })).status).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie: user })).json.me).toMatchObject({ email: "friend@example.com", role: "user" });

    for (const [method, path] of [
      ["POST", "/api/imports"],
      ["POST", "/api/imports/x/rows"],
      ["DELETE", "/api/imports/x"],
      ["POST", "/api/maintenance/cleanup"],
      ["GET", "/api/admin/users"],
      ["POST", "/api/admin/users"],
      ["GET", "/api/admin/poll"],
      ["GET", "/api/query"],
      ["GET", "/api/export"],
      ["GET", "/api/plays"],
      ["GET", "/api/stats/daily"],
    ] as const) {
      expect((await call(method, path, { cookie: user, body: method === "GET" ? undefined : {} })).status, `${method} ${path}`).toBe(403);
    }
    expect((await call("GET", "/auth/spotify", { cookie: user })).status).toBe(403);

    // The admin can start the Spotify connect flow.
    const connect = await call("GET", "/auth/spotify?next=/data", { cookie: admin });
    expect(connect.status).toBe(302);
    expect(connect.headers.get("location")).toMatch(/^https:\/\/accounts\.spotify\.com\/authorize\?/);
  });

  it("refuse duplicates and guard the admin's own account", async () => {
    const admin = await makeAdmin();
    expect((await call("POST", "/api/admin/users", { cookie: admin, body: { email: "admin@example.com", role: "user", sendEmail: false } })).status).toBe(409);
    expect((await call("PATCH", "/api/admin/users/admin-1", { cookie: admin, body: { disabled: true } })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/users/admin-1", { cookie: admin, body: { role: "user" } })).status).toBe(400);
    expect((await call("DELETE", "/api/admin/users/admin-1", { cookie: admin })).status).toBe(400);
  });
});

describe("sessions", () => {
  it("disabling an account signs it out; reset signs out everywhere", async () => {
    const admin = await makeAdmin();
    const invite = await call("POST", "/api/admin/users", { cookie: admin, body: { email: "b@example.com", role: "user", sendEmail: false } });
    const id = invite.json.user.id;
    const user = (await call("POST", "/api/auth/set-password", { body: { token: invite.json.url.split("#")[1], password: "b password 1" } })).cookie!;

    expect((await call("PATCH", `/api/admin/users/${id}`, { cookie: admin, body: { disabled: true } })).status).toBe(200);
    expect((await call("GET", "/api/summary", { cookie: user })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { email: "b@example.com", password: "b password 1" } })).status).toBe(401);
    expect((await call("PATCH", `/api/admin/users/${id}`, { cookie: admin, body: { disabled: false } })).status).toBe(200);

    const again = (await call("POST", "/api/auth/login", { body: { email: "b@example.com", password: "b password 1" } })).cookie!;
    const link = await call("POST", `/api/admin/users/${id}/link`, { cookie: admin, body: { sendEmail: false } });
    expect(link.json.kind).toBe("reset");
    expect(link.json.url).toContain("/reset-password#");
    const reset = await call("POST", "/api/auth/reset-password", { body: { token: link.json.url.split("#")[1], password: "b password 2" } });
    expect(reset.json).toEqual({ ok: true });
    expect((await call("GET", "/api/summary", { cookie: again })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { email: "b@example.com", password: "b password 1" } })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { email: "b@example.com", password: "b password 2" } })).status).toBe(200);
  });

  it("a newer link retires the older one", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u1', 'a@example.com', 'user', 0)").run();
    const first = await issueToken(env.DB, "u1", "invite");
    const second = await issueToken(env.DB, "u1", "invite");
    expect((await call("POST", "/api/auth/set-password", { body: { token: first, password: "long enough now" } })).status).toBe(400);
    expect((await call("POST", "/api/auth/set-password", { body: { token: second, password: "long enough now" } })).status).toBe(200);
  });

  it("logout ends the session", async () => {
    const admin = await makeAdmin();
    expect((await call("POST", "/api/auth/logout", { cookie: admin })).status).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie: admin })).status).toBe(401);
  });

  it("the API key acts as an admin", async () => {
    const res = await call("GET", "/api/admin/users", { headers: { authorization: "Bearer test-key" } });
    expect(res.status).toBe(200);
    expect((await call("GET", "/api/auth/me", { headers: { authorization: "Bearer test-key" } })).json.me).toMatchObject({ role: "admin", via: "api_key" });
    expect((await call("GET", "/api/admin/users", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });
});
