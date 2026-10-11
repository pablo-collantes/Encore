// Dashboard answers stored in KV: served again only while the data they cover
// is unchanged, never to someone who couldn't read them, and never keyed by the
// API key. Past periods survive new live plays; All time folds them in hourly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/app";
import { bumpDataVersion, classifyRead, flushPendingBumps, ReadCache } from "../src/worker/lib/cache";
import { playStatements } from "../src/worker/ingest";
import { foldRollups } from "../src/worker/stats/rollup";
import type { SpotifyTrack } from "../src/worker/types";
import type { Env } from "../src/worker/types";
import { testEnv } from "./sqlite";

const ORIGIN = "http://127.0.0.1:8787";
const ADMIN = { authorization: "Bearer test-key" };
const DAY = 86_400_000;

let env: Env;
let kv: Map<string, { value: string; metadata: unknown }>;
let pending: Promise<unknown>[];

/** The two KV calls the cache makes, over a Map. */
function memoryKV(store: typeof kv): KVNamespace {
  return {
    async getWithMetadata(key: string) {
      const e = store.get(key);
      return { value: e?.value ?? null, metadata: e?.metadata ?? null, cacheStatus: null };
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      store.set(key, { value, metadata: opts?.metadata ?? null });
    },
  } as unknown as KVNamespace;
}

const waitUntil = (p: Promise<unknown>) => void pending.push(p);
const flush = () => Promise.all(pending.splice(0));

async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const ctx = { waitUntil, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    env,
    ctx,
  );
  await flush();
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json, cache: res.headers.get("x-cache"), period: res.headers.get("x-cache-period") };
}

const get = (path: string) => call("GET", path, { headers: ADMIN });

let nextTs = Date.UTC(2024, 0, 1, 12);
async function upload(n: number) {
  const { json } = await call("POST", "/api/imports", { headers: ADMIN, body: { files: [] } });
  const rows = Array.from({ length: n }, () => ({
    ts: (nextTs += 240_000),
    src: "extended",
    kind: "track",
    uri: "spotify:track:4vz3cCxzFkMlHHKHgZmtCw",
    track: "Song",
    artist: "Band",
    ms: 200_000,
  }));
  const res = await call("POST", `/api/imports/${json.id}/rows`, { headers: ADMIN, body: { rows } });
  expect(res.json.accepted).toBe(n);
}

