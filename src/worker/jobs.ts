import type { Env, RecentlyPlayedResponse, TopTimeRange } from "./types";
import type { LastSample } from "./ingest";
import { getAuthRow, ReauthRequiredError } from "./auth";
import { bumpDataVersion, CLOSED_AFTER_MS, flushPendingBumps } from "./lib/cache";
import { getState, logApiCall, runBatch, setState, touchState } from "./lib/db";
import {
  artistEnrichmentStatement,
  playStatements,
  sampleChanged,
  sampleStatements,
  toSampleCandidate,
  trackStatements,
} from "./ingest";
import { SpotifyClient } from "./spotify";
import { runCleanup } from "./cleanup";
import { foldRollups, rollupBacklog } from "./stats/rollup";

export const STATE_LAST_PLAYED_AT = "recent_last_played_at";
export const STATE_LAST_RECENT_RUN = "recent_last_run_at";
export const STATE_LAST_SAMPLE_RUN = "sample_last_run_at";
/** The hourly maintenance job (it replaced the old enrichment job, hence the key). */
export const STATE_LAST_ENRICH_RUN = "enrich_last_run_at";
export const STATE_LAST_ERROR = "last_job_error";
export const STATE_TOP_SNAPSHOT_AT = "top_last_snapshot_at";
const STATE_ERROR_RESET_AT = "enrich_errors_reset_at";

/** Cap on pages followed in one recently-played run; the endpoint holds ~50 items. */
const MAX_RECENT_PAGES = 5;

/**
 * How stale each collector's "last run" heartbeat may get before it is written
 * again. /health calls the sampler degraded after 10 minutes and the
 * recently-played collector after 20, so these keep well inside that while
 * writing a fraction as often as the crons fire.
 */
const SAMPLE_HEARTBEAT_EVERY_MS = 4 * 60_000;
const RECENT_HEARTBEAT_EVERY_MS = 9 * 60_000;

