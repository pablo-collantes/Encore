import type { Env } from "./types";
import { app } from "./app";
import { collectPlaybackSample, collectRecentlyPlayed, foldBacklog, runJobSafely, runMaintenance, type JobResult } from "./jobs";
import { pumpHasWork, pumpIdle, runPump } from "./enrich/pump";
import { sessionFromRequest } from "./lib/session";
import { withSecurityHeaders } from "./lib/security";

/** Cron expression -> job. Must stay in sync with triggers.crons in wrangler.jsonc. */
const CRON_SAMPLE = "* * * * *";
const CRON_RECENT = "*/5 * * * *";
const CRON_MAINTENANCE = "17 * * * *";

/** Hide existence: an anonymous request for gated content looks like a missing file. */
function notFound(): Response {
  return withSecurityHeaders(new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } }));
}

/**
 * Run the enrichment pump through this Worker's own fetch handler (the SELF
 * service binding), because placement (wrangler.jsonc) pins fetch handlers
 * next to the D1 primary but never applies to crons, which run wherever Cloudflare has room;
 * Deezer refuses many of those locations. Falls back to running here when the
 * binding is absent (local dev) or the call itself fails. With nothing queued
 * there is no call at all: the idle tick only touches D1.
 */
async function pumpAtPlacement(env: Env, now: number): Promise<JobResult> {
  if (!(await pumpHasWork(env, now))) return pumpIdle(env, now) as Promise<JobResult>;
  if (env.SELF && env.ENVIRONMENT === "production") {
    try {
      const res = await env.SELF.fetch(`${env.APP_URL.replace(/\/+$/, "")}/api/admin/poll?job=pump`, {
        headers: { authorization: `Bearer ${env.API_KEY}` },
      });
      const body = (await res.json().catch(() => null)) as { results?: JobResult[] } | null;
      const result = body?.results?.[0];
      if (result) return { ...result, detail: { ...result.detail, placement: res.headers.get("cf-placement") } };
      console.error(`[pump] placed call answered HTTP ${res.status}; running in the cron instead`);
    } catch (err) {
      console.error("[pump] placed call failed; running in the cron instead", err);
    }
  }
  return runPump(env, now) as Promise<JobResult>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // The signed-in app bundle is served ONLY to the owner's session. Anyone
    // else gets a plain 404 (not 401), so a drive-by visitor can't read the app
    // code or tell what's here. Everything else routed to the Worker is the
    // Hono app (see run_worker_first in wrangler.jsonc).
    if (pathname.startsWith("/protected/")) {
      try {
        if (!(await sessionFromRequest(env, request))) return notFound();
        const res = withSecurityHeaders(await env.ASSETS.fetch(request));
        // Session-only content: browsers may keep it, shared caches must not.
        res.headers.set("Cache-Control", "private, no-cache");
        return res;
      } catch (err) {
        console.error(`[gate] ${pathname} failed`, err);
        return withSecurityHeaders(new Response("Internal error", { status: 500 }));
      }
    }

    return app.fetch(request, env, ctx);
  },

  /**
   * All three cron expressions land here; controller.cron selects the job.
   * Each job is wrapped so one failing collector cannot stop the others, and so
   * failures land in sync_state where /health will show them.
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = Date.now();

    switch (controller.cron) {
      case CRON_SAMPLE:
        await runJobSafely(env, () => collectPlaybackSample(env, now), "sample", now);
        // Then one step of artwork/genre/audio-feature lookups for the archive.
        await runJobSafely(env, () => pumpAtPlacement(env, now), "pump", now);
        // Then the stored totals take in what that step (or anything else) changed.
        await runJobSafely(env, () => foldBacklog(env, now), "rollup", now);
        return;
      case CRON_RECENT:
        await runJobSafely(env, () => collectRecentlyPlayed(env, now), "recent", now);
        return;
      case CRON_MAINTENANCE:
        await runJobSafely(env, () => runMaintenance(env, now), "maintenance", now);
        return;
      default:
        // An unrecognised schedule (e.g. someone added a cron in the dashboard)
        // still does something useful rather than silently no-op'ing.
        console.warn(`unmapped cron "${controller.cron}" — running the recently-played collector`);
        await runJobSafely(env, () => collectRecentlyPlayed(env, now), "recent", now);
        return;
    }
  },
} satisfies ExportedHandler<Env>;
