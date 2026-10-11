// Dashboard answers stored in Workers KV (the CACHE binding): the second look
// at the same question is a KV read instead of D1 reads. KV only ever holds
// copies; the totals themselves live in D1 (src/worker/stats/rollup.ts).
//
// All time and calendar years are answered from those stored totals (class
// "stored"). Their KV key carries the version of each period the answer uses
// (roll_pv, bumped by a fold that changed that period), so a past year's
// answer stays until something in that year changes, and answers are also
// dropped when the history version moves (names and artwork may have changed).
//
// Everything else reads the listens it covers. Two version rows in sync_state
// record what changed:
//   history (data_version)  anything that can touch any point in time: import
//                           uploads and deletes, cleanup passes that changed
//                           something, enrichment of tracks/artists that have
//                           older listens, and live plays that turn up more
//                           than CLOSED_AFTER_MS after they ended
//   live (live_version)     only the recent end: new live plays, enrichment of
//                           tracks heard only recently, Spotify's top lists
// Each stored answer carries the versions it was computed from (KV metadata),
// and how they are checked depends on the period it covers (classifyRead):
//   closed  ends more than CLOSED_AFTER_MS ago (old custom ranges): kept until
//           the history version changes
//   long    reaches now and spans more than LONG_SPAN_MS (e.g. 2019 to today):
//           kept until the history version changes; new live plays are folded
//           in once the stored answer is LIVE_LAG_MS old
//   open    reaches now (Last 12 months...): kept until either version
//           changes, so new plays show on the next visit
// Long, open and current-period answers also expire (MAX_AGE_S), which bounds
// clock-dependent bits like "today" and streaks. Writes outside the paths above
// (a manual `wrangler d1 execute`) need POST /api/maintenance/cleanup.
//
// Keys start with a hash of the Worker's source (__SERVER_HASH__, set by
// vite.config.ts): a deploy that changes how answers are computed starts clean,
// a frontend-only one keeps everything. Without the binding (unit tests, some
// local runtimes) everything is computed directly.

import type { Env } from "../types";
import { getState, setState } from "./db";

declare const __SERVER_HASH__: string | undefined;

export type Scope = "history" | "live";
export type Freshness = "closed" | "long" | "open" | "stored";

const VERSION_KEY: Record<Scope, string> = { history: "data_version", live: "live_version" };
const pendingKey = (scope: Scope) => `${VERSION_KEY[scope]}_pending`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A range ending at least this long ago is closed: live plays arrive within
 * minutes of ending (collectRecentlyPlayed bumps the history version for any
 * that don't), so only history changes can alter it.
 */
export const CLOSED_AFTER_MS = 2 * DAY;

/** A range reaching now that spans more than this is treated like All time. */
const LONG_SPAN_MS = 400 * DAY;

/** How long a long-range answer may leave out the newest live plays. */
const LIVE_LAG_MS = HOUR;

/** `to` at least this recent means "up to now" (the app rounds now up to 5 minutes). */
const OPEN_SLACK_MS = 15 * 60_000;

/**
 * How long KV keeps each kind of answer. Closed ones only expire to clear out
 * old code versions; stored ones pass their own (a past year keeps, All time
 * and this year roll over hourly for "today").
 */
export const MAX_AGE_S: Record<Freshness, number> = { closed: 30 * 86_400, long: 6 * 3_600, open: 3_600, stored: 3_600 };

/** Enrichment moves a version at most this often, so artwork and genres filling in don't empty the cache every minute. */
export const PUMP_BUMP_EVERY_MS = 30 * 60_000;

/** KV keys are capped at 512 bytes; longer ones are hashed. */
const MAX_KEY_BYTES = 480;

/** Whole-archive aggregates: the answers worth letting lag behind live plays when the range is long. */
const AGGREGATES = /^\/api\/(summary|overview|timeline|top\/[a-z]+|genres\/timeline|clock|mood|podcasts|habits)$/;

/** Answers that also use all-time figures (ranks), whatever range they're asked for. */
const ALWAYS_OPEN = /^\/api\/((artists|tracks|albums)\/[^/]+|search|spotify-top)$/;

function intParam(v: string | null): number | null {
  if (v === null || !/^\d+$/.test(v)) return null;
  return Number.parseInt(v, 10);
}

/**
 * The KV key and freshness class for a dashboard read. The API key (`?key=`)
 * never becomes part of a key, and a `to` that means "now" is stored as `now`,
 * so the app's five-minute "now" doesn't make every visit a new question.
 */
export function classifyRead(path: string, search: URLSearchParams, now: number): { key: string; freshness: Freshness } {
  const params = new URLSearchParams(search);
  params.delete("key");
  const from = intParam(params.get("from"));
  const to = intParam(params.get("to"));

  let freshness: Freshness = "open";
  if (ALWAYS_OPEN.test(path)) freshness = "open";
  else if (to !== null && to <= now - CLOSED_AFTER_MS) freshness = "closed";
  else if (path === "/api/summary" || (AGGREGATES.test(path) && from !== null && (to ?? now) - from >= LONG_SPAN_MS)) freshness = "long";

  if (to !== null && to >= now - OPEN_SLACK_MS) params.set("to", "now");
  params.sort();
  const qs = params.toString();
  return { key: qs ? `${path}?${qs}` : path, freshness };
}

interface Versions {
  history: string;
  live: string;
}

async function readVersions(env: Env): Promise<Versions> {
  const { results } = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN (?1, ?2)")
    .bind(VERSION_KEY.history, VERSION_KEY.live)
    .all<{ key: string; value: string | null }>();
  const get = (scope: Scope) => results.find((r) => r.key === VERSION_KEY[scope])?.value ?? "0";
  return { history: get("history"), live: get("live") };
}

/** The current history version (the cleanup pass uses it to tell whether old listens may have changed). */
export async function historyVersion(env: Env): Promise<string> {
  return (await readVersions(env)).history;
}

async function writeVersion(env: Env, scope: Scope, now: number): Promise<void> {
  // The random suffix keeps two bumps in the same millisecond distinct.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(VERSION_KEY[scope], `${now}.${crypto.randomUUID().slice(0, 8)}`, now),
    env.DB.prepare("DELETE FROM sync_state WHERE key = ?1").bind(pendingKey(scope)),
  ]);
}

