import type { Env } from "../types";
import { clampInt, errorResponse, json } from "../lib/http";

/** Tables/views the export endpoint is allowed to dump. */
const EXPORTABLE = new Set([
  "plays",
  "playback_samples",
  "tracks",
  "artists",
  "albums",
  "track_artists",
  "album_artists",
  "episodes",
  "shows",
  "api_calls",
  "sync_state",
  "imported_plays",
  "v_plays",
  "v_top_tracks",
  "v_top_artists",
  "v_daily",
  "v_sample_spans",
  "v_all_plays",
]);

/** Recent plays, newest first, with optional time window. */
export async function handlePlays(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 1000);
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");

  const clauses: string[] = [];
  const binds: unknown[] = [];

  const sinceMs = parseTime(since);
  if (sinceMs !== null) {
    clauses.push("played_at >= ?");
    binds.push(sinceMs);
  }
  const untilMs = parseTime(until);
  if (untilMs !== null) {
    clauses.push("played_at <= ?");
    binds.push(untilMs);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM v_plays ${where} ORDER BY played_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all();

  return json({ count: results.length, plays: results });
}

/** Accepts unix ms, unix seconds, or anything Date.parse understands. */
function parseTime(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    return raw.length <= 10 ? n * 1000 : n;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** What the most recent sample says is playing, plus the last completed play. */
export async function handleNow(_request: Request, env: Env): Promise<Response> {
  const sample = await env.DB.prepare(
    `SELECT s.*, t.name AS track_name, e.name AS episode_name
       FROM playback_samples s
       LEFT JOIN tracks t ON t.id = s.track_id
       LEFT JOIN episodes e ON e.id = s.episode_id
      ORDER BY s.sampled_at DESC LIMIT 1`,
  ).first();

  const lastPlay = await env.DB.prepare("SELECT * FROM v_plays ORDER BY played_at DESC LIMIT 1").first();

  return json({
    latestSample: sample
      ? { ...sample, sampled_at_iso: new Date(Number(sample.sampled_at)).toISOString() }
      : null,
    lastCompletedPlay: lastPlay,
  });
}

export async function handleTopTracks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get("days"), 30, 1, 36500);
  const limit = clampInt(url.searchParams.get("limit"), 25, 1, 500);
  const since = Date.now() - days * 86_400_000;

  const { results } = await env.DB.prepare(
    `SELECT t.id AS track_id, t.name AS track_name,
            (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
               FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
              WHERE ta.track_id = t.id) AS artist_names,
            COUNT(*) AS play_count,
            SUM(COALESCE(p.duration_ms, t.duration_ms, 0)) / 60000.0 AS approx_minutes,
            MAX(p.played_at) AS last_played_at
       FROM plays p JOIN tracks t ON t.id = p.track_id
      WHERE p.played_at >= ?
      GROUP BY t.id
      ORDER BY play_count DESC, approx_minutes DESC
      LIMIT ?`,
  )
    .bind(since, limit)
    .all();

  return json({ windowDays: days, since: new Date(since).toISOString(), tracks: results });
}

export async function handleTopArtists(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get("days"), 30, 1, 36500);
  const limit = clampInt(url.searchParams.get("limit"), 25, 1, 500);
  const since = Date.now() - days * 86_400_000;

  const { results } = await env.DB.prepare(
    `SELECT a.id AS artist_id, a.name AS artist_name, a.genres,
            COUNT(*) AS play_count,
            COUNT(DISTINCT p.track_id) AS distinct_tracks,
            SUM(COALESCE(p.duration_ms, t.duration_ms, 0)) / 60000.0 AS approx_minutes,
            MAX(p.played_at) AS last_played_at
       FROM plays p
       JOIN tracks t ON t.id = p.track_id
       JOIN track_artists ta ON ta.track_id = t.id
       JOIN artists a ON a.id = ta.artist_id
      WHERE p.played_at >= ?
      GROUP BY a.id
      ORDER BY play_count DESC
      LIMIT ?`,
  )
    .bind(since, limit)
    .all();

  return json({ windowDays: days, since: new Date(since).toISOString(), artists: results });
}

export async function handleDaily(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get("days"), 90, 1, 36500);
  const since = Date.now() - days * 86_400_000;

  const { results } = await env.DB.prepare(
    `SELECT date(played_at / 1000, 'unixepoch') AS day,
            COUNT(*) AS play_count,
            COUNT(DISTINCT track_id) AS distinct_tracks,
            SUM(COALESCE(duration_ms, 0)) / 60000.0 AS approx_minutes
       FROM plays
      WHERE played_at >= ?
      GROUP BY day
      ORDER BY day DESC`,
  )
    .bind(since)
    .all();

  return json({ windowDays: days, days: results });
}

/**
 * Ad-hoc read-only SQL. The SELECT/WITH check is a footgun guard, not a security
 * boundary — this route is already behind API_KEY and hits your own database.
 * D1's prepare() runs a single statement, so stacked queries are rejected by the
 * driver rather than by this check.
 */
