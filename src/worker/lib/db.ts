import type { Env } from "../types";

/** Free-tier D1 caps a batch at 1,000 statements. Stay well under. */
export const MAX_BATCH = 500;

export async function runBatch(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += MAX_BATCH) {
    await env.DB.batch(statements.slice(i, i + MAX_BATCH));
  }
}

export async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setState(env: Env, key: string, value: string | null, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();
}

/**
 * Record "now" under `key` unless the stored time is less than `minAgeMs` old,
 * in one statement that writes nothing when it is: for heartbeats that only
 * need to be roughly current (D1 bills every row written, reads are ~free).
 */
export async function touchState(env: Env, key: string, now: number, minAgeMs: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE sync_state.updated_at <= ?3 - ?4`,
  )
    .bind(key, String(now), now, minAgeMs)
    .run();
}

export async function getAllState(env: Env): Promise<Record<string, string | null>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM sync_state").all<{ key: string; value: string | null }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export interface ApiCallLog {
  job: string;
  endpoint: string;
  status?: number | null;
  durationMs?: number | null;
  items?: number;
  error?: string | null;
}

export function apiCallStatement(env: Env, log: ApiCallLog, now = Date.now()): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO api_calls (called_at, job, endpoint, status, duration_ms, items, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    now,
    log.job,
    log.endpoint,
    log.status ?? null,
    log.durationMs ?? null,
    log.items ?? 0,
    log.error ? log.error.slice(0, 1000) : null,
  );
}

export async function logApiCall(env: Env, log: ApiCallLog, now = Date.now()): Promise<void> {
  try {
    await apiCallStatement(env, log, now).run();
  } catch (err) {
    // Diagnostics must never break collection.
    console.error("failed to write api_calls row", err);
  }
}
