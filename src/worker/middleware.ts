import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Me } from "../shared/api";
import type { Env } from "./types";
import { classifyRead, MAX_AGE_S, ReadCache, type Freshness } from "./lib/cache";
import { secretEquals } from "./lib/http";
import { clientIp, SECURITY_HEADERS } from "./lib/security";
import { parseCookie } from "./lib/security";
import { resolveSession, SESSION_COOKIE, sessionCookie } from "./lib/session";
import { storedCacheKey, storedPeriodFor, type StoredPeriod } from "./stats/period";

/** `stored`: the stored period this read is answered from (null: read the listens). */
export type AppEnv = { Bindings: Env; Variables: { me: Me; stored?: StoredPeriod | null } };
export type AppContext = Context<AppEnv>;

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
});

/**
 * Native per-IP rate limiting. Degrades open if the binding is missing (older
 * local runtimes); deployed, the binding is always present and enforced.
 */
export function rateLimit(binding: "RL_AUTH" | "RL_API") {
  return createMiddleware<AppEnv>(async (c, next) => {
    const limiter = c.env[binding];
    if (typeof limiter?.limit === "function") {
      const { success } = await limiter.limit({ key: `${binding}:${clientIp(c.req.raw.headers)}` });
      if (!success) {
        // /auth/* are browser navigations (the Spotify connect round-trip): land back on the app.
        if (c.req.path.startsWith("/auth/")) return c.redirect("/data?spotify=rate_limited");
        return c.json({ error: "Too many requests. Wait a minute and try again." }, 429, { "Retry-After": "60" });
      }
    }
    await next();
  });
}

/**
 * CSRF guard for mutating calls: a browser always sends Origin on a cross-site
 * POST/DELETE, so one naming another site is refused. Requests without Origin
 * (curl, scripts) pass; they carry no ambient cookie from a victim's browser.
 * SameSite=Lax on the cookie is the second layer.
 */
export const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return c.json({ error: "Cross-origin request refused." }, 403);
    }
  }
  await next();
});

/** The API key, from `Authorization: Bearer`, `X-API-Key` or `?key=` (scripts and links). */
function presentedKey(c: AppContext): string {
  const header = c.req.header("authorization") ?? "";
  return (header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "") || c.req.header("x-api-key") || c.req.query("key") || "";
}

/** Who is calling: an account's session cookie, or the API key (which acts as an admin). */
export async function authenticate(c: AppContext): Promise<Me | null> {
  const session = await resolveSession(c.env, parseCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE));
  if (session) {
    if (session.renewed) {
      c.header("Set-Cookie", sessionCookie(session.renewed.token, session.renewed.expiresAt, new URL(c.req.url).protocol === "https:"), {
        append: true,
      });
    }
    return session.me;
  }
  const key = presentedKey(c);
  if (key && c.env.API_KEY && (await secretEquals(key, c.env.API_KEY))) {
    return { id: "api-key", email: null, name: "API key", role: "admin", via: "api_key" };
  }
  return null;
}

/** Deny by default: everything this guards needs a session or the API key. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const me = await authenticate(c);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  c.set("me", me);
  await next();
});

/** 401 without a session, 403 for a non-admin. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const me = c.get("me") ?? (await authenticate(c));
  if (!me) return c.json({ error: "unauthorized" }, 401);
  if (me.role !== "admin") return c.json({ error: "Admins only." }, 403);
  c.set("me", me);
  await next();
});

/**
 * Routes only an admin may call, even to read: account management and
 * operations, and the raw-data routes (read-only SQL, table export, raw plays),
 * which expose everything the dashboard deliberately summarises.
 */
const ADMIN_ONLY = ["/api/admin", "/api/query", "/api/export", "/api/plays", "/api/stats"];

/**
 * Signed-in users can look; only admins change anything. Every mutating call
 * that gets this far (the public auth endpoints never do) and every ADMIN_ONLY
 * route needs the admin role. Runs after requireAuth.
 */
export const usersReadOnly = createMiddleware<AppEnv>(async (c, next) => {
  const write = c.req.method !== "GET" && c.req.method !== "HEAD";
  const path = c.req.path;
  const adminOnly = ADMIN_ONLY.some((p) => path === p || path.startsWith(`${p}/`));
  if ((write || adminOnly) && c.get("me").role !== "admin") return c.json({ error: "Admins only." }, 403);
  await next();
});

/**
 * The dashboard reads that are answered from KV while the data they cover is
 * unchanged (src/worker/lib/cache.ts). None of them depend on who is asking.
 * Live views (/api/now, /api/data/status) and the admin-only raw routes are not
 * cached.
 */
const CACHED_READS =
  /^\/api\/(summary|overview|timeline|top\/(artists|tracks|albums|genres)|genres\/timeline|clock|mood|history|podcasts|habits|spotify-top|search|(artists|tracks|albums)\/[^/]+)$/;

/**
 * Serve CACHED_READS from KV, or let the route answer and keep a copy of a 200.
 * Runs after requireAuth and usersReadOnly, so only a caller who may see the
 * answer ever gets the stored one. Also settles whether the read is answered
 * from the stored totals (period.ts), so the route doesn't ask again.
 * `X-Cache: hit|miss` says which happened and `X-Cache-Period:
 * stored|closed|long|open` how long the answer is kept.
 */
export const cacheReads = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" || !CACHED_READS.test(c.req.path)) return next();
  const now = Date.now();
  const params = new URL(c.req.url).searchParams;
  const stored = await storedPeriodFor(c.env, c.req.path, params, now);
  c.set("stored", stored);
  if (!c.env.CACHE) return next();

  const plain = classifyRead(c.req.path, params, now);
  let key = plain.key;
  let freshness: Freshness = plain.freshness;
  let ttl = MAX_AGE_S[freshness];
  if (stored) {
    const s = await storedCacheKey(c.env, stored, key, now);
    key = s.key;
    freshness = "stored";
    ttl = s.ttlS;
  }
  const cache = new ReadCache(c.env, (p) => c.executionCtx.waitUntil(p));

  const hit = await cache.lookup(key, freshness);
  if (hit !== null) {
    c.header("X-Cache", "hit");
    c.header("X-Cache-Period", freshness);
    return c.body(hit, 200, { "Content-Type": "application/json" });
  }
  await next();
  if (c.res.status === 200) {
    cache.store(key, await c.res.clone().text(), freshness, ttl);
    c.res.headers.set("X-Cache", "miss");
    c.res.headers.set("X-Cache-Period", freshness);
  }
});