export async function handleQuery(request: Request, env: Env): Promise<Response> {
  let sql: string | null = null;
  let params: unknown[] = [];

  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await request.json().catch(() => null)) as { sql?: string; params?: unknown[] } | null;
      sql = body?.sql ?? null;
      params = Array.isArray(body?.params) ? body!.params! : [];
    } else {
      sql = (await request.text()).trim() || null;
    }
  } else {
    sql = new URL(request.url).searchParams.get("sql");
  }

  if (!sql) {
    return errorResponse(400, "provide SQL via JSON {\"sql\": \"...\"}, a raw body, or ?sql=");
  }

  const stripped = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  if (!/^(select|with)\b/i.test(stripped)) {
    return errorResponse(400, "only SELECT / WITH queries are accepted here");
  }

  const started = Date.now();
  try {
    const result = await env.DB.prepare(sql)
      .bind(...params)
      .all();
    return json({
      rowCount: result.results.length,
      durationMs: Date.now() - started,
      meta: result.meta,
      results: result.results,
    });
  } catch (err) {
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Streaming NDJSON dump of a whole table. Streamed and keyset-paged (on rowid)
 * so exporting a large table doesn't have to fit in memory or in one D1 query,
 * and each page reads only its own rows.
 */
export async function handleExport(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const table = url.searchParams.get("table") ?? "plays";
  if (!EXPORTABLE.has(table)) {
    return errorResponse(400, `table not exportable: ${table}`, { allowed: [...EXPORTABLE].sort() });
  }

  const pageSize = clampInt(url.searchParams.get("pageSize"), 1000, 100, 5000);
  const encoder = new TextEncoder();
  let after = -1;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Not OFFSET: D1 bills the rows an OFFSET skips, so page n would re-read
      // every earlier page.
      let rows: Record<string, unknown>[];
      try {
        const result = await env.DB.prepare(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
          .bind(after, pageSize)
          .all<Record<string, unknown>>();
        rows = result.results;
        if (rows.length) after = Number(rows[rows.length - 1]!._rowid);
        for (const r of rows) delete r._rowid;
      } catch (err) {
        // The stream's headers are already sent, so surface the failure as a
        // final NDJSON line rather than as an HTTP status.
        controller.enqueue(encoder.encode(JSON.stringify({ _error: String(err) }) + "\n"));
        controller.close();
        return;
      }

      if (rows.length === 0) {
        controller.close();
        return;
      }

      controller.enqueue(encoder.encode(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
      if (rows.length < pageSize) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${table}.ndjson"`,
      "cache-control": "no-store",
    },
  });
}

const CSV_COLUMNS = [
  "ended_at", "kind", "source", "ms_played", "track", "artists", "album", "episode", "show",
  "platform", "country", "reason_start", "reason_end", "shuffle", "skipped", "offline", "spotify_uri",
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The whole listening history (duplicates left out), oldest first, as CSV.
 * Streamed in keyset pages over the timeline index, so it is one pass over
 * the listens however long the history is.
 */
export async function handleHistoryCsv(env: Env): Promise<Response> {
  const encoder = new TextEncoder();
  let after = { ts: -1, id: -1 };
  let header = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let rows: Record<string, unknown>[];
      try {
        const result = await env.DB.prepare(
          `SELECT l.id, l.ts, l.kind, l.source, l.ms_played, t.name AS track,
                  (SELECT group_concat(a.name, ', ') FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                    WHERE ta.track_id = l.song_id) AS artists,
                  al.name AS album, e.name AS episode, s.name AS show, l.platform, l.country,
                  l.reason_start, l.reason_end, l.shuffle, l.skipped, l.offline,
                  CASE WHEN l.track_id NOT LIKE 'name:%' AND l.track_id NOT LIKE 'local:%' THEN 'spotify:track:' || l.track_id
                       WHEN l.episode_id NOT LIKE 'name:%' THEN 'spotify:episode:' || l.episode_id END AS spotify_uri
             FROM listens l
             LEFT JOIN tracks t ON t.id = l.song_id LEFT JOIN albums al ON al.id = t.album_id
             LEFT JOIN episodes e ON e.id = l.episode_id LEFT JOIN shows s ON s.id = e.show_id
            WHERE l.dup_of IS NULL AND (l.ts > ?1 OR (l.ts = ?1 AND l.id > ?2))
            ORDER BY l.ts, l.id LIMIT 2000`,
        )
          .bind(after.ts, after.id)
          .all<Record<string, unknown>>();
        rows = result.results;
      } catch (err) {
        controller.enqueue(encoder.encode(`# export failed: ${String(err).replace(/\s+/g, " ")}\n`));
        controller.close();
        return;
      }
      const lines: string[] = [];
      if (header) lines.push(CSV_COLUMNS.join(","));
      header = false;
      for (const r of rows) {
        const row = { ...r, ended_at: new Date(Number(r.ts)).toISOString() } as Record<string, unknown>;
        lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
      }
      if (lines.length) controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
      const last = rows[rows.length - 1];
      if (!last || rows.length < 2000) controller.close();
      else after = { ts: Number(last.ts), id: Number(last.id) };
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="listening-history.csv"`,
      "cache-control": "no-store",
    },
  });
}

/** Row counts and coverage — the "is this actually collecting?" summary. */
export async function handleStats(_request: Request, env: Env): Promise<Response> {
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM plays)            AS plays,
            (SELECT COUNT(*) FROM playback_samples) AS samples,
            (SELECT COUNT(*) FROM tracks)           AS tracks,
            (SELECT COUNT(*) FROM artists)          AS artists,
            (SELECT COUNT(*) FROM albums)           AS albums,
            (SELECT COUNT(*) FROM episodes)         AS episodes,
            (SELECT COUNT(*) FROM artists WHERE enriched_at IS NULL) AS artists_pending,
            (SELECT COUNT(*) FROM albums  WHERE enriched_at IS NULL) AS albums_pending`,
  ).first<Record<string, number>>();

  const range = await env.DB.prepare(
    "SELECT MIN(played_at) AS first_play, MAX(played_at) AS last_play FROM plays",
  ).first<{ first_play: number | null; last_play: number | null }>();

  return json({
    counts,
    firstPlay: range?.first_play ? new Date(range.first_play).toISOString() : null,
    lastPlay: range?.last_play ? new Date(range.last_play).toISOString() : null,
  });
}