/**
 * Record that data in `scope` changed, so stored answers that depend on it are
 * recomputed on next use. With `minIntervalMs` the version moves at most that
 * often; a change inside the interval is noted and applied later by
 * flushPendingBumps, so it can't be lost.
 */
export async function bumpDataVersion(env: Env, scope: Scope, now = Date.now(), minIntervalMs = 0): Promise<boolean> {
  if (minIntervalMs > 0) {
    const [version, pending] = await Promise.all([getState(env, VERSION_KEY[scope]), getState(env, pendingKey(scope))]);
    const last = Number.parseInt(version ?? "", 10);
    if (Number.isFinite(last) && now - last < minIntervalMs) {
      if (pending === null) await setState(env, pendingKey(scope), String(now), now);
      return false;
    }
  }
  await writeVersion(env, scope, now);
  return true;
}

/** Apply throttled bumps whose interval has passed. One read when there are none. */
export async function flushPendingBumps(env: Env, now = Date.now(), minIntervalMs = PUMP_BUMP_EVERY_MS): Promise<void> {
  const keys = (["history", "live"] as const).flatMap((s) => [VERSION_KEY[s], pendingKey(s)]);
  const { results } = await env.DB.prepare(`SELECT key, value FROM sync_state WHERE key IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all<{ key: string; value: string | null }>();
  const state = new Map(results.map((r) => [r.key, r.value]));
  for (const scope of ["history", "live"] as const) {
    if (!state.has(pendingKey(scope))) continue;
    const last = Number.parseInt(state.get(VERSION_KEY[scope]) ?? "", 10);
    if (!Number.isFinite(last) || now - last >= minIntervalMs) await writeVersion(env, scope, now);
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface EntryMeta {
  h?: string;
  l?: string;
  /** When the versions were read, i.e. just before the answer was computed. */
  at?: number;
}

/** One request's view of the cache: the versions are read at most once. */
export class ReadCache {
  private versions?: Promise<Versions & { at: number }>;

  constructor(
    private readonly env: Env,
    private readonly waitUntil: (p: Promise<unknown>) => void,
  ) {}

  get enabled(): boolean {
    return Boolean(this.env.CACHE);
  }

  private current(): Promise<Versions & { at: number }> {
    return (this.versions ??= readVersions(this.env).then((v) => ({ ...v, at: Date.now() })));
  }

  private async fullKey(key: string, freshness: Freshness): Promise<string> {
    const code = typeof __SERVER_HASH__ === "string" ? __SERVER_HASH__ : (this.env.CF_VERSION_METADATA?.id ?? "dev");
    // The class is part of the key: an answer stored while its range was still
    // open must not be reused once the range counts as closed.
    const full = `${code}:${freshness}:${key}`;
    return new TextEncoder().encode(full).length > MAX_KEY_BYTES ? `${full.slice(0, 64)}#${await sha256Hex(full)}` : full;
  }

  /** The stored JSON text for `key`, if it is still current for its class. */
  async lookup(key: string, freshness: Freshness = "open"): Promise<string | null> {
    if (!this.env.CACHE) return null;
    const [v, entry] = await Promise.all([
      this.current(),
      this.fullKey(key, freshness).then((k) => this.env.CACHE!.getWithMetadata<EntryMeta>(k, "text")),
    ]);
    const m = entry.metadata;
    if (entry.value === null || !m || m.h !== v.history) return null;
    if (freshness === "closed" || freshness === "stored" || m.l === v.live) return entry.value;
    return freshness === "long" && typeof m.at === "number" && v.at - m.at < LIVE_LAG_MS ? entry.value : null;
  }

  /**
   * Store JSON text for `key` against the versions that lookup() read, i.e.
   * from BEFORE the answer was computed: a write landing mid-computation then
   * leaves the entry already out of date instead of passing off old data as
   * new. Without a prior lookup() nothing is stored. Never throws.
   */
  store(key: string, json: string, freshness: Freshness = "open", ttlS = MAX_AGE_S[freshness]): void {
    const versions = this.versions;
    if (!this.env.CACHE || !versions) return;
    this.waitUntil(
      (async () => {
        const v = await versions;
        const metadata: EntryMeta = { h: v.history, l: v.live, at: v.at };
        await this.env.CACHE!.put(await this.fullKey(key, freshness), json, { expirationTtl: ttlS, metadata });
      })().catch((err) => console.error(`[cache] put ${key} failed`, err)),
    );
  }

  /** `compute()`, or its stored result while still current. */
  async get<T>(key: string, compute: () => Promise<T>, freshness: Freshness = "open"): Promise<T> {
    if (!this.env.CACHE) return compute();
    const hit = await this.lookup(key, freshness);
    if (hit !== null) return JSON.parse(hit) as T;
    const value = await compute();
    this.store(key, JSON.stringify(value), freshness);
    return value;
  }
}
