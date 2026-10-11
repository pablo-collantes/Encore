// The stored All time / yearly totals (stats/rollup.ts) must give exactly the
// answers that reading the listens gives (stats/queries.ts, details.ts), after
// the first build and after every kind of change the app makes: new plays,
// imports and their deletion, duplicates, merged versions, and enrichment
// arriving or changing (artists, albums, genres, audio features). And a fold
// must never read the timeline: only the listens that changed.

import { beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { ImportRow } from "../src/shared/exportFormats";
import { runCleanup } from "../src/worker/cleanup";
import { insertImportRows } from "../src/worker/importer";
import { playStatements } from "../src/worker/ingest";
import { ReadCache } from "../src/worker/lib/cache";
import * as D from "../src/worker/stats/details";
import { storedPeriodFor, type StoredPeriod } from "../src/worker/stats/period";
import * as Q from "../src/worker/stats/queries";
import { foldRollups, foldStatements, localMidnight, rollupBacklog, STATE_ROLL_DEF } from "../src/worker/stats/rollup";
import * as S from "../src/worker/stats/stored";
import type { Bucket, GenreSource } from "../src/shared/api";
import type { Env, SpotifyTrack } from "../src/worker/types";
import { testEnv } from "./sqlite";

const TZ = "America/Chicago";
const NOW = Date.UTC(2026, 5, 15, 12);
const YEARS = [2022, 2023, 2024, 2025, 2026];

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const id = (n: number, tag = "T") => `${tag}${String(n).padStart(21, "0")}`;
const TRACKS = Array.from({ length: 9 }, (_, i) => ({
  id: id(i + 1),
  name: `Song ${i + 1}`,
  artist: `Artist ${(i % 4) + 1}`,
  album: `Album ${(i % 3) + 1}`,
}));
const EPISODES = Array.from({ length: 4 }, (_, i) => ({ id: id(i + 1, "E"), name: `Episode ${i + 1}`, show: `Show ${(i % 2) + 1}` }));
const PLATFORMS = ["Android OS 14 API 34 (Google, Pixel 8)", "iOS 17.2 (iPhone15,2)", "Windows 10 (10.0.19045; x64)", null];
const COUNTRIES = ["US", "ES", "MX", null];
const STARTS = ["clickrow", "trackdone", "fwdbtn", null];
const ENDS = ["trackdone", "fwdbtn", "endplay", null];

// Moments where local days, years and offsets change in Chicago.
const EDGES = [
  "2023-01-01T05:59:00Z", "2023-01-01T06:01:00Z", // New Year (local midnight = 06:00Z)
  "2023-03-12T07:59:00Z", "2023-03-12T08:01:00Z", // DST starts
  "2023-11-05T06:30:00Z", "2023-11-05T07:30:00Z", // DST ends (01:30 local twice)
  "2024-12-31T23:50:00Z", "2025-01-01T05:58:00Z", "2025-01-01T06:02:00Z",
].map((s) => Date.parse(s));

function extendedRows(n: number, seed: number, from: number, to: number): ImportRow[] {
  const r = prng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const rows: ImportRow[] = [];
  for (let i = 0; i < n; i++) {
    const ts = i < EDGES.length && seed === 1 ? EDGES[i]! : Math.floor(from + r() * (to - from));
    const common = {
      ts,
      src: "extended" as const,
      ms: Math.floor(5_000 + r() * 300_000),
      platform: pick(PLATFORMS),
      country: pick(COUNTRIES),
      reasonStart: pick(STARTS),
      reasonEnd: pick(ENDS),
      shuffle: r() < 0.3 ? null : r() < 0.5,
      skipped: r() < 0.3 ? null : r() < 0.2,
      offline: r() < 0.5 ? null : r() < 0.1,
    };
    if (r() < 0.06) {
      const e = pick(EPISODES);
      rows.push({ ...common, kind: "episode", uri: `spotify:episode:${e.id}`, episode: e.name, show: e.show });
    } else {
      const t = pick(TRACKS);
      rows.push({ ...common, kind: "track", uri: `spotify:track:${t.id}`, track: t.name, artist: t.artist, album: t.album });
    }
  }
  return rows;
}

function spotifyTrack(i: number): SpotifyTrack {
  const t = TRACKS[i]!;
  const artist = { id: id((i % 4) + 1, "A"), name: t.artist };
  return {
    id: t.id,
    name: t.name,
    uri: `spotify:track:${t.id}`,
    duration_ms: 150_000 + i * 10_000,
    explicit: false,
    popularity: 10,
    external_ids: { isrc: `US${String(i).padStart(10, "0")}` },
    artists: i === 0 ? [artist, { id: id(9, "A"), name: "Guest Artist" }] : [artist],
    album: { id: id((i % 3) + 1, "L"), name: t.album, album_type: "album", release_date: "2020-01-01", images: [], artists: [artist] },
  } as SpotifyTrack;
}

let importN = 0;
async function importRows(env: Env, rows: ImportRow[]): Promise<string> {
  const importId = `imp${++importN}`;
  await env.DB.prepare("INSERT INTO imports (id, created_at) VALUES (?, 1)").bind(importId).run();
  await insertImportRows(env, importId, rows, NOW);
  return importId;
}

// ---------------------------------------------------------------------------
// Comparing stored answers with answers read from the listens
// ---------------------------------------------------------------------------

/** Equal, except numbers: integers within 1 (rounded sums of shares), fractions within 1e-6. */
function close(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof actual === "number" && typeof expected === "number") {
    const tol = Number.isInteger(actual) && Number.isInteger(expected) ? 1 : 1e-6 * Math.max(1, Math.abs(expected));
    if (Math.abs(actual - expected) > tol) throw new Error(`${path}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) throw new Error(`${path}: length ${actual.length} != ${expected.length}\n${JSON.stringify(actual).slice(0, 400)}\n${JSON.stringify(expected).slice(0, 400)}`);
    actual.forEach((a, i) => close(a, expected[i], `${path}[${i}]`));
    return;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const k of keys) close((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  if (actual !== expected) throw new Error(`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

const byKey = <T,>(xs: T[], key: (x: T) => string) => Object.fromEntries(xs.map((x) => [key(x), x]));

function params(r: Q.Range): URLSearchParams {
  return new URLSearchParams({ from: String(r.from), to: String(r.to), tz: r.tz });
}

async function periodOf(env: Env, r: Q.Range): Promise<StoredPeriod> {
  const sp = await storedPeriodFor(env, "/api/overview", params(r), NOW);
  expect(sp, `stored period for ${r.from}..${r.to}`).not.toBeNull();
  return sp!;
}

const noCache = (env: Env) => new ReadCache(env, () => {});

async function compareAll(env: Env, label: string) {
  const first = (await env.DB.prepare("SELECT MIN(ts) AS t FROM listens WHERE dup_of IS NULL").first<{ t: number }>())!.t;
  const ranges: [string, Q.Range][] = [
    ["all", { from: first - 3_600_000, to: NOW, tz: TZ }],
    ...YEARS.map((y): [string, Q.Range] => [String(y), { from: localMidnight(TZ, y, 1, 1), to: localMidnight(TZ, y + 1, 1, 1), tz: TZ }]),
  ];
  for (const [name, r] of ranges) {
    const at = `${label} / ${name}`;
    const sp = await periodOf(env, r);
    try {
      close((await S.overview(env, sp, noCache(env))).totals, (await Q.overview(env, r)).totals, "totals");
      for (const b of ["day", "week", "month", "year"] as Bucket[]) close(await S.timeline(env, sp, b), await Q.timeline(env, r, b), `timeline:${b}`);

      for (const sort of ["ms", "plays", "skips"]) {
        const o = { limit: 500, offset: 0, sort };
        const [st, rt] = [await S.topTracks(env, sp, o), await Q.topTracks(env, r, o)];
        expect(st.total).toBe(rt.total);
        close(byKey(st.items, (x) => x.id), byKey(rt.items.map((x, i) => ({ ...x, rank: st.items.find((y) => y.id === x.id)?.rank ?? i })), (x) => x.id), "tracks");
      }
      const [sa, ra] = [await S.topArtists(env, sp, { limit: 500, offset: 0 }), await Q.topArtists(env, r, { limit: 500, offset: 0 })];
      expect(sa.total).toBe(ra.total);
      close(byKey(sa.items, (x) => x.id), byKey(ra.items.map((x) => ({ ...x, rank: sa.items.find((y) => y.id === x.id)?.rank })), (x) => x.id), "artists");
      const [sl, rl] = [await S.topAlbums(env, sp, { limit: 500, offset: 0 }), await Q.topAlbums(env, r, { limit: 500, offset: 0 })];
      expect(sl.total).toBe(rl.total);
      close(byKey(sl.items, (x) => x.id), byKey(rl.items.map((x) => ({ ...x, rank: sl.items.find((y) => y.id === x.id)?.rank })), (x) => x.id), "albums");
      const artist = id(2, "A");
      close(
        byKey((await S.topAlbums(env, sp, { limit: 50, offset: 0, artist })).items, (x) => x.id),
        byKey((await Q.topAlbums(env, r, { limit: 50, offset: 0, artist })).items, (x) => x.id),
        "albums by artist",
      );
      const q = { limit: 50, offset: 0, q: "song 3" };
      expect((await S.topTracks(env, sp, q)).total).toBe((await Q.topTracks(env, r, q)).total);

      for (const source of ["deezer", "musicbrainz"] as GenreSource[]) {
        const [sg, rg] = [await S.topGenres(env, sp, source, 50), await Q.topGenres(env, r, source, 50)];
        close(sg.coverage, rg.coverage, `${source} coverage`);
        const strip = (g: (typeof sg.items)[number]) => ({ ...g, topArtists: g.topArtists.length });
        close(byKey(sg.items.map(strip), (g) => g.genre), byKey(rg.items.map(strip), (g) => g.genre), `${source} genres`);
        for (const b of ["week", "month", "year"] as Bucket[]) {
          const [st, rt] = [await S.genreTimeline(env, sp, source, b, 8), await Q.genreTimeline(env, r, source, b, 8)];
          expect(new Set(st.genres)).toEqual(new Set(rt.genres));
          close(byKey(st.points, (p) => p.t), byKey(rt.points, (p) => p.t), `${source} timeline:${b}`);
        }
      }

      close(await S.clock(env, sp), await Q.clock(env, r), "clock");

      for (const b of ["week", "month", "year"] as Bucket[]) {
        const [sm, rm] = [await S.mood(env, sp, b), await Q.mood(env, r, b)];
        close({ ...sm, tracks: byKey(sm.tracks, (t) => t.id), extremes: null }, { ...rm, tracks: byKey(rm.tracks, (t) => t.id), extremes: null }, `mood:${b}`);
      }

      const [sp2, rp] = [await S.podcasts(env, sp), await D.podcasts(env, r)];
      close(byKey(sp2.shows, (x) => x.id), byKey(rp.shows, (x) => x.id), "shows");
      close(byKey(sp2.episodes, (x) => x.id), byKey(rp.episodes, (x) => x.id), "episodes");

      for (const b of ["week", "month", "year"] as Bucket[]) {
        const [sh, rh] = [await S.habits(env, sp, b, NOW), await D.habits(env, r, b, NOW)];
        // Sessions: the archive's own vs cut at the range edges; equal for All time.
        if (name !== "all") {
          sh.sessions = rh.sessions;
        }
        close(
          { ...sh, platforms: byKey(sh.platforms, (x) => x.name), countries: byKey(sh.countries, (x) => x.code), reasonsStart: byKey(sh.reasonsStart, (x) => x.reason), reasonsEnd: byKey(sh.reasonsEnd, (x) => x.reason) },
          { ...rh, platforms: byKey(rh.platforms, (x) => x.name), countries: byKey(rh.countries, (x) => x.code), reasonsStart: byKey(rh.reasonsStart, (x) => x.reason), reasonsEnd: byKey(rh.reasonsEnd, (x) => x.reason) },
          `habits:${b}`,
        );
        // Discoveries for any range come from the stored first listens too.
        close((await D.habits(env, r, b, NOW, true)).discoveries, rh.discoveries, `habits discoveries:${b}`);
      }
    } catch (err) {
      throw new Error(`${at}: ${(err as Error).message}`);
    }
  }
  close(await S.summary(env), await Q.summary(env, TZ), `${label} / summary`);
  close(await S.coverage(env), (await D.dataStatus(env, noCache(env), TZ, null, {} as never, {} as never)).coverage, `${label} / coverage`);
}

async function fold(env: Env, opts: { logChunk?: number } = {}) {
  const result = await foldRollups(env, { now: NOW, ...opts });
  expect(result.behind).toBe(0);
  for (const t of ["roll_log", "roll_dirty", "roll_old_ta", "roll_old_tg", "roll_old_tags", "roll_old_feat", "roll_sess_dirty"]) {
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n, t).toBe(0);
  }
  return result;
}

const ROLL_TABLES: [string, string][] = [
  ["roll_days", "day"],
  ["roll_songs", "song_id, p"],
  ["roll_artists", "artist_id, p"],
  ["roll_albums", "album_id, p"],
  ["roll_episodes", "episode_id, p"],
  ["roll_shows", "show_id, p"],
  ["roll_facts", "p, k"],
  ["roll_gb", "src, genre, b"],
  ["roll_garts", "p, src, genre, artist_id"],
  ["roll_sessions", "start"],
];

function snapshot(raw: DatabaseSync): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [t, order] of ROLL_TABLES) {
    const rows = raw.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as Record<string, unknown>[];
    // Rows a removal left at (almost) nothing are harmless leftovers of the adding-up.
    out[t] = rows
      .map((r) => ({ ...r }))
      .filter((r) => !(t === "roll_facts" || t === "roll_gb") || Math.abs(Number(r.ms)) > 1e-6 || Math.abs(Number(r.n ?? 0)) > 1e-6);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("stored totals", () => {
  let env: Env;
  let raw: DatabaseSync;
  let accountImport = "";

  beforeAll(async () => {
    ({ env, raw } = testEnv());
    env.STATS_TZ = TZ;
    await importRows(env, extendedRows(700, 1, Date.parse("2022-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z")));
    // Account data: copies of some extended streams (hidden as duplicates) and some of its own.
    const copies = (await env.DB.prepare(
      `SELECT l.ts, l.ms_played AS ms, t.name AS track FROM listens l JOIN tracks t ON t.id = l.track_id
        WHERE l.kind = 'track' ORDER BY l.id LIMIT 40`,
    ).all<{ ts: number; ms: number; track: string }>()).results;
    accountImport = await importRows(env, [
      ...copies.map((c): ImportRow => ({ ts: Math.floor(c.ts / 60_000) * 60_000, src: "account", kind: "track", track: c.track, artist: TRACKS.find((t) => t.name === c.track)!.artist, ms: c.ms })),
      ...extendedRows(30, 2, Date.parse("2024-06-01T00:00:00Z"), Date.parse("2025-06-01T00:00:00Z")).map((x): ImportRow => ({ ts: Math.floor(x.ts / 60_000) * 60_000, src: "account", kind: x.kind, track: x.track, artist: x.artist, episode: x.episode, show: x.show, ms: x.ms })),
    ]);
    await runCleanup(env, { full: true }, NOW);
  });

  it("builds once, then matches reading the listens", async () => {
    expect((await rollupBacklog(env)).built).toBe(false);
    expect(await storedPeriodFor(env, "/api/overview", params({ from: localMidnight(TZ, 2024, 1, 1), to: localMidnight(TZ, 2025, 1, 1), tz: TZ }), NOW)).toBeNull();
    const built = await fold(env);
    expect(built).toMatchObject({ rebuilt: true, ready: true });
    expect(built.sessions).toBeGreaterThan(0);
    await compareAll(env, "built");
  });

  it("takes in new live plays, with their real artists and albums", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      track: spotifyTrack(i % TRACKS.length),
      played_at: new Date(Date.parse("2026-02-01T10:00:00Z") + i * 3 * 60_000 + (i > 6 ? 5 * 86_400_000 : 0)).toISOString(),
      context: null,
    }));
    await env.DB.batch(playStatements(env, items, NOW).statements);
    await runCleanup(env, {}, NOW); // merges the name-only artists/albums into the real ones
    await fold(env);
    await compareAll(env, "live plays");
  });

  it("moves listening between genres, moods and artists as enrichment arrives and changes", async () => {
    const sql = (s: string) => env.DB.prepare(s).run();
    for (const [i, genres] of [[0, ["Pop"]], [1, ["Pop", "Rock"]], [2, ["Rock"]], [4, ["Jazz", "Pop", "Electro"]]] as const) {
      for (const g of genres) await sql(`INSERT INTO track_genres (track_id, genre) VALUES ('${TRACKS[i]!.id}', '${g}')`);
    }
    const artists = (await env.DB.prepare("SELECT id FROM artists ORDER BY id").all<{ id: string }>()).results.map((a) => a.id);
    await sql(`INSERT INTO artist_tags (artist_id, tag, votes) VALUES ('${artists[0]}', 'indie pop', 3), ('${artists[0]}', 'shoegaze', 1), ('${artists[1]}', 'post-punk', 2)`);
    for (const [i, e, v, t] of [[0, 0.8, 0.6, 120], [1, 0.3, 0.2, 90], [2, 0.55, 0.7, 175], [3, 0.95, 0.9, 210], [5, 0.1, 0.45, 0]] as const) {
      await sql(`INSERT INTO audio_features (track_id, source, energy, valence, danceability, tempo, loudness, fetched_at)
                 VALUES ('${TRACKS[i]!.id}', 'reccobeats', ${e}, ${v}, 0.5, ${t}, -7, 1)`);
    }
    await fold(env);
    await compareAll(env, "enrichment");

    // Then it changes: a genre dropped and another added, votes moved, features re-analysed or gone.
    await sql(`DELETE FROM track_genres WHERE track_id = '${TRACKS[1]!.id}' AND genre = 'Rock'`);
    await sql(`INSERT INTO track_genres (track_id, genre) VALUES ('${TRACKS[3]!.id}', 'Rock'), ('${TRACKS[1]!.id}', 'Soul')`);
    await sql(`UPDATE artist_tags SET votes = 5 WHERE tag = 'shoegaze'`);
    await sql(`DELETE FROM artist_tags WHERE tag = 'post-punk'`);
    await sql(`INSERT INTO artist_tags (artist_id, tag, votes) VALUES ('${artists[2]}', 'post-punk', 4)`);
    await sql(`UPDATE audio_features SET energy = 0.4, valence = 0.95 WHERE track_id = '${TRACKS[0]!.id}'`);
    await sql(`DELETE FROM audio_features WHERE track_id = '${TRACKS[2]!.id}'`);
    // A track credited to one more artist, and moved to another album.
    await sql(`INSERT INTO track_artists (track_id, artist_id, position) VALUES ('${TRACKS[4]!.id}', '${id(9, "A")}', 1)`);
    await sql(`UPDATE tracks SET album_id = (SELECT album_id FROM tracks WHERE id = '${TRACKS[0]!.id}') WHERE id = '${TRACKS[5]!.id}'`);
    await sql(`UPDATE episodes SET show_id = (SELECT show_id FROM episodes WHERE id = '${EPISODES[0]!.id}') WHERE id = '${EPISODES[1]!.id}'`);
    await fold(env);
    await compareAll(env, "enrichment changed");
  });

  it("follows merged versions, deleted imports and newly hidden duplicates", async () => {
    // Two ids for the same recording: their listens are counted as one song.
    await env.DB.prepare(`UPDATE tracks SET isrc = 'USSAME000001' WHERE id IN ('${TRACKS[6]!.id}', '${TRACKS[7]!.id}')`).run();
    await runCleanup(env, { full: true }, NOW);
    // A few changed listens per fold, as with a big import's worth on D1.
    await fold(env, { logChunk: 7 });
    await compareAll(env, "versions merged");

    await env.DB.prepare("DELETE FROM listens WHERE import_id = ?").bind(accountImport).run();
    await runCleanup(env, { full: true }, NOW);
    const logged = (await env.DB.prepare("SELECT COUNT(*) AS n FROM roll_log").first<{ n: number }>())!.n;
    const deleted = await fold(env, { logChunk: 7 });
    expect(deleted.folds).toBe(Math.ceil(logged / 7));
    await compareAll(env, "import deleted");

    // An extended export that covers the live plays: those become duplicates.
    const live = (await env.DB.prepare("SELECT ts, track_id FROM listens WHERE source = 'live' AND dup_of IS NULL").all<{ ts: number; track_id: string }>()).results;
    await importRows(
      env,
      live.slice(0, 5).map((l): ImportRow => {
        const t = TRACKS.find((x) => x.id === l.track_id)!;
        return { ts: l.ts + 2_000, src: "extended", kind: "track", uri: `spotify:track:${t.id}`, track: t.name, artist: t.artist, ms: 100_000 };
      }),
    );
    await runCleanup(env, { from: live[0]!.ts - 86_400_000, to: live[4]!.ts + 86_400_000 }, NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listens WHERE source = 'live' AND dup_of IS NOT NULL").first<{ n: number }>())!.n).toBe(5);
    await fold(env);
    await compareAll(env, "live hidden");
  });

  it("ends up exactly where a build from scratch does", async () => {
    const incremental = snapshot(raw);
    await env.DB.prepare(`UPDATE sync_state SET value = 'old' WHERE key = '${STATE_ROLL_DEF}'`).run();
    const rebuilt = await fold(env);
    expect(rebuilt.rebuilt).toBe(true);
    const fresh = snapshot(raw);
    for (const [t] of ROLL_TABLES) close(incremental[t], fresh[t], t);
  });

  it("answers All time and a year without scanning the listens or the stored tables", async () => {
    const captured: [string, unknown[]][] = [];
    const prepare = raw.prepare.bind(raw);
    (raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const st = prepare(sql);
      const all = st.all.bind(st);
      (st as unknown as { all: (...b: unknown[]) => unknown }).all = (...b: unknown[]) => {
        captured.push([sql, b]);
        return all(...(b as never[]));
      };
      return st;
    };
    try {
      const first = (await env.DB.prepare("SELECT MIN(ts) AS t FROM listens WHERE dup_of IS NULL").first<{ t: number }>())!.t;
      for (const r of [{ from: first - 1, to: NOW, tz: TZ }, { from: localMidnight(TZ, 2024, 1, 1), to: localMidnight(TZ, 2025, 1, 1), tz: TZ }]) {
        const sp = await periodOf(env, r);
        const bucket: Bucket = sp.p === 0 ? "year" : "week";
        await S.overview(env, sp, noCache(env));
        await S.timeline(env, sp, bucket);
        await S.topTracks(env, sp, { limit: 50, offset: 0 });
        await S.topTracks(env, sp, { limit: 50, offset: 50, sort: "plays" });
        await S.topArtists(env, sp, { limit: 50, offset: 0 });
        await S.topAlbums(env, sp, { limit: 50, offset: 0 });
        for (const source of ["deezer", "musicbrainz"] as GenreSource[]) {
          await S.topGenres(env, sp, source, 30);
          await S.genreTimeline(env, sp, source, bucket, 8);
        }
        await S.clock(env, sp);
        await S.mood(env, sp, bucket);
        await S.podcasts(env, sp);
        await S.habits(env, sp, bucket, NOW);
      }
      await S.summary(env);
    } finally {
      (raw as unknown as { prepare: unknown }).prepare = prepare;
    }
    const scans: string[] = [];
    for (const [sql, binds] of captured) {
      if (sql.startsWith("SELECT MIN(ts) AS t")) continue; // the test's own
      for (const p of raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[]) {
        if (/\bSCAN (\w+ AS )?(l|listens|roll_\w+|tracks|artists|albums|track_artists|track_genres|artist_tags|audio_features|episodes|shows)\b/.test(p.detail) && !/\bSCAN roll_pv\b/.test(p.detail)
          // The longest session: an index walk that stops at the first row (LIMIT 1).
          && !/SCAN roll_sessions USING INDEX idx_roll_sessions_ms/.test(p.detail)) {
          scans.push(`${p.detail} in: ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
        }
      }
    }
    expect(scans).toEqual([]);
  });

  it("folds a new play without reading the rest of the timeline", async () => {
    await env.DB.batch(playStatements(env, [{ track: spotifyTrack(3), played_at: "2026-03-01T12:00:00Z", context: null }], NOW).statements);
    await env.DB.prepare(`UPDATE listens SET dup_of = id WHERE id = (SELECT MIN(id) FROM listens)`).run();
    await env.DB.prepare(`INSERT INTO track_genres (track_id, genre) VALUES ('${TRACKS[8]!.id}', 'Folk')`).run();
    const top = (await env.DB.prepare("SELECT MAX(id) AS n FROM listens").first<{ n: number }>())!.n;
    const scans: string[] = [];
    for (const sql of foldStatements(TZ, NOW)) {
      const params = Math.max(0, ...[...sql.matchAll(/\?(\d)/g)].map((m) => Number(m[1])));
      const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...[top, NOW, Number.MAX_SAFE_INTEGER].slice(0, params)) as { detail: string }[];
      for (const p of plan) {
        // A scan of a partial "empty rows" index reads only rows a fold just emptied.
        if (/USING (COVERING )?INDEX idx_roll_\w+_empty\b/.test(p.detail)) continue;
        if (/\bSCAN (l|listens|roll_songs|roll_artists|roll_albums|roll_episodes|roll_shows|roll_days|roll_facts|roll_gb|roll_garts|roll_sessions|track_artists|tracks|episodes|artist_tags|track_genres|audio_features)\b/.test(p.detail)) scans.push(`${p.detail} in: ${sql.slice(0, 120)}`);
        // Searching a stored table by period alone walks every song of that year:
        // no SCAN in the plan, but it made each fold quadratic (30 s on D1).
        if (/^SEARCH \w+ USING (COVERING )?INDEX idx_roll_\w+ \(p=\?\)/.test(p.detail)) scans.push(`${p.detail} in: ${sql.slice(0, 120)}`);
      }
    }
    expect(scans).toEqual([]);
    await fold(env);
    await compareAll(env, "one play");
  });
});
