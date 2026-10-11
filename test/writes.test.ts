// D1 bills every row written (and every index entry with it) and every row
// read, so the paths that run every minute must write nothing when nothing
// changed, and read only the rows they use.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { artistEnrichmentStatement, episodeStatements, playStatements, trackStatements } from "../src/worker/ingest";
import { setState, touchState } from "../src/worker/lib/db";
import { backoffUntil, pumpHasWork, QUEUES, runPump, touchesHistory } from "../src/worker/enrich/pump";
import type { Env, FullArtist, SpotifyEpisode, SpotifyTrack } from "../src/worker/types";
import { testEnv } from "./sqlite";

const DAY = 86_400_000;

function track(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: "1qGAlSpn01ukAedAwdivsi",
    name: "Track One",
    uri: "spotify:track:1qGAlSpn01ukAedAwdivsi",
    duration_ms: 200_000,
    explicit: false,
    popularity: 40,
    external_ids: { isrc: "USAAA0000001" },
    artists: [
      { id: "artistOne0000000000001", name: "Artist One" },
      { id: "artistTwo0000000000002", name: "Artist Two" },
    ],
    album: {
      id: "albumOne00000000000001",
      name: "Album One",
      album_type: "album",
      release_date: "2020-01-01",
      images: [{ url: "https://i.scdn.co/image/a", height: 640, width: 640 }],
      artists: [{ id: "artistOne0000000000001", name: "Artist One" }],
    },
    ...overrides,
  };
}

let env: Env;
let raw: DatabaseSync;