export interface JobResult {
  job: string;
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

/**
 * Collect completed plays. Uses a stored `after` watermark so each run only asks
 * for what it hasn't seen; combined with INSERT OR IGNORE on played_at this is
 * idempotent even if the cron fires twice for the same minute.
 */
export async function collectRecentlyPlayed(env: Env, now = Date.now()): Promise<JobResult> {
  // Failures are logged; 288 successful polls a day are not worth a row each.
  const client = new SpotifyClient(env, "recent", false);
  const cursorRaw = await getState(env, STATE_LAST_PLAYED_AT);
  const cursor = cursorRaw ? Number.parseInt(cursorRaw, 10) : null;

  let page: RecentlyPlayedResponse | null = await client.recentlyPlayed(
    cursor && Number.isFinite(cursor) ? { after: cursor, limit: 50 } : { limit: 50 },
  );

  let pages = 0;
  let itemsSeen = 0;
  let newPlays = 0;
  let maxPlayedAt = cursor ?? null;

  while (page && page.items.length > 0 && pages < MAX_RECENT_PAGES) {
    pages++;
    itemsSeen += page.items.length;

    const { statements, maxPlayedAt: pageMax } = playStatements(env, page.items, now);
    await runBatch(env, statements);

    if (pageMax !== null && (maxPlayedAt === null || pageMax > maxPlayedAt)) maxPlayedAt = pageMax;

    // `next` walks forward through the remaining window when a long listening
    // session produced more than one page since the last run.
    if (!page.next) break;
    page = await client.recentlyPlayedPage(page.next);
  }

  if (maxPlayedAt !== null && maxPlayedAt !== cursor) {
    await setState(env, STATE_LAST_PLAYED_AT, String(maxPlayedAt), now);
  }

  // Report rows actually added rather than rows offered, so "0 new" is visible.
  const counted = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(played_at) AS oldest FROM plays WHERE ingested_at = ?")
    .bind(now)
    .first<{ n: number; oldest: number | null }>();
  newPlays = counted?.n ?? 0;
  // New plays only touch recent periods, unless the collector was down and is
  // catching up on plays old enough to sit in a period stored as closed.
  if (newPlays > 0) await bumpDataVersion(env, (counted?.oldest ?? now) < now - CLOSED_AFTER_MS ? "history" : "live", now);

  await touchState(env, STATE_LAST_RECENT_RUN, now, RECENT_HEARTBEAT_EVERY_MS);

  return {
    job: "recent",
    ok: true,
    detail: {
      pages,
      itemsSeen,
      newPlays,
      cursorBefore: cursor,
      cursorAfter: maxPlayedAt,
      cursorAfterIso: maxPlayedAt ? new Date(maxPlayedAt).toISOString() : null,
    },
  };
}

/**
 * Sample the player. Writes a row only when something changed (or every
 * SAMPLE_HEARTBEAT_MS during continuous playback), which keeps a 1-minute cron
 * from growing the database while nothing is being played.
 */
export async function collectPlaybackSample(env: Env, now = Date.now()): Promise<JobResult> {
  // Failures are logged; 1,440 successful polls a day are not worth a row each.
  const client = new SpotifyClient(env, "sample", false);
  const state = await client.currentPlayback();

  const prev = await env.DB.prepare(
    `SELECT sampled_at, item_type, track_id, episode_id, item_name, progress_ms,
            is_playing, device_id, context_uri
       FROM playback_samples ORDER BY sampled_at DESC LIMIT 1`,
  ).first<LastSample>();

  const candidate = toSampleCandidate(state, now);

  // Nothing playing and nothing was playing before: don't record silence.
  if (!state && (!prev || prev.item_type === "none")) {
    await touchState(env, STATE_LAST_SAMPLE_RUN, now, SAMPLE_HEARTBEAT_EVERY_MS);
    return { job: "sample", ok: true, detail: { wrote: false, reason: "idle", playing: false } };
  }

  const { changed, reason } = sampleChanged(prev ?? null, candidate);
  if (!changed) {
    await touchState(env, STATE_LAST_SAMPLE_RUN, now, SAMPLE_HEARTBEAT_EVERY_MS);
    return {
      job: "sample",
      ok: true,
      detail: { wrote: false, reason, playing: candidate.is_playing, item: candidate.item_name },
    };
  }

  await runBatch(env, sampleStatements(env, state, candidate));
  await touchState(env, STATE_LAST_SAMPLE_RUN, now, SAMPLE_HEARTBEAT_EVERY_MS);

  return {
    job: "sample",
    ok: true,
    detail: {
      wrote: true,
      reason,
      playing: candidate.is_playing,
      itemType: candidate.item_type,
      item: candidate.item_name,
      progressMs: candidate.progress_ms,
      device: state?.device?.name ?? null,
    },
  };
}

const TOP_RANGES: TopTimeRange[] = ["short_term", "medium_term", "long_term"];

/**
 * Snapshot Spotify's own top tracks/artists for all three time ranges (the
 * data Receiptify-style apps show), at most once every 20 hours. Needs the
 * user-top-read scope, which grants made before it was added don't have.
 */
export async function snapshotTopLists(env: Env, now = Date.now(), force = false): Promise<Record<string, unknown>> {
  const auth = await getAuthRow(env);
  if (!auth?.scope.split(/\s+/).includes("user-top-read")) return { taken: false, reason: "user-top-read not granted yet" };
  const last = Number.parseInt((await getState(env, STATE_TOP_SNAPSHOT_AT)) ?? "0", 10);
  if (!force && Number.isFinite(last) && now - last < 20 * 3_600_000) return { taken: false, reason: "taken recently" };

  const client = new SpotifyClient(env, "top");
  const statements: D1PreparedStatement[] = [];
  const counts: Record<string, number> = {};
  for (const range of TOP_RANGES) {
    const [tracks, artists] = await Promise.all([client.topTracks(range), client.topArtists(range)]);
    tracks.forEach((track, i) => {
      if (!track.id) return;
      statements.push(...trackStatements(env, track, now));
      statements.push(
        env.DB.prepare("INSERT OR REPLACE INTO top_snapshots (taken_at, time_range, kind, rank, item_id) VALUES (?, ?, 'track', ?, ?)").bind(
          now,
          range,
          i + 1,
          track.id,
        ),
      );
    });
    artists.forEach((artist, i) => {
      if (!artist.id) return;
      statements.push(artistEnrichmentStatement(env, artist, now));
      statements.push(
        env.DB.prepare("INSERT OR REPLACE INTO top_snapshots (taken_at, time_range, kind, rank, item_id) VALUES (?, ?, 'artist', ?, ?)").bind(
          now,
          range,
          i + 1,
          artist.id,
        ),
      );
    });
    counts[range] = tracks.length + artists.length;
  }
  await runBatch(env, statements);
  await setState(env, STATE_TOP_SNAPSHOT_AT, String(now), now);
  await bumpDataVersion(env, "live", now);
  return { taken: true, ...counts };
}

/**
 * Hourly upkeep: Spotify top-list snapshot, the cleanup pass (merges, versions,
 * duplicates, priorities), a daily retry of items enrichment marked 'error',
 * and pruning of the diagnostic log and expired sessions.
 *
 * Metadata/genre/feature lookups themselves run in the per-minute pump
 * (src/worker/enrich/pump.ts).
 */
export async function runMaintenance(env: Env, now = Date.now()): Promise<JobResult> {
  const detail: Record<string, unknown> = {};

  try {
    detail.topLists = await snapshotTopLists(env, now);
  } catch (err) {
    // Not fatal: the rest of maintenance still matters.
    detail.topLists = { taken: false, error: err instanceof Error ? err.message : String(err) };
  }

  detail.cleanup = await runCleanup(env, {}, now);
  // Add the last hour's listening (and any enrichment) to the stored totals.
  detail.rollups = await foldRollups(env, { now, budgetMs: 120_000 });

  const lastReset = Number.parseInt((await getState(env, STATE_ERROR_RESET_AT)) ?? "0", 10);
  if (!Number.isFinite(lastReset) || now - lastReset > 86_400_000) {
    await env.DB.batch([
      // One pass over tracks for all four lanes (no index covers 'error').
      env.DB.prepare(
        `UPDATE tracks SET meta_status = NULLIF(meta_status, 'error'), deezer_status = NULLIF(deezer_status, 'error'),
                features_status = NULLIF(features_status, 'error'), search_status = NULLIF(search_status, 'error')
          WHERE 'error' IN (meta_status, deezer_status, features_status, search_status)`,
      ),
      env.DB.prepare("UPDATE artists SET mb_status = NULL WHERE mb_status = 'error'"),
    ]);
    await setState(env, STATE_ERROR_RESET_AT, String(now), now);
    detail.erroredItemsRetried = true;
  }

  const retentionDays = Number.parseInt(env.API_LOG_RETENTION_DAYS ?? "30", 10);
  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const cutoff = now - retentionDays * 86_400_000;
    const res = await env.DB.prepare("DELETE FROM api_calls WHERE called_at < ?").bind(cutoff).run();
    detail.prunedLogs = res.meta.changes ?? 0;
  }
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  // In case the pump stopped before applying a throttled cache-version bump.
  await flushPendingBumps(env, now);