beforeEach(() => {
  env = testEnv().env;
  kv = new Map();
  env.CACHE = memoryKV(kv);
  pending = [];
  nextTs = Date.UTC(2024, 0, 1, 12);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stored dashboard answers", () => {
  it("are answered from KV until the data changes", async () => {
    await upload(1);
    const first = await get("/api/summary?tz=UTC&x=1");
    expect(first.cache).toBe("miss");
    expect(first.json.totalStreams).toBe(1);

    // Same question, parameters in another order.
    const again = await get("/api/summary?x=1&tz=UTC");
    expect(again.cache).toBe("hit");
    expect(again.json).toEqual(first.json);

    await upload(2);
    const after = await get("/api/summary?tz=UTC&x=1");
    expect(after.cache).toBe("miss");
    expect(after.json.totalStreams).toBe(3);
  });

  it("are recomputed after a manual cleanup and after the server code changes", async () => {
    await upload(1);
    await get("/api/history?limit=10");
    expect((await get("/api/history?limit=10")).cache).toBe("hit");

    await call("POST", "/api/maintenance/cleanup", { headers: ADMIN });
    expect((await get("/api/history?limit=10")).cache).toBe("miss");

    env.CF_VERSION_METADATA = { id: "next-deploy", tag: "", timestamp: "" };
    expect((await get("/api/history?limit=10")).cache).toBe("miss");
    expect((await get("/api/history?limit=10")).cache).toBe("hit");
  });

  it("still need a session or the key, and never store the key", async () => {
    await upload(1);
    expect((await call("GET", "/api/summary?tz=UTC&key=test-key")).cache).toBe("miss");
    expect([...kv.keys()].some((k) => k.includes("test-key"))).toBe(false);
    expect((await get("/api/summary?tz=UTC")).cache).toBe("hit");
    expect((await call("GET", "/api/summary?tz=UTC")).status).toBe(401);
    expect((await call("GET", "/api/summary?tz=UTC&key=wrong")).status).toBe(401);
  });

  it("skip live views and failed answers", async () => {
    await upload(1);
    for (const path of ["/api/now", "/api/data/status"]) {
      await get(path);
      expect((await get(path)).cache, path).toBeNull();
    }
    // The Data page's month-by-month coverage (a whole-timeline scan) is stored on its own.
    expect([...kv.keys()].some((k) => k.endsWith(":long:coverage?tz=UTC"))).toBe(true);

    expect((await get("/api/artists/nope")).status).toBe(404);
    expect([...kv.keys()].some((k) => k.includes("/api/artists/nope"))).toBe(false);
  });

  it("for a past year are kept through new live plays, until the history changes", async () => {
    await upload(3);
    const year = `/api/top/tracks?from=${Date.UTC(2024, 0, 1)}&to=${Date.UTC(2025, 0, 1)}&tz=UTC`;
    const first = await get(year);
    expect(first).toMatchObject({ cache: "miss", period: "closed" });
    expect(first.json.items[0].streams).toBe(3);

    await bumpDataVersion(env, "live"); // what a new live play does
    expect((await get(year)).cache).toBe("hit");

    await upload(1); // an import can change any year
    const after = await get(year);
    expect(after.cache).toBe("miss");
    expect(after.json.items[0].streams).toBe(4);
  });

  it("for a range up to now pick up new live plays on the next visit", async () => {
    await upload(1);
    const now = Date.now();
    const lastYear = `/api/top/tracks?from=${now - 365 * DAY}&to=${now}&tz=UTC`;
    expect((await get(lastYear)).period).toBe("open");
    expect((await get(lastYear)).cache).toBe("hit");
    await bumpDataVersion(env, "live");
    expect((await get(lastYear)).cache).toBe("miss");
  });

  it("for All time fold in new live plays at most hourly", async () => {
    await upload(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const allTime = (t: number) => `/api/overview?from=${Date.UTC(2015, 0, 1)}&to=${t}&tz=UTC`;
    expect(await get(allTime(start))).toMatchObject({ cache: "miss", period: "long" });

    await bumpDataVersion(env, "live");
    vi.setSystemTime(start + 50 * 60_000);
    // The app's "now" moved on too; still the same question.
    expect((await get(allTime(start + 50 * 60_000))).cache).toBe("hit");

    vi.setSystemTime(start + 61 * 60_000);
    expect((await get(allTime(start + 61 * 60_000))).cache).toBe("miss");
    expect((await get(allTime(start + 61 * 60_000))).cache).toBe("hit");

    await upload(1); // history changes reach All time straight away
    expect((await get(allTime(start + 61 * 60_000))).cache).toBe("miss");
  });
});

describe("All time and calendar years", () => {
  const year = (y: number) => `from=${Date.UTC(y, 0, 1)}&to=${Date.UTC(y + 1, 0, 1)}&tz=UTC`;
  const livePlay = (iso: string) =>
    playStatements(
      env,
      // Another song: giving the 2024 song its real artist would (rightly) change 2024 too.
      [{ track: { id: "5vz3cCxzFkMlHHKHgZmtCw", name: "Other", uri: "spotify:track:5vz3cCxzFkMlHHKHgZmtCw", duration_ms: 200_000, artists: [{ id: "artistTwo0000000000002", name: "Other Band" }], album: { id: "albumTwo00000000000002", name: "LP 2", images: [] } } as unknown as SpotifyTrack, played_at: iso, context: null }],
      Date.now(),
    ).statements;

  it("are answered from the stored totals, and a year keeps its answer while other years change", async () => {
    env.STATS_TZ = "UTC";
    await upload(3); // 2024
    // Before the first build: read from the listens.
    expect((await get(`/api/top/tracks?${year(2024)}`)).period).toBe("closed");
    await foldRollups(env);

    const y2024 = await get(`/api/top/tracks?${year(2024)}`);
    expect(y2024).toMatchObject({ cache: "miss", period: "stored" });
    expect(y2024.json.items[0].streams).toBe(3);
    const allTime = `/api/overview?from=${Date.UTC(2015, 0, 1)}&to=${Date.now()}&tz=UTC`;
    expect((await get(allTime)).json.totals.streams).toBe(3);

    // Listening in 2025 changes All time and 2025, not 2024.
    await env.DB.batch(livePlay("2025-05-01T12:00:00Z"));
    await foldRollups(env);
    expect((await get(`/api/top/tracks?${year(2024)}`)).cache).toBe("hit");
    const after = await get(allTime);
    expect(after).toMatchObject({ cache: "miss", period: "stored" });
    expect(after.json.totals.streams).toBe(4);

    // Another time zone reads the listens.
    expect((await get(`/api/top/tracks?from=${Date.UTC(2024, 0, 1)}&to=${Date.UTC(2025, 0, 1)}&tz=Europe/Madrid`)).period).not.toBe("stored");
  });
});

describe("History", () => {
  it("pages 50 at a time and stops at 400; the CSV has everything", async () => {
    await upload(450);
    let before: string | null = null;
    let seen = 0;
    let pages = 0;
    let last: any;
    do {
      last = (await get(`/api/history?limit=200${before ? `&before=${before}` : ""}`)).json;
      expect(last.items.length).toBeLessThanOrEqual(50);
      seen += last.items.length;
      before = last.nextBefore;
      pages++;
    } while (before);
    expect({ seen, pages, capped: last.capped }).toEqual({ seen: 400, pages: 8, capped: true });
    // A hand-made cursor can't reach further back either.
    expect((await get(`/api/history?before=${Date.now()}_999999_400`)).json).toMatchObject({ items: [], capped: true });

    const ctx = { waitUntil, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const res = await app.fetch(new Request(`${ORIGIN}/api/history/export`, { headers: ADMIN }), env, ctx);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toMatch(/^ended_at,kind,source,ms_played,track,artists/);
    expect(lines.length).toBe(451);
  });
});

describe("classifyRead", () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const q = (o: Record<string, number | string>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]));

  it("sorts out past, All time and recent ranges", () => {
    const y2024 = { from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1), tz: "UTC" };
    expect(classifyRead("/api/top/artists", q(y2024), now).freshness).toBe("closed");
    expect(classifyRead("/api/history", q(y2024), now).freshness).toBe("closed");
    expect(classifyRead("/api/mood", q({ from: Date.UTC(2015, 0, 1), to: now }), now).freshness).toBe("long");
    expect(classifyRead("/api/summary", q({ tz: "UTC" }), now).freshness).toBe("long");
    expect(classifyRead("/api/top/artists", q({ from: now - 365 * DAY, to: now }), now).freshness).toBe("open");
    expect(classifyRead("/api/history", q({ from: Date.UTC(2015, 0, 1), to: now }), now).freshness).toBe("open");
    // Up to yesterday: live plays could still be arriving.
    expect(classifyRead("/api/clock", q({ from: now - 30 * DAY, to: now - DAY }), now).freshness).toBe("open");
    // Entity pages show all-time ranks whatever the range.
    expect(classifyRead("/api/artists/abc", q(y2024), now).freshness).toBe("open");
  });

  it("treats a recent `to` as now and drops the API key", () => {
    const a = classifyRead("/api/clock", q({ tz: "UTC", to: now + 4 * 60_000, from: 5, key: "secret" }), now);
    const b = classifyRead("/api/clock", q({ from: 5, to: now - 3 * 60_000, tz: "UTC" }), now);
    expect(a.key).toBe("/api/clock?from=5&to=now&tz=UTC");
    expect(b.key).toBe(a.key);
    expect(classifyRead("/api/clock", q({ from: 5, to: now - DAY }), now).key).toBe(`/api/clock?from=5&to=${now - DAY}`);
  });
});

