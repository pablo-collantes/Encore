// The HTTP side of the Worker (Hono). Static files never reach this; only the
// paths listed in wrangler.jsonc `assets.run_worker_first` do.
//
//   public        /health (minimal unless authenticated), /auth/callback (Spotify's
//                 redirect; needs a signed state), PUBLIC_API (sign-in endpoints)
//   everything    else under /api/* needs an account's session cookie or the API
//                 key (deny by default). Signed-in users can read the dashboard;
//                 every write, /api/admin/*, the raw-data routes and the Spotify
//                 connect flow are admin-only. The API key acts as an admin.

import { Hono } from "hono";
import type { Bucket, CreateImportResponse, FinishImportResponse, GenreSource } from "../shared/api";
import { HISTORY_PAGE_SIZE } from "../shared/api";
import type { AppContext, AppEnv } from "./middleware";
import { authenticate, cacheReads, rateLimit, requireAuth, sameOrigin, securityHeaders, usersReadOnly } from "./middleware";
import { authHealth, buildAuthorizeUrl, exchangeCode, getAuthRow, safeNext, storeGrant, verifyState } from "./auth";
import { bumpDataVersion, ReadCache } from "./lib/cache";
import { getAllState, logApiCall } from "./lib/db";
import { clampInt } from "./lib/http";
import { authRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import {
  collectPlaybackSample,
  collectRecentlyPlayed,
  foldJob,
  runJobSafely,
  runMaintenance,
  snapshotTopLists,
  STATE_LAST_ENRICH_RUN,
  STATE_LAST_ERROR,
  STATE_LAST_RECENT_RUN,
  STATE_LAST_SAMPLE_RUN,
  type JobResult,
} from "./jobs";
import { runPump, STATE_PUMP_LAST_RUN } from "./enrich/pump";
import { runCleanup } from "./cleanup";
import { insertImportRows, MAX_ROWS_PER_REQUEST } from "./importer";
import { handleDaily, handleExport, handleHistoryCsv, handlePlays, handleQuery, handleStats, handleTopArtists, handleTopTracks } from "./routes/api";
import * as Q from "./stats/queries";
import * as D from "./stats/details";
import * as S from "./stats/stored";
import { parseBucket, parseRange, storedPeriodFor, type StoredPeriod } from "./stats/period";
import { rollupsReady, statsTimeZone } from "./stats/rollup";
import { validTimeZone } from "./stats/tz";

export const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("/api/*", sameOrigin);
app.use("/api/*", rateLimit("RL_API"));

// ---------------------------------------------------------------------------
// Health: an uptime monitor gets the verdict (HTTP 503 when degraded) without
// credentials; the account and collector details need the session or key.
// ---------------------------------------------------------------------------

async function collectorHealth(c: AppContext) {
  const now = Date.now();
  const [auth, state] = await Promise.all([authHealth(c.env, now), getAllState(c.env)]);
  const age = (key: string): number | null => {
    const ts = Number.parseInt(state[key] ?? "", 10);
    return Number.isFinite(ts) ? Math.round((now - ts) / 60000) : null;
  };
  const sampleAge = age(STATE_LAST_SAMPLE_RUN);
  const recentAge = age(STATE_LAST_RECENT_RUN);
  // The 1-minute cron should never be more than a few minutes stale, and the
  // 5-minute one never more than ~15 (cron accuracy is ±1 min, propagation ~15).
  const healthy = auth.connected && sampleAge !== null && sampleAge <= 10 && recentAge !== null && recentAge <= 20;
  const status: "ok" | "degraded" | "not_connected" = !auth.connected ? "not_connected" : healthy ? "ok" : "degraded";
  return { now, auth, state, status, sampleAge, recentAge, age };
}

app.get("/health", async (c) => {
  const h = await collectorHealth(c);
  const body: Record<string, unknown> = {
    status: h.status,
    needsReauthSoon: h.auth.needsReauthSoon,
    collectors: {
      sampleLastRunMinutesAgo: h.sampleAge,
      recentLastRunMinutesAgo: h.recentAge,
      maintenanceLastRunMinutesAgo: h.age(STATE_LAST_ENRICH_RUN),
      pumpLastRunMinutesAgo: h.age(STATE_PUMP_LAST_RUN),
    },
  };
  if (await authenticate(c)) {
    const counts = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM plays) AS plays, (SELECT COUNT(*) FROM playback_samples) AS samples,
              (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM listens WHERE dup_of IS NULL) AS listens,
              (SELECT MAX(played_at) FROM plays) AS last_play_at,
              (SELECT COUNT(*) FROM api_calls WHERE error IS NOT NULL AND called_at > ?1) AS api_errors`,
    )
      .bind(h.now - 3_600_000)
      .first<Record<string, number | null>>();
    body.now = new Date(h.now).toISOString();
    body.environment = c.env.ENVIRONMENT;
    body.auth = h.auth;
    (body.collectors as Record<string, unknown>).lastError = h.state[STATE_LAST_ERROR] ?? null;
    (body.collectors as Record<string, unknown>).apiErrorsLastHour = counts?.api_errors ?? 0;
    body.data = {
      plays: counts?.plays ?? 0,
      samples: counts?.samples ?? 0,
      tracks: counts?.tracks ?? 0,
      listens: counts?.listens ?? 0,
      lastPlayAt: counts?.last_play_at ? new Date(counts.last_play_at).toISOString() : null,
    };
  }
  return c.json(body, h.status === "ok" ? 200 : 503, { "Cache-Control": "no-store" });
});

// ---------------------------------------------------------------------------
// Spotify OAuth: (re)connecting the collected account. Admins only: whoever
// completes it decides whose listening this database collects. Signing in to
// the dashboard itself is email + password (routes/auth.ts).
// ---------------------------------------------------------------------------

app.use("/auth/spotify", rateLimit("RL_AUTH"));
app.use("/auth/login", rateLimit("RL_AUTH"));

// GET /auth/spotify?next=/data from the app (admin session), or /auth/login?key=…
// from a script or bookmark (API key). Both are full browser navigations.
async function connectSpotify(c: AppContext) {
  const me = await authenticate(c);
  if (!me) return c.redirect(`/login?next=${encodeURIComponent("/data")}`);
  if (me.role !== "admin") return c.json({ error: "Admins only." }, 403);
  return c.redirect(await buildAuthorizeUrl(c.env, { purpose: "connect", next: safeNext(c.req.query("next") ?? "/data") }), 302);
}
app.get("/auth/spotify", connectSpotify);
app.get("/auth/login", connectSpotify);

// Spotify redirects here. The signed, 15-minute `state` proves an admin started
// it; the outcome goes back to the app as ?spotify=<outcome>.
app.get("/auth/callback", async (c) => {
  const state = await verifyState(c.env, c.req.query("state") ?? null);
  if (!state) return c.redirect("/data?spotify=state");
  const back = (outcome: string) => c.redirect(`${state.next}${state.next.includes("?") ? "&" : "?"}spotify=${outcome}`);
  if (c.req.query("error")) return back("denied");
  const code = c.req.query("code");
  if (!code) return back("failed");

  let exchanged: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    exchanged = await exchangeCode(c.env, code);
  } catch (err) {
    console.error("[auth] code exchange failed", err);
    return back("failed");
  }
  const profile = exchanged.profile;
  if (!profile?.id) return back("failed");

  // One archive, one Spotify account: connecting someone else would mix two
  // people's listening into one timeline. (To really switch, clear auth_tokens.)
  const current = (await getAuthRow(c.env))?.spotify_user_id;
  if (current && current !== profile.id) return back("wrong_account");

  // Renews the refresh token and picks up any scope added since last time.
  await storeGrant(c.env, exchanged.token, profile);
  // A grant that just gained user-top-read gets its first top-list snapshot now
  // rather than at the next hourly run (no-op if one was taken in the last 20 h).
  c.executionCtx.waitUntil(snapshotTopLists(c.env).catch((err) => console.error("[auth] top-list snapshot failed", err)));
  return back("connected");
});

// ---------------------------------------------------------------------------
// Everything below needs an account (deny by default). The only exceptions are
// listed here once, rather than remembered route by route.
// ---------------------------------------------------------------------------

const PUBLIC_API = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/set-password", "/api/auth/forgot-password", "/api/auth/reset-password"]);
app.use("/api/*", (c, next) => (PUBLIC_API.has(c.req.path) ? next() : requireAuth(c, next)));
app.use("/api/*", (c, next) => (PUBLIC_API.has(c.req.path) ? next() : usersReadOnly(c, next)));
app.use("/api/*", cacheReads);

app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.get("/api/me", (c) => c.json({ me: c.get("me") }));

const DAY = 86_400_000;

const searchParams = (c: AppContext) => new URL(c.req.url).searchParams;

/** `from`/`to`/`tz` query params. Lists default to the last year; detail pages to all time. */
const range = (c: AppContext, defaultSpan: "year" | "all" = "year"): Q.Range => parseRange(searchParams(c), Date.now(), defaultSpan);
const bucketOf = (c: AppContext, r: Q.Range): Bucket => parseBucket(searchParams(c), r);

/**
 * All time or a calendar year, answered from the stored totals (stats/period.ts);
 * null to read the listens. Usually settled already by cacheReads.
 */
async function storedPeriod(c: AppContext): Promise<StoredPeriod | null> {
  const known = c.get("stored");
  if (known !== undefined) return known;
  const sp = await storedPeriodFor(c.env, c.req.path, searchParams(c), Date.now());
  c.set("stored", sp);
  return sp;
}

const readCache = (c: AppContext) => new ReadCache(c.env, (p) => c.executionCtx.waitUntil(p));

const genreSource = (c: AppContext): GenreSource => (c.req.query("source") === "musicbrainz" ? "musicbrainz" : "deezer");

function listOpts(c: AppContext, defaultLimit = 50): Q.ListOpts {
  return {
    limit: clampInt(c.req.query("limit") ?? null, defaultLimit, 1, 500),
    offset: clampInt(c.req.query("offset") ?? null, 0, 0, 1_000_000),
    q: c.req.query("q")?.trim().slice(0, 100) || null,
    sort: c.req.query("sort") ?? null,
  };
}

function entity(c: AppContext): Q.EntityFilter {
  return {
    artist: c.req.query("artist") || null,
    track: c.req.query("track") || null,
    album: c.req.query("album") || null,
    genre: c.req.query("genre") || null,
    genreSource: genreSource(c),
  };
}

// Each range route answers All time and calendar years from the stored totals
// (S, a few stored rows) and anything else from the listens it covers (Q / D).
app.get("/api/summary", async (c) => {
  const sp = await storedPeriod(c);
  return c.json(sp ? await S.summary(c.env) : await Q.summary(c.env, validTimeZone(c.req.query("tz"))));
});
app.get("/api/overview", async (c) => {
  const sp = await storedPeriod(c);
  return c.json(sp ? await S.overview(c.env, sp, readCache(c)) : await Q.overview(c.env, range(c), entity(c)));
});
app.get("/api/timeline", async (c) => {
  const sp = await storedPeriod(c);
  const r = range(c);
  return c.json(sp ? await S.timeline(c.env, sp, bucketOf(c, r)) : await Q.timeline(c.env, r, bucketOf(c, r), entity(c)));
});
app.get("/api/top/artists", async (c) => {
  const sp = await storedPeriod(c);
  return c.json(sp ? await S.topArtists(c.env, sp, listOpts(c)) : await Q.topArtists(c.env, range(c), listOpts(c)));
});
app.get("/api/top/tracks", async (c) => {
  const sp = await storedPeriod(c);
  const o = { ...listOpts(c), artist: c.req.query("artist") || null, album: c.req.query("album") || null };
  return c.json(sp ? await S.topTracks(c.env, sp, o) : await Q.topTracks(c.env, range(c), o));
});
app.get("/api/top/albums", async (c) => {
  const sp = await storedPeriod(c);
  const o = { ...listOpts(c), artist: c.req.query("artist") || null };
  return c.json(sp ? await S.topAlbums(c.env, sp, o) : await Q.topAlbums(c.env, range(c), o));
});
app.get("/api/top/genres", async (c) => {
  const sp = await storedPeriod(c);
  const limit = clampInt(c.req.query("limit") ?? null, 30, 1, 200);
  return c.json(sp ? await S.topGenres(c.env, sp, genreSource(c), limit) : await Q.topGenres(c.env, range(c), genreSource(c), limit));
});
app.get("/api/genres/timeline", async (c) => {
  const sp = await storedPeriod(c);
  const r = range(c);
  const top = clampInt(c.req.query("top") ?? null, 8, 1, 20);
  return c.json(
    sp
      ? await S.genreTimeline(c.env, sp, genreSource(c), bucketOf(c, r), top)
      : await Q.genreTimeline(c.env, r, genreSource(c), bucketOf(c, r), top),
  );
});
app.get("/api/clock", async (c) => {
  const sp = await storedPeriod(c);
  return c.json(sp ? await S.clock(c.env, sp) : await Q.clock(c.env, range(c), entity(c)));
});
app.get("/api/mood", async (c) => {
  const sp = await storedPeriod(c);
  const r = range(c);
  return c.json(sp ? await S.mood(c.env, sp, bucketOf(c, r)) : await Q.mood(c.env, r, bucketOf(c, r)));
});
app.get("/api/history", async (c) => {
  const kind = c.req.query("kind");
  const num = (k: string) => {
    const v = Number.parseInt(c.req.query(k) ?? "", 10);
    return Number.isFinite(v) ? v : null;
  };
  return c.json(
    await Q.history(c.env, {
      before: c.req.query("before") ?? null,
      limit: clampInt(c.req.query("limit") ?? null, HISTORY_PAGE_SIZE, 1, HISTORY_PAGE_SIZE),
      q: c.req.query("q")?.trim().slice(0, 100) || null,
      from: num("from"),
      to: num("to"),
      artist: c.req.query("artist") || null,
      track: c.req.query("track") || null,
      album: c.req.query("album") || null,
      kind: kind === "music" || kind === "spoken" || kind === "track" || kind === "episode" || kind === "audiobook" ? kind : null,
      source: c.req.query("source") || null,
      skipped: c.req.query("skipped") === "1" || c.req.query("skipped") === "true",
      includeDuplicates: c.req.query("includeDuplicates") === "1" || c.req.query("includeDuplicates") === "true",
    }),
  );
});
// Everything, as a CSV: the only way to see the whole timeline at once (one pass, streamed).
app.get("/api/history/export", (c) => handleHistoryCsv(c.env));
app.get("/api/artists/:id", async (c) => {
  const res = await D.artistDetail(c.env, c.req.param("id"), range(c, "all"));
  return res ? c.json(res) : c.json({ error: "Artist not found." }, 404);
});
app.get("/api/tracks/:id", async (c) => {
  const res = await D.trackDetail(c.env, c.req.param("id"), range(c, "all"));
  return res ? c.json(res) : c.json({ error: "Track not found." }, 404);
});
app.get("/api/albums/:id", async (c) => {
  const res = await D.albumDetail(c.env, c.req.param("id"), range(c, "all"));
  return res ? c.json(res) : c.json({ error: "Album not found." }, 404);
});
app.get("/api/podcasts", async (c) => {
  const sp = await storedPeriod(c);
  return c.json(sp ? await S.podcasts(c.env, sp) : await D.podcasts(c.env, range(c)));
});
app.get("/api/habits", async (c) => {
  const sp = await storedPeriod(c);
  const r = range(c);
  if (sp) return c.json(await S.habits(c.env, sp, bucketOf(c, r)));
  return c.json(await D.habits(c.env, r, bucketOf(c, r), Date.now(), await rollupsReady(c.env)));
});
app.get("/api/now", async (c) => c.json(await D.now(c.env)));
app.get("/api/spotify-top", async (c) => c.json(await D.spotifyTop(c.env)));
app.get("/api/search", async (c) => {
  const q = c.req.query("q")?.trim().slice(0, 100) ?? "";
  return c.json(q ? await D.search(c.env, q) : { artists: [], tracks: [], albums: [] });
});
app.get("/api/data/status", async (c) => {
  const h = await collectorHealth(c);
  const tz = validTimeZone(c.req.query("tz"));
  return c.json(
    await D.dataStatus(
      c.env,
      readCache(c),
      tz,
      tz === statsTimeZone(c.env) && (await rollupsReady(c.env)) ? () => S.coverage(c.env) : null,
      { status: h.status, sampleLastRunMinutesAgo: h.sampleAge, recentLastRunMinutesAgo: h.recentAge, lastError: h.state[STATE_LAST_ERROR] ?? null },
      {
        connected: h.auth.connected,
        displayName: h.auth.displayName,
        scopes: (h.auth.scope ?? "").split(/\s+/).filter(Boolean),
        missingScopes: D.missingScopes(h.auth.scope),
        refreshTokenDaysRemaining: h.auth.refreshTokenDaysRemaining,
      },
    ),
  );
});

// --- Imports -----------------------------------------------------------------

app.post("/api/imports", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { files?: unknown } | null;
  const files = Array.isArray(body?.files)
    ? body!.files
        .slice(0, 500)
        .map((f) => {
          const x = f as Record<string, unknown>;
          return { name: String(x.name ?? "").slice(0, 200), kind: String(x.kind ?? "").slice(0, 40), rows: Number(x.rows) || 0 };
        })
    : [];
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO imports (id, created_at, files) VALUES (?, ?, ?)").bind(id, Date.now(), JSON.stringify(files)).run();
  return c.json({ id } satisfies CreateImportResponse);
});

async function openImport(c: AppContext): Promise<Record<string, unknown> | null> {
  return c.env.DB.prepare("SELECT * FROM imports WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
}

app.post("/api/imports/:id/rows", async (c) => {
  const batch = await openImport(c);
  if (!batch) return c.json({ error: "Import not found." }, 404);
  if (batch.status !== "uploading") return c.json({ error: "This import is already finished." }, 409);
  const body = (await c.req.json().catch(() => null)) as { rows?: unknown } | null;
  if (!Array.isArray(body?.rows)) return c.json({ error: "Expected {rows: [...]}" }, 400);
  if (body.rows.length > MAX_ROWS_PER_REQUEST) return c.json({ error: `At most ${MAX_ROWS_PER_REQUEST} rows per request.` }, 413);
  const result = await insertImportRows(c.env, String(batch.id), body.rows);
  if (result.accepted > 0) await bumpDataVersion(c.env, "history");
  return c.json(result);
});

app.post("/api/imports/:id/finish", async (c) => {
  const batch = await openImport(c);
  if (!batch) return c.json({ error: "Import not found." }, 404);
  const first = typeof batch.first_ts === "number" ? batch.first_ts : null;
  const last = typeof batch.last_ts === "number" ? batch.last_ts : null;
  const cleanup = await runCleanup(c.env, first !== null && last !== null ? { from: first - DAY, to: last + DAY } : {});
  const dupRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM listens WHERE import_id = ? AND dup_of IS NOT NULL")
    .bind(batch.id)
    .first<{ n: number }>();
  await c.env.DB.prepare("UPDATE imports SET status = 'done', finished_at = ?, duplicates = ? WHERE id = ?")
    .bind(Date.now(), dupRow?.n ?? 0, batch.id)
    .run();
  // Start on the new tracks' artwork/genres/features now rather than at the next tick,
  // and add the import to the stored totals (the minute cron finishes a big one).
  c.executionCtx.waitUntil(runJobSafely(c.env, () => runPump(c.env) as Promise<JobResult>, "pump").catch(() => {}));
  c.executionCtx.waitUntil(runJobSafely(c.env, () => foldJob(c.env, 25_000), "rollup").catch(() => {}));
  const updated = await openImport(c);
  return c.json({ batch: D.toImportBatch(updated ?? batch), cleanup } satisfies FinishImportResponse);
});

app.delete("/api/imports/:id", async (c) => {
  const batch = await openImport(c);
  if (!batch) return c.json({ error: "Import not found." }, 404);
  const res = await c.env.DB.prepare("DELETE FROM listens WHERE import_id = ?").bind(batch.id).run();
  await c.env.DB.prepare("DELETE FROM imports WHERE id = ?").bind(batch.id).run();
  const first = typeof batch.first_ts === "number" ? batch.first_ts : 0;
  const last = typeof batch.last_ts === "number" ? batch.last_ts : Date.now();
  // Rows that were hidden as duplicates of the deleted ones count again.
  await runCleanup(c.env, { from: first - DAY, to: last + DAY });
  if (res.meta.changes) await bumpDataVersion(c.env, "history");
  c.executionCtx.waitUntil(runJobSafely(c.env, () => foldJob(c.env, 25_000), "rollup").catch(() => {}));
  return c.json({ deleted: res.meta.changes ?? 0 });
});

// A manual run checks the whole history, folds whatever changed into the stored
// totals and drops every KV copy: the way to pick up changes made outside the
// app (e.g. `wrangler d1 execute`). Listens edited that way are caught by the
// triggers like any other change; enrichment tables likewise.
app.post("/api/maintenance/cleanup", async (c) => {
  const result = await runCleanup(c.env, { full: true });
  await bumpDataVersion(c.env, "history");
  c.executionCtx.waitUntil(runJobSafely(c.env, () => foldJob(c.env, 25_000), "rollup").catch(() => {}));
  return c.json(result);
});

// --- Raw access for scripts (admins and the API key only: ADMIN_ONLY in middleware.ts)

app.get("/api/plays", (c) => handlePlays(c.req.raw, c.env));
app.get("/api/stats", (c) => handleStats(c.req.raw, c.env));
app.get("/api/stats/top-tracks", (c) => handleTopTracks(c.req.raw, c.env));
app.get("/api/stats/top-artists", (c) => handleTopArtists(c.req.raw, c.env));
app.get("/api/stats/daily", (c) => handleDaily(c.req.raw, c.env));
app.on(["GET", "POST"], "/api/query", (c) => handleQuery(c.req.raw, c.env));
app.get("/api/export", (c) => handleExport(c.req.raw, c.env));

// --- Admin -------------------------------------------------------------------

// Run a job now: the fastest way to check collection works without waiting for cron.
app.get("/api/admin/poll", async (c) => {
  const which = c.req.query("job") ?? "all";
  const jobs: Record<string, () => Promise<JobResult>> = {
    recent: () => collectRecentlyPlayed(c.env),
    sample: () => collectPlaybackSample(c.env),
    pump: () => runPump(c.env) as Promise<JobResult>,
    maintenance: () => runMaintenance(c.env),
    rollup: () => foldJob(c.env),
    top: async () => ({ job: "top", ok: true, detail: await snapshotTopLists(c.env, Date.now(), true) }),
  };
  const selected = which === "all" ? ["recent", "sample", "pump"] : which.split(",");
  if (!selected.every((j) => j in jobs)) return c.json({ error: `job must be all or a comma list of: ${Object.keys(jobs).join(", ")}` }, 400);
  const results: JobResult[] = [];
  for (const name of selected) results.push(await runJobSafely(c.env, jobs[name]!, name));
  return c.json({ results }, results.some((r) => !r.ok) ? 502 : 200);
});

app.get("/api/admin/logs", async (c) => {
  const limit = clampInt(c.req.query("limit") ?? null, 50, 1, 500);
  const onlyErrors = c.req.query("errors") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM api_calls ${onlyErrors ? "WHERE error IS NOT NULL" : ""} ORDER BY called_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json({ calls: results.map((r) => ({ ...r, called_at_iso: new Date(Number(r.called_at)).toISOString() })) });
});

app.notFound((c) => c.json({ error: "Not found." }, 404));
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} failed`, err);
  c.executionCtx.waitUntil(
    logApiCall(c.env, { job: "request", endpoint: `${c.req.method} ${c.req.path}`, error: err instanceof Error ? err.message : String(err) }).catch(() => {}),
  );
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});