/** Rows changed by everything run inside `fn` (SQLite's own counter). */
async function rowsWritten(fn: () => Promise<unknown>): Promise<number> {
  const total = () => Number((raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  const before = total();
  await fn();
  return total() - before;
}

beforeEach(() => {
  ({ env, raw } = testEnv());
});

describe("collector upserts", () => {
  it("rewrite nothing when the same track is sent again", async () => {
    const now = Date.UTC(2026, 9, 6, 12);
    expect(await rowsWritten(() => env.DB.batch(trackStatements(env, track(), now)))).toBeGreaterThan(0);
    // The player and recently-played re-send it minutes later, with a different raw JSON.
    const again = trackStatements(env, { ...track(), available_markets: ["ES"] } as SpotifyTrack, now + 5 * 60_000);
    expect(await rowsWritten(() => env.DB.batch(again))).toBe(0);
  });

  it("write only the row that changed", async () => {
    const now = Date.UTC(2026, 9, 6, 12);
    await env.DB.batch(trackStatements(env, track(), now));
    const newArt = track({ album: { ...track().album!, images: [{ url: "https://i.scdn.co/image/b", height: 640, width: 640 }] } });
    expect(await rowsWritten(() => env.DB.batch(trackStatements(env, newArt, now + 60_000)))).toBe(1);
    const album = await env.DB.prepare("SELECT image_url FROM albums WHERE id = 'albumOne00000000000001'").first<{ image_url: string }>();
    expect(album?.image_url).toBe("https://i.scdn.co/image/b");
  });

  it("still refresh last_seen_at, but at most daily", async () => {
    const now = Date.UTC(2026, 9, 6, 12);
    await env.DB.batch(trackStatements(env, track(), now));
    expect(await rowsWritten(() => env.DB.batch(trackStatements(env, track(), now + DAY / 2)))).toBe(0);
    expect(await rowsWritten(() => env.DB.batch(trackStatements(env, track(), now + DAY + 1)))).toBe(1);
  });

  it("leave a looked-up artist alone when a top-list snapshot repeats it", async () => {
    const artist: FullArtist = { id: "artistOne0000000000001", name: "Artist One", images: [{ url: "https://i.scdn.co/image/p", height: 640, width: 640 }] };
    await env.DB.batch([artistEnrichmentStatement(env, artist, 1)]);
    expect(await rowsWritten(() => env.DB.batch([artistEnrichmentStatement(env, artist, 2)]))).toBe(0);
    const row = await env.DB.prepare("SELECT enriched_at FROM artists WHERE id = ?").bind(artist.id).first<{ enriched_at: number }>();
    expect(row?.enriched_at).toBe(1);
  });

  it("add a new play once, and only the play when its track is known", async () => {
    const now = Date.UTC(2026, 9, 6, 12);
    await env.DB.batch(trackStatements(env, track(), now));
    const { statements } = playStatements(env, [{ track: track(), played_at: "2026-10-06T12:03:00Z", context: null }], now + 5 * 60_000);
    // plays + the listens row its trigger mirrors in.
    expect(await rowsWritten(() => env.DB.batch(statements))).toBe(2);
    expect(await rowsWritten(() => env.DB.batch(statements))).toBe(0);
  });

  it("rewrite nothing for a repeated podcast episode", async () => {
    const episode: SpotifyEpisode = {
      id: "512ojhOuo1ktJprKbVcKyQ",
      name: "Ep One",
      duration_ms: 600_000,
      show: { id: "showOne000000000000001", name: "Pod Show", publisher: "Pub", images: [] },
    } as SpotifyEpisode;
    await env.DB.batch(episodeStatements(env, episode, 1));
    expect(await rowsWritten(() => env.DB.batch(episodeStatements(env, episode, 2)))).toBe(0);
  });
});

describe("heartbeats", () => {
  it("are written only once the stored one is old enough", async () => {
    const t = 1_000_000;
    expect(await rowsWritten(() => touchState(env, "x", t, 4 * 60_000))).toBe(1);
    expect(await rowsWritten(() => touchState(env, "x", t + 3 * 60_000, 4 * 60_000))).toBe(0);
    expect(await rowsWritten(() => touchState(env, "x", t + 4 * 60_000, 4 * 60_000))).toBe(1);
    expect((await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'x'").first<{ value: string }>())?.value).toBe(String(t + 4 * 60_000));
  });
});

describe("enrichment pump", () => {
  it("does nothing but a heartbeat while nothing is queued", async () => {
    expect(await pumpHasWork(env)).toBe(false);
    const t = Date.UTC(2026, 9, 6, 12);
    expect((await runPump(env, t)).detail).toEqual({ idle: true });
    // The second idle minute writes nothing at all: no lease, no "last run".
    expect(await rowsWritten(() => runPump(env, t + 60_000))).toBe(0);
    expect(await env.DB.prepare("SELECT 1 FROM sync_state WHERE key = 'pump_lease_until'").first()).toBeNull();
  });

  it("reads only queued rows: each queue's index holds exactly what its lane takes", () => {
    for (const [name, q] of Object.entries(QUEUES)) {
      const idx = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(q.index) as { sql: string } | undefined;
      expect(idx?.sql.replace(/\s+/g, " ").split(" WHERE ")[1], name).toBe(q.where);
      const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${q.table} WHERE ${q.where} ORDER BY priority DESC LIMIT 1`).all();
      expect(plan.map((r) => (r as { detail: string }).detail), name).toEqual([`SCAN ${q.table} USING INDEX ${q.index}`]);
    }
  });

  it("leaves work alone while its lane waits out a rate limit", async () => {
    const t = Date.UTC(2026, 9, 7, 6);
    // Queued for Spotify only: no features or Deezer work, no artists.
    await env.DB.prepare(
      "INSERT INTO tracks (id, name, first_seen_at, last_seen_at, features_status) VALUES ('1qGAlSpn01ukAedAwdivsi', 'x', 1, 1, 'reccobeats')",
    ).run();
    expect(await pumpHasWork(env, t)).toBe(true);
    await setState(env, "backoff_spotify", String(t + 3_600_000), t);
    expect(await pumpHasWork(env, t)).toBe(false);
    expect((await runPump(env, t + 60_000)).detail).toEqual({ idle: true });
    expect(await rowsWritten(() => runPump(env, t + 120_000))).toBe(0);
    expect(await pumpHasWork(env, t + 3_600_000)).toBe(true);
  });

  it("waits as long as asked, and longer each time it's refused again", () => {
    const t = Date.UTC(2026, 9, 7, 6);
    const H = 3_600_000;
    expect(backoffUntil(null, 3600, t)).toBe(t + H);
    expect(backoffUntil(null, 20 * 3600, t)).toBe(t + 20 * H); // Retry-After in full, no 1-hour cap
    expect(backoffUntil(null, 0, t)).toBe(t + 30_000);
    // Refused again a minute after an hour's wait ended: two hours, then four.
    expect(backoffUntil({ until: t, since: t - H }, 3600, t + 60_000)).toBe(t + 60_000 + 2 * H);
    expect(backoffUntil({ until: t, since: t - 2 * H }, 60, t + 60_000)).toBe(t + 60_000 + 4 * H);
    // Doubling stops at a day; a refusal long after the last wait starts over.
    expect(backoffUntil({ until: t, since: t - 16 * H }, 60, t + 60_000)).toBe(t + 60_000 + 24 * H);
    expect(backoffUntil({ until: t - 24 * H, since: t - 40 * H }, 60, t)).toBe(t + 60_000);
  });

  it("sees queued work", async () => {
    await env.DB.prepare("INSERT INTO tracks (id, name, first_seen_at, last_seen_at) VALUES ('1qGAlSpn01ukAedAwdivsi', 'x', 1, 1)").run();
    expect(await pumpHasWork(env)).toBe(true);
  });

  it("tells enrichment of old listening from enrichment of new", async () => {
    const now = Date.UTC(2026, 9, 6, 12);
    await env.DB.batch(trackStatements(env, track(), now));
    await env.DB.batch(trackStatements(env, track({ id: "2RUwBfxBoj55yg8Iv4ur1t", uri: "spotify:track:2RUwBfxBoj55yg8Iv4ur1t", artists: [{ id: "artistNew0000000000003", name: "New" }] }), now));
    const { statements } = playStatements(env, [{ track: track(), played_at: "2024-03-10T12:00:00Z", context: null }], now);
    await env.DB.batch(statements);
    const recent = playStatements(env, [{ track: track({ id: "2RUwBfxBoj55yg8Iv4ur1t" }), played_at: new Date(now - 60_000).toISOString(), context: null }], now);
    await env.DB.batch(recent.statements);

    expect(await touchesHistory(env, ["1qGAlSpn01ukAedAwdivsi"], [], now)).toBe(true);
    expect(await touchesHistory(env, ["2RUwBfxBoj55yg8Iv4ur1t"], [], now)).toBe(false);
    expect(await touchesHistory(env, [], ["artistTwo0000000000002"], now)).toBe(true); // credited on the 2024 play
    expect(await touchesHistory(env, [], ["artistNew0000000000003"], now)).toBe(false);
  });
});