describe("ReadCache", () => {
  it("labels an answer with the versions read before computing it", async () => {
    for (const scope of ["history", "live"] as const) {
      const reader = new ReadCache(env, waitUntil);
      expect(await reader.lookup(`k-${scope}`)).toBeNull();
      await bumpDataVersion(env, scope); // data changed while the answer was being computed
      reader.store(`k-${scope}`, '"stale"');
      await flush();
      expect(await new ReadCache(env, waitUntil).lookup(`k-${scope}`)).toBeNull();
    }

    const fresh = new ReadCache(env, waitUntil);
    expect(await fresh.lookup("k")).toBeNull();
    fresh.store("k", '"fresh"');
    await flush();
    expect(await new ReadCache(env, waitUntil).lookup("k")).toBe('"fresh"');
  });

  it("keeps an answer stored while its range was open out of the closed class", async () => {
    const open = new ReadCache(env, waitUntil);
    await open.lookup("k", "open");
    open.store("k", '"open"', "open");
    await flush();
    expect(await new ReadCache(env, waitUntil).lookup("k", "closed")).toBeNull();
  });

  it("throttles bumps without losing them", async () => {
    const version = async () => (await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'data_version'").first<{ value: string }>())?.value;
    const t0 = 1_000_000;
    expect(await bumpDataVersion(env, "history", t0)).toBe(true);
    const v0 = await version();
    expect(await bumpDataVersion(env, "history", t0 + 60_000, 30 * 60_000)).toBe(false);
    await flushPendingBumps(env, t0 + 10 * 60_000, 30 * 60_000);
    expect(await version()).toBe(v0);
    // No further change came along, but the one inside the interval still lands.
    await flushPendingBumps(env, t0 + 31 * 60_000, 30 * 60_000);
    expect(await version()).not.toBe(v0);
    const v1 = await version();
    await flushPendingBumps(env, t0 + 90 * 60_000, 30 * 60_000);
    expect(await version()).toBe(v1);
    expect(await bumpDataVersion(env, "history", t0 + 120 * 60_000, 30 * 60_000)).toBe(true);
  });
});
