import { describe, expect, it } from "vitest";
import {
  boolInt,
  episodeKey,
  fnv1aHex,
  parsePlayedAt,
  pickImage,
  playStatements,
  releaseYear,
  sampleChanged,
  toSampleCandidate,
  trackKey,
  type LastSample,
  type SampleCandidate,
} from "../src/worker/ingest";
import type { Env, PlaybackState, PlayHistoryItem, SpotifyTrack } from "../src/worker/types";

/**
 * Minimal D1 stand-in that records the SQL and bindings it is handed, so the
 * statement builders can be asserted on without a database.
 */
interface Recorded {
  sql: string;
  binds: unknown[];
}

function fakeEnv(): { env: Env; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            const entry = { sql, binds };
            recorded.push(entry);
            return entry;
          },
        };
      },
    },
  } as unknown as Env;
  return { env, recorded };
}

function track(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: "t100",
    name: "Test Song",
    uri: "spotify:track:t100",
    duration_ms: 200_000,
    explicit: false,
    popularity: 42,
    track_number: 3,
    disc_number: 1,
    external_ids: { isrc: "USABC1234567" },
    artists: [
      { id: "a1", name: "Primary Artist" },
      { id: "a2", name: "Featured Artist" },
    ],
    album: {
      id: "alb1",
      name: "Test Album",
      album_type: "album",
      release_date: "2019-07-15",
      release_date_precision: "day",
      total_tracks: 10,
      images: [{ url: "https://img/large.jpg", height: 640, width: 640 }],
      artists: [{ id: "a1", name: "Primary Artist" }],
    },
    ...overrides,
  };
}