  await setState(env, STATE_LAST_ENRICH_RUN, String(now), now);
  return { job: "maintenance", ok: true, detail };
}

/**
 * Bring the stored All time / yearly totals up to date (src/worker/stats/rollup.ts).
 * The hourly maintenance run does this; imports and the minute cron (see
 * foldBacklog) call it too.
 */
export async function foldJob(env: Env, budgetMs = 60_000): Promise<JobResult> {
  return { job: "rollup", ok: true, detail: { ...(await foldRollups(env, { budgetMs })) } };
}

/**
 * The minute cron's part: while the totals are being built, when they are far
 * behind (an import), and whenever listens or enrichment changed. The pump runs
 * just before and enriches the most-listened tracks first; taken in every
 * minute, each fold moves one pump step's worth of listens to their new artists
 * and genres, where an hour's worth in one fold would outrun D1's CPU limit.
 */
export async function foldBacklog(env: Env, now = Date.now()): Promise<JobResult> {
  const b = await rollupBacklog(env);
  if (b.built && b.behind < FOLD_BACKLOG_AT && !b.pending) return { job: "rollup", ok: true, detail: { skipped: true, behind: b.behind } };
  return { job: "rollup", ok: true, detail: { ...(await foldRollups(env, { now, budgetMs: 40_000 })) } };
}

/** Listens not yet in the stored totals that make the minute cron fold instead of waiting for the hour. */
const FOLD_BACKLOG_AT = 1_000;

/**
 * Wrap a job so a failure is recorded and surfaced by /health instead of just
 * vanishing into a cron log. Reauth failures are recorded but not rethrown —
 * retrying them cannot help until the user re-authorises.
 */
export async function runJobSafely(env: Env, job: () => Promise<JobResult>, name: string, now = Date.now()): Promise<JobResult> {
  try {
    const result = await job();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`job ${name} failed:`, message);
    await setState(env, STATE_LAST_ERROR, `${new Date(now).toISOString()} ${name}: ${message}`, now).catch(() => {});
    await logApiCall(env, { job: name, endpoint: "job", error: message }, now);

    if (err instanceof ReauthRequiredError) {
      return { job: name, ok: false, detail: { needsReauth: true }, error: message };
    }
    return { job: name, ok: false, detail: {}, error: message };
  }
}