describe("pure helpers", () => {
  it("fnv1aHex is deterministic and 8 hex chars", () => {
    expect(fnv1aHex("abc")).toBe(fnv1aHex("abc"));
    expect(fnv1aHex("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1aHex("abc")).not.toBe(fnv1aHex("abd"));
  });

  it("trackKey uses the Spotify id when present", () => {
    expect(trackKey(track())).toBe("t100");
  });

  it("trackKey mints a stable synthetic id for local files", () => {
    const local = track({ id: null, is_local: true });
    const key = trackKey(local);
    expect(key).toMatch(/^local:[0-9a-f]{8}$/);
    // Same metadata must always map to the same row.
    expect(trackKey(track({ id: null, is_local: true }))).toBe(key);
    // Different duration is a different file.
    expect(trackKey(track({ id: null, is_local: true, duration_ms: 1 }))).not.toBe(key);
  });

  it("trackKey returns null when there is nothing to key on", () => {
    expect(trackKey({ id: null, name: "" })).toBeNull();
  });

  it("episodeKey mirrors trackKey behaviour", () => {
    expect(episodeKey({ id: "ep1", name: "Ep" })).toBe("ep1");
    expect(episodeKey({ id: null, name: "Ep", duration_ms: 5 })).toMatch(/^local:[0-9a-f]{8}$/);
  });

  it("parsePlayedAt handles ISO strings and rejects junk", () => {
    expect(parsePlayedAt("2025-08-12T12:00:00Z")).toBe(1754999999000 + 1000);
    expect(parsePlayedAt("2025-08-12T12:00:00.500Z")).toBe(1755000000500);
    expect(parsePlayedAt("not a date")).toBeNull();
    expect(parsePlayedAt(undefined)).toBeNull();
    expect(parsePlayedAt(null)).toBeNull();
  });

  it("releaseYear copes with every precision Spotify returns", () => {
    expect(releaseYear("2019")).toBe(2019);
    expect(releaseYear("2019-07")).toBe(2019);
    expect(releaseYear("2019-07-15")).toBe(2019);
    expect(releaseYear(undefined)).toBeNull();
    expect(releaseYear("")).toBeNull();
  });

  it("pickImage takes the largest (first) image", () => {
    expect(pickImage([{ url: "a", height: 640, width: 640 }, { url: "b", height: 64, width: 64 }])).toBe("a");
    expect(pickImage([])).toBeNull();
    expect(pickImage(undefined)).toBeNull();
  });

  it("boolInt maps to SQLite integers and preserves null", () => {
    expect(boolInt(true)).toBe(1);
    expect(boolInt(false)).toBe(0);
    expect(boolInt(undefined)).toBeNull();
    expect(boolInt(null)).toBeNull();
  });
});

describe("sampleChanged", () => {
  const base: LastSample = {
    sampled_at: 1_000_000,
    item_type: "track",
    track_id: "t1",
    episode_id: null,
    item_name: "Song",
    progress_ms: 30_000,
    is_playing: 1,
    device_id: "d1",
    context_uri: "spotify:playlist:p1",
  };

  const next = (overrides: Partial<SampleCandidate> = {}): SampleCandidate => ({
    sampled_at: base.sampled_at + 60_000,
    item_type: "track",
    item_id: "t1",
    item_name: "Song",
    progress_ms: 90_000, // 30s + 60s elapsed = exactly on track
    is_playing: true,
    device_id: "d1",
    context_uri: "spotify:playlist:p1",
    ...overrides,
  });

  it("always writes the first sample", () => {
    expect(sampleChanged(null, next()).changed).toBe(true);
    expect(sampleChanged(null, next()).reason).toBe("first-sample");
  });

  it("skips a mid-track tick that is progressing normally", () => {
    const result = sampleChanged(base, next());
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("unchanged");
  });

  it("writes when the track changes", () => {
    expect(sampleChanged(base, next({ item_id: "t2", item_name: "Other" }))).toEqual({
      changed: true,
      reason: "item-changed",
    });
  });

  it("writes when playback is paused", () => {
    expect(sampleChanged(base, next({ is_playing: false })).reason).toBe("play-state-changed");
  });

  it("writes when the device changes", () => {
    expect(sampleChanged(base, next({ device_id: "d2" })).reason).toBe("device-changed");
  });

  it("writes when the playback context changes", () => {
    expect(sampleChanged(base, next({ context_uri: "spotify:album:x" })).reason).toBe("context-changed");
  });

  it("detects a seek as a drift from expected progress", () => {
    expect(sampleChanged(base, next({ progress_ms: 5_000 })).reason).toBe("seek-detected");
    // A restart of the same track also shows up as a seek.
    expect(sampleChanged(base, next({ progress_ms: 150_000 })).reason).toBe("seek-detected");
  });

  it("tolerates small drift without writing", () => {
    expect(sampleChanged(base, next({ progress_ms: 90_000 + 20_000 })).changed).toBe(false);
  });

  it("emits a heartbeat during long unchanged playback", () => {
    const later: SampleCandidate = next({
      sampled_at: base.sampled_at + 6 * 60 * 1000,
      progress_ms: 30_000 + 6 * 60 * 1000,
    });
    expect(sampleChanged(base, later).reason).toBe("heartbeat");
  });

  it("does not heartbeat while paused", () => {
    const pausedPrev: LastSample = { ...base, is_playing: 0 };
    const later = next({ sampled_at: base.sampled_at + 6 * 60 * 1000, is_playing: false, progress_ms: 30_000 });
    expect(sampleChanged(pausedPrev, later).changed).toBe(false);
  });
});

describe("toSampleCandidate", () => {
  it("maps a playing track", () => {
    const state: PlaybackState = {
      item: track(),
      is_playing: true,
      progress_ms: 12_345,
      device: { id: "d1", name: "Phone", type: "Smartphone", volume_percent: 70 },
      context: { type: "playlist", uri: "spotify:playlist:p1" },
      currently_playing_type: "track",
      timestamp: 1_700_000_000_000,
    };
    const c = toSampleCandidate(state, 5_000);
    expect(c).toMatchObject({
      sampled_at: 5_000,
      item_type: "track",
      item_id: "t100",
      item_name: "Test Song",
      progress_ms: 12_345,
      is_playing: true,
      device_id: "d1",
      context_uri: "spotify:playlist:p1",
    });
  });

  it("routes podcast episodes to the episode id", () => {
    const state: PlaybackState = {
      item: { id: "ep9", name: "Episode 9", type: "episode", duration_ms: 3_600_000 },
      currently_playing_type: "episode",
      is_playing: true,
      progress_ms: 60_000,
    };
    const c = toSampleCandidate(state, 1);
    expect(c.item_type).toBe("episode");
    expect(c.item_id).toBe("ep9");
  });

  it("represents 'nothing playing' (HTTP 204) as item_type none", () => {
    const c = toSampleCandidate(null, 42);
    expect(c).toMatchObject({ item_type: "none", item_id: null, is_playing: false, sampled_at: 42 });
  });
});

describe("playStatements", () => {
  const item = (playedAt: string, t: SpotifyTrack = track()): PlayHistoryItem => ({
    track: t,
    played_at: playedAt,
    context: { type: "playlist", uri: "spotify:playlist:p1" },
  });

  it("emits entity rows before the play row, and reports the newest played_at", () => {
    const { env, recorded } = fakeEnv();
    const { statements, maxPlayedAt } = playStatements(
      env,
      [item("2025-08-12T12:00:00Z"), item("2025-08-12T12:10:00Z")],
      999,
    );

    expect(statements.length).toBe(recorded.length);
    expect(maxPlayedAt).toBe(Date.parse("2025-08-12T12:10:00Z"));

    const play = recorded.find((r) => r.sql.includes("INTO plays"))!;
    expect(play.binds[0]).toBe(Date.parse("2025-08-12T12:00:00Z"));
    expect(play.binds[1]).toBe("2025-08-12T12:00:00.000Z");
    expect(play.binds[2]).toBe("t100");
  });

  it("orders each item's statements so foreign keys are always satisfiable", () => {
    const { env, recorded } = fakeEnv();
    // One item, so the statement list is exactly one entity group.
    playStatements(env, [item("2025-08-12T12:00:00Z")], 1);

    const targets = recorded.map((r) => {
      const m = /INTO (\w+)/.exec(r.sql) ?? /DELETE FROM (\w+)/.exec(r.sql);
      return (r.sql.trimStart().startsWith("DELETE") ? "delete:" : "") + m![1]!;
    });
    expect(targets).toEqual([
      "artists", // track artist a1
      "artists", // track artist a2
      "artists", // album artist a1
      "albums",
      "album_artists",
      "tracks",
      "delete:track_artists", // drop any name-only stub credit an import left
      "track_artists",
      "track_artists",
      "plays",
    ]);

    const play = recorded.find((r) => r.sql.includes("INTO plays"))!;
    expect(play.binds[0]).toBe(Date.parse("2025-08-12T12:00:00Z"));
    expect(play.binds[1]).toBe("2025-08-12T12:00:00.000Z");
    expect(play.binds[2]).toBe("t100");
  });

  it("uses INSERT OR IGNORE on plays so re-polling cannot duplicate", () => {
    const { env, recorded } = fakeEnv();
    playStatements(env, [item("2025-08-12T12:00:00Z")], 1);
    const play = recorded.find((r) => r.sql.includes("INTO plays"))!;
    expect(play.sql).toContain("INSERT OR IGNORE INTO plays");
  });

  it("skips items with an unparseable timestamp instead of throwing", () => {
    const { env } = fakeEnv();
    const { statements, maxPlayedAt } = playStatements(env, [item("garbage")], 1);
    expect(statements).toHaveLength(0);
    expect(maxPlayedAt).toBeNull();
  });

  it("still records local tracks via their synthetic id", () => {
    const { env, recorded } = fakeEnv();
    playStatements(env, [item("2025-08-12T12:00:00Z", track({ id: null, is_local: true, album: undefined }))], 1);
    const play = recorded.find((r) => r.sql.includes("INTO plays"))!;
    expect(String(play.binds[2])).toMatch(/^local:/);
    const trackRow = recorded.find((r) => r.sql.includes("INTO tracks"))!;
    expect(trackRow.binds[10]).toBe(1); // is_local
  });
});
