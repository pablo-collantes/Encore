import { beforeEach, describe, expect, it } from "vitest";
import { classifyExportFile, parseEndTime, parseExportFile, validateImportRow, type ImportRow } from "../src/shared/exportFormats";
import { idFromUri, isSpotifyId, normName, trackNameKey } from "../src/shared/normalize";
import { episodeStatements, playStatements, trackStatements } from "../src/worker/ingest";
import { insertImportRows, prepareChunk } from "../src/worker/importer";
import { runCleanup, STATE_DUPS_RECHECK, STATE_NAMES_RECHECK } from "../src/worker/cleanup";
import { getState, setState } from "../src/worker/lib/db";
import { STATE_ROLL_READY } from "../src/worker/stats/rollup";
import { bumpDataVersion, historyVersion, ReadCache } from "../src/worker/lib/cache";
import { pickSearchMatch } from "../src/worker/enrich/pump";
import * as Q from "../src/worker/stats/queries";
import * as D from "../src/worker/stats/details";
import { bucketLabels, localMsSql, offsetSegments } from "../src/worker/stats/tz";
import type { Env, PlayHistoryItem, SpotifyEpisode, SpotifyTrack } from "../src/worker/types";
import { testEnv } from "./sqlite";

// ---------------------------------------------------------------------------
// Export parsing
// ---------------------------------------------------------------------------

describe("export parsing", () => {
  it("classifies files by name and by shape", () => {
    expect(classifyExportFile("Spotify Extended Streaming History/Streaming_History_Audio_2019-2021_3.json")).toBe("extended_audio");
    expect(classifyExportFile("x/Streaming_History_Video_2020-2024.json")).toBe("extended_video");
    expect(classifyExportFile("MyData/endsong_0.json")).toBe("extended_audio");
    expect(classifyExportFile("Spotify Account Data/StreamingHistory_music_0.json")).toBe("account_music");
    expect(classifyExportFile("StreamingHistory_podcast_0.json")).toBe("account_podcast");
    expect(classifyExportFile("MyData/StreamingHistory0.json")).toBe("account_legacy");
    expect(classifyExportFile("YourLibrary.json")).toBe("other");
    expect(classifyExportFile("renamed.json", [{ ts: "2020-01-01T00:00:00Z", ms_played: 1 }])).toBe("extended_audio");
    expect(classifyExportFile("renamed.json", [{ endTime: "2020-01-01 00:00", trackName: "a" }])).toBe("account_music");
  });

  it("reads account-data endTime as UTC minutes", () => {
    expect(parseEndTime("2023-11-05 14:32")).toBe(Date.UTC(2023, 10, 5, 14, 32));
    expect(parseEndTime("nope")).toBeNull();
  });

  it("parses an extended history file", () => {
    const file = parseExportFile(
      "Streaming_History_Audio_2023.json",
      JSON.stringify([
        {
          ts: "2023-05-01T12:34:56Z",
          platform: "android",
          ms_played: 210000,
          conn_country: "US",
          ip_addr: "1.2.3.4",
          master_metadata_track_name: "Song",
          master_metadata_album_artist_name: "Artist",
          master_metadata_album_album_name: "Album",
          spotify_track_uri: "spotify:track:4vz3cCxzFkMlHHKHgZmtCw",
          reason_start: "trackdone",
          reason_end: "trackdone",
          shuffle: true,
          skipped: false,
          offline: false,
          incognito_mode: false,
        },
        { ts: "2023-05-01T13:00:00Z", ms_played: 900000, episode_name: "Ep", episode_show_name: "Show", spotify_episode_uri: "spotify:episode:512ojhOuo1ktJprKbVcKyQ" },
        { ts: "2023-05-01T14:00:00Z", ms_played: 30000 }, // ad / stripped entry
      ]),
    );
    expect(file.kind).toBe("extended_audio");
    expect(file.rows).toHaveLength(2);
    expect(file.dropped).toBe(1);
    expect(file.rows[0]).toMatchObject({ src: "extended", kind: "track", ms: 210000, shuffle: true, skipped: false, country: "US" });
    expect(JSON.stringify(file.rows[0])).not.toContain("1.2.3.4"); // IP addresses are never kept
    expect(file.rows[1]).toMatchObject({ kind: "episode", episode: "Ep", show: "Show" });
    expect(file.firstTs).toBe(Date.parse("2023-05-01T12:34:56Z"));
  });

  it("parses account-data music and podcast files", () => {
    const music = parseExportFile(
      "StreamingHistory_music_0.json",
      JSON.stringify([{ endTime: "2022-11-05 18:01", artistName: "Artist", trackName: "Song", msPlayed: 1234 }]),
    );
    expect(music.rows[0]).toEqual({ ts: Date.UTC(2022, 10, 5, 18, 1), src: "account", kind: "track", track: "Song", artist: "Artist", album: null, ms: 1234 });
    const pods = parseExportFile(
      "StreamingHistory_podcast_0.json",
      JSON.stringify([{ endTime: "2022-11-05 18:01", podcastName: "Show", episodeName: "Ep", msPlayed: 99 }]),
    );
    expect(pods.rows[0]).toMatchObject({ kind: "episode", show: "Show", episode: "Ep" });
  });

  it("reports non-history files instead of failing", () => {
    expect(parseExportFile("YourLibrary.json", '{"tracks":[]}').kind).toBe("other");
    expect(parseExportFile("broken.json", "{").note).toBe("not valid JSON");
  });

  it("re-validates uploaded rows on the server", () => {
    const ok: ImportRow = { ts: Date.UTC(2023, 0, 1), src: "extended", kind: "track", uri: "spotify:track:abcdefghij", ms: 1 };
    expect(validateImportRow(ok)).toMatchObject({ ts: ok.ts, src: "extended" });
    expect(validateImportRow({ ...ok, ts: 5 })).toBeNull();
    expect(validateImportRow({ ...ok, src: "live" })).toBeNull();
    expect(validateImportRow({ ...ok, ms: -1 })).toBeNull();
    expect(validateImportRow({ ...ok, uri: null, track: null })).toBeNull();
    expect(validateImportRow({ ...ok, track: "x".repeat(2000) })!.track).toHaveLength(500);
  });
});

describe("normalisation", () => {
  it("compares names loosely but not fuzzily", () => {
    expect(normName("Beyoncé & JAY-Z")).toBe("beyonce and jay z");
    expect(normName("  Mr.   Brightside ")).toBe("mr brightside");
    expect(normName("Song (Live)")).not.toBe(normName("Song"));
    expect(trackNameKey("Song", "Artist")).toBe("song|artist");
  });
  it("only accepts real Spotify ids", () => {
    expect(idFromUri("spotify:track:4vz3cCxzFkMlHHKHgZmtCw", "track")).toBe("4vz3cCxzFkMlHHKHgZmtCw");
    expect(idFromUri("spotify:local:a:b:c:200", "track")).toBeNull();
    expect(idFromUri("spotify:episode:abcdefghijk", "track")).toBeNull();
    expect(isSpotifyId("name:12345678")).toBe(false);
    expect(isSpotifyId("local:12345678")).toBe(false);
    expect(isSpotifyId("4vz3cCxzFkMlHHKHgZmtCw")).toBe(true);
  });
  it("keys name-only listens and stubs consistently", () => {
    const chunk = prepareChunk([
      { ts: 1, src: "account", kind: "track", track: "Song", artist: "Band", ms: 10 },
      { ts: 2, src: "account", kind: "track", track: "song", artist: "BAND", ms: 10 },
    ]);
    expect(chunk.tracks).toHaveLength(1);
    expect(chunk.artists).toHaveLength(1);
    expect(chunk.listens[0]!.t).toBe(chunk.listens[1]!.t);
    expect(chunk.listens[0]!.t!.startsWith("name:")).toBe(true);
  });
});

describe("local time", () => {
  it("finds DST changes to the minute", () => {
    const segs = offsetSegments("Europe/Madrid", Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 30));
    expect(segs).toHaveLength(2);
    expect(segs[0]!.offset).toBe(3_600_000);
    expect(segs[1]!.offset).toBe(7_200_000);
    expect(Math.abs(segs[1]!.start - Date.UTC(2024, 2, 31, 1))).toBeLessThanOrEqual(60_000);
  });
  it("emits a single offset for UTC", () => {
    expect(localMsSql("UTC", 0, Date.UTC(2030, 0, 1))).toBe("(ts + 0)");
  });
  it("labels buckets", () => {
    expect(bucketLabels("month", "UTC", Date.UTC(2024, 0, 15), Date.UTC(2024, 3, 2))).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect(bucketLabels("week", "UTC", Date.UTC(2024, 0, 3), Date.UTC(2024, 0, 16))).toEqual(["2024-01-01", "2024-01-08", "2024-01-15"]);
    expect(bucketLabels("day", "America/New_York", Date.UTC(2024, 0, 1, 12), Date.UTC(2024, 0, 3, 12))).toEqual([
      "2024-01-01",
      "2024-01-02",
      "2024-01-03",
    ]);
  });
});

describe("helpers", () => {
  it("groups platform strings into families", () => {
    expect(D.platformFamily("Android OS 9 API 28 (samsung, SM-G960U)")).toBe("Android");
    expect(D.platformFamily("iOS 14.4 (iPhone12,1)")).toBe("iPhone / iPad");
    expect(D.platformFamily("Windows 10 (10.0.19041; x64)")).toBe("Windows");
    expect(D.platformFamily("OS X 10.15.7 [x86 8]")).toBe("Mac");
    expect(D.platformFamily("web_player windows 10;chrome 86.0.4240.183;desktop")).toBe("Web player");
  });
  it("computes streaks", () => {
    const s = D.streaks(["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-10", "2024-01-11"], "2024-01-12");
    expect(s.longest).toEqual({ days: 3, from: "2024-01-01", to: "2024-01-03" });
    expect(s.current).toEqual({ days: 2, from: "2024-01-10", to: "2024-01-11" });
    expect(D.streaks(["2024-01-01"], "2024-02-01").current).toBeNull();
  });
  it("only accepts unambiguous search matches", () => {
    const t = (id: string, name: string, artist: string): SpotifyTrack => ({ id, name, artists: [{ id: "a", name: artist }] });
    expect(pickSearchMatch([t("1", "Song (Live)", "Band"), t("2", "Song", "Band")], "Song", "Band")?.id).toBe("2");
    expect(pickSearchMatch([t("1", "Song", "Other Band")], "Song", "Band")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The whole pipeline against real SQLite
// ---------------------------------------------------------------------------

const T1 = "1qGAlSpn01ukAedAwdivsi";
const T2 = "2RUwBfxBoj55yg8Iv4ur1t";
const T3 = "3n3Ppam7vgaVa1iaRUc9Lp";
const T4 = "4vz3cCxzFkMlHHKHgZmtCw"; // another release of T1 (same ISRC)
const EP = "512ojhOuo1ktJprKbVcKyQ";

function spotifyTrack(id: string, name: string, artist: string, artistId: string, isrc: string): SpotifyTrack {
  return {
    id,
    name,
    uri: `spotify:track:${id}`,
    duration_ms: 200_000,
    external_ids: { isrc },
    artists: [{ id: artistId, name: artist, uri: `spotify:artist:${artistId}` }],
    album: { id: `al${artistId}`, name: `${artist} LP`, album_type: "album", release_date: "2020-01-01", images: [{ url: "https://i.scdn.co/image/x", height: 640, width: 640 }], artists: [{ id: artistId, name: artist }] },
  };
}

const TRACK1 = spotifyTrack(T1, "Track One", "Artist One", "artistOne0000000000001", "USAAA0000001");
const TRACK2 = spotifyTrack(T2, "Track Two", "Artist Two", "artistTwo0000000000002", "USAAA0000002");

function live(track: SpotifyTrack, iso: string): PlayHistoryItem {
  return { track, played_at: iso, context: null };
}

const at = (iso: string) => Date.parse(iso);

async function seed(env: Env) {
  // Live collector: three plays.
  const { statements } = playStatements(
    env,
    [live(TRACK1, "2024-03-10T12:00:00Z"), live(TRACK2, "2024-03-10T12:04:00Z"), live(TRACK1, "2024-05-01T10:00:00Z")],
    at("2024-05-01T10:01:00Z"),
  );
  await env.DB.batch(statements);

  // Extended history export.
  await env.DB.prepare("INSERT INTO imports (id, created_at) VALUES ('ext', 1), ('acct', 2)").run();
  const extended: ImportRow[] = [
    { ts: at("2024-03-10T12:00:08Z"), src: "extended", kind: "track", uri: `spotify:track:${T1}`, track: "Track One", artist: "Artist One", album: "Artist One LP", ms: 200_000, platform: "Android OS 14 API 34 (Google, Pixel 8)", country: "ES", shuffle: true, skipped: false, reasonStart: "clickrow", reasonEnd: "trackdone" },
    { ts: at("2024-03-10T12:04:03Z"), src: "extended", kind: "track", uri: `spotify:track:${T2}`, track: "Track Two", artist: "Artist Two", album: "Artist Two LP", ms: 180_000, platform: "iOS 17.2 (iPhone15,2)", country: "ES", shuffle: false },
    { ts: at("2024-03-11T08:00:00Z"), src: "extended", kind: "track", uri: `spotify:track:${T3}`, track: "Song Three", artist: "Band Three", album: "Album Three", ms: 15_000, skipped: true, reasonEnd: "fwdbtn" },
    { ts: at("2024-03-10T23:30:00Z"), src: "extended", kind: "track", uri: `spotify:track:${T2}`, track: "Track Two", artist: "Artist Two", album: "Artist Two LP", ms: 100_000 },
    { ts: at("2024-03-11T09:00:00Z"), src: "extended", kind: "episode", uri: `spotify:episode:${EP}`, episode: "Ep One", show: "Pod Show", ms: 600_000 },
  ];
  const ext = await insertImportRows(env, "ext", extended, at("2024-06-01T00:00:00Z"));

  // Account data export (names only, minute precision).
  const account: ImportRow[] = [
    { ts: at("2024-03-11T08:00:00Z"), src: "account", kind: "track", track: "Song Three", artist: "Band Three", ms: 15_000 }, // = extended #3
    { ts: at("2024-04-01T10:00:00Z"), src: "account", kind: "track", track: "Song Three", artist: "Band Three", ms: 200_000 }, // resolves to T3
    { ts: at("2024-04-02T10:00:00Z"), src: "account", kind: "track", track: "Unknown Song", artist: "Mystery Artist", ms: 120_000 },
    { ts: at("2024-05-01T10:00:00Z"), src: "account", kind: "track", track: "Track One", artist: "Artist One", ms: 200_000 }, // = live #3
    { ts: at("2024-04-03T07:00:00Z"), src: "account", kind: "episode", episode: "Ep Two", show: "Pod Show", ms: 300_000 },
  ];
  const acct = await insertImportRows(env, "acct", account, at("2024-06-01T00:00:00Z"));
  return { ext, acct };
}

const R: Q.Range = { from: at("2024-03-01T00:00:00Z"), to: at("2024-06-01T00:00:00Z"), tz: "Europe/Madrid" };

async function listenBy(env: Env, source: string, iso: string) {
  return env.DB.prepare("SELECT * FROM listens WHERE source = ? AND ts = ?").bind(source, at(iso)).first<Record<string, unknown>>();
}

describe("import + cleanup pipeline", () => {
  let env: Env;
  beforeEach(() => {
    env = testEnv().env;
  });

  it("mirrors live plays into the timeline by trigger", async () => {
    await seed(env);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM listens WHERE source = 'live'").first<{ n: number }>();
    expect(n?.n).toBe(3);
    const l1 = await listenBy(env, "live", "2024-03-10T12:00:00Z");
    expect(l1).toMatchObject({ track_id: T1, song_id: T1, ms_played: 200_000, ms_estimated: 1, name_key: "track one|artist one" });
  });

  it("inserts idempotently", async () => {
    const first = await seed(env);
    expect(first.ext.inserted).toBe(5);
    expect(first.acct.inserted).toBe(5);
    const again = await insertImportRows(
      env,
      "ext",
      [{ ts: at("2024-03-10T12:00:08Z"), src: "extended", kind: "track", uri: `spotify:track:${T1}`, track: "Track One", artist: "Artist One", ms: 200_000 }],
      at("2024-06-01T00:00:00Z"),
    );
    expect(again.inserted).toBe(0);
  });

  it("keeps real credits on tracks the collector already knows", async () => {
    await seed(env);
    const credits = await env.DB.prepare("SELECT artist_id FROM track_artists WHERE track_id = ?").bind(T1).all<{ artist_id: string }>();
    expect(credits.results.map((r) => r.artist_id)).toEqual(["artistOne0000000000001"]);
    const t3 = await env.DB.prepare("SELECT artist_id FROM track_artists WHERE track_id = ?").bind(T3).first<{ artist_id: string }>();
    expect(t3?.artist_id.startsWith("name:")).toBe(true);
  });

  it("marks cross-source duplicates and resolves name-only listens", async () => {
    await seed(env);
    const result = await runCleanup(env, {}, at("2024-06-01T00:00:00Z"));

    const e1 = await listenBy(env, "extended", "2024-03-10T12:00:08Z");
    const e2 = await listenBy(env, "extended", "2024-03-10T12:04:03Z");
    const e3 = await listenBy(env, "extended", "2024-03-11T08:00:00Z");
    const l3 = await listenBy(env, "live", "2024-05-01T10:00:00Z");
    expect((await listenBy(env, "live", "2024-03-10T12:00:00Z"))?.dup_of).toBe(e1?.id);
    expect((await listenBy(env, "live", "2024-03-10T12:04:00Z"))?.dup_of).toBe(e2?.id);
    expect(l3?.dup_of).toBeNull();
    expect((await listenBy(env, "account", "2024-03-11T08:00:00Z"))?.dup_of).toBe(e3?.id);
    expect((await listenBy(env, "account", "2024-05-01T10:00:00Z"))?.dup_of).toBe(l3?.id);

    const resolved = await listenBy(env, "account", "2024-04-01T10:00:00Z");
    expect(resolved).toMatchObject({ track_id: T3, song_id: T3, dup_of: null });
    const unknown = await listenBy(env, "account", "2024-04-02T10:00:00Z");
    expect(String(unknown?.track_id).startsWith("name:")).toBe(true);

    expect(result.duplicates).toBe(4);
    expect(result.resolvedByName).toBeGreaterThanOrEqual(2);

    // The resolved stub track is gone; the unresolved one stays.
    const stubs = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracks WHERE id >= 'name:' AND id < 'name;'").first<{ n: number }>();
    expect(stubs?.n).toBe(1);

    // Running it again over the whole history changes nothing.
    const again = await runCleanup(env, { full: true }, at("2024-06-01T00:00:00Z"));
    expect(again.duplicates).toBe(4);
  });

  it("replaces stub credits once the real track is known, and merges releases by ISRC", async () => {
    await seed(env);
    // The metadata lookup for T3 returns the real credits.
    await env.DB.batch(trackStatements(env, spotifyTrack(T3, "Song Three", "Band Three", "bandThree000000000003", "USAAA0000003"), 1));
    // Another release of Track One, listened to once.
    await env.DB.batch(trackStatements(env, spotifyTrack(T4, "Track One", "Artist One", "artistOne0000000000001", "USAAA0000001"), 1));
    await insertImportRows(env, "ext", [{ ts: at("2024-04-20T10:00:00Z"), src: "extended", kind: "track", uri: `spotify:track:${T4}`, track: "Track One", artist: "Artist One", ms: 50_000 }], at("2024-06-01T00:00:00Z"));
    await runCleanup(env, {}, at("2024-06-01T00:00:00Z"));

    const credits = await env.DB.prepare("SELECT artist_id FROM track_artists WHERE track_id = ?").bind(T3).all<{ artist_id: string }>();
    expect(credits.results.map((r) => r.artist_id)).toEqual(["bandThree000000000003"]);
    const stubArtists = await env.DB.prepare("SELECT name FROM artists WHERE id >= 'name:' AND id < 'name;' ORDER BY name").all<{ name: string }>();
    expect(stubArtists.results.map((r) => r.name)).toEqual(["Mystery Artist"]);

    const t4 = await env.DB.prepare("SELECT canonical_id FROM tracks WHERE id = ?").bind(T4).first<{ canonical_id: string | null }>();
    expect(t4?.canonical_id).toBe(T1);
    const l = await listenBy(env, "extended", "2024-04-20T10:00:00Z");
    expect(l?.song_id).toBe(T1);
  });

  it("rewrites no listens when nothing changed since the last pass", async () => {
    const { env, raw } = testEnv();
    await seed(env);
    await runCleanup(env, {}, at("2024-06-01T00:00:00Z"));
    const version = await historyVersion(env);
    // D1 bills every rewritten row, even on a pass over the whole history.
    raw.exec(`CREATE TEMP TABLE listen_writes (id INTEGER);
              CREATE TEMP TRIGGER count_listen_writes AFTER UPDATE ON listens
              BEGIN INSERT INTO listen_writes VALUES (NEW.id); END;`);
    const again = await runCleanup(env, { full: true }, at("2024-06-01T00:00:00Z"));
    expect(again.duplicates).toBe(4);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM listen_writes").get()).toEqual({ n: 0 });
    // Nothing changed, so stored dashboard answers stay valid.
    expect(await historyVersion(env)).toBe(version);
  });

  it("re-checks the whole history hourly only after listens changed which track they are", async () => {
    await seed(env);
    const now = at("2024-06-01T00:00:00Z");
    expect((await runCleanup(env, {}, now)).duplicates).toBe(4); // first run: everything
    // Nothing changed since: only the last few days are looked at (none of the seed's).
    expect((await runCleanup(env, {}, now)).duplicates).toBe(0);
    // Enrichment that only adds artwork or genres doesn't call for a whole pass...
    await bumpDataVersion(env, "history", now);
    expect((await runCleanup(env, {}, now)).duplicates).toBe(0);
    // ...a search match that re-points listens at a real track does.
    await env.DB.prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES ('${STATE_DUPS_RECHECK}', 'x', 1)`).run();
    expect((await runCleanup(env, {}, now)).duplicates).toBe(4);
    expect((await runCleanup(env, {}, now)).duplicates).toBe(0);
  });

  it("matches names only after the catalogue changed, and otherwise reads no whole table", async () => {
    const { env, raw, executed } = testEnv();
    await seed(env);
    const now = at("2024-06-01T00:00:00Z");
    await setState(env, STATE_ROLL_READY, "1", now); // as on production: the stored totals keep priorities
    await runCleanup(env, {}, now);
    // The matching's own changes don't call for another run.
    expect(await getState(env, STATE_NAMES_RECHECK)).toBeNull();

    // An hour with nothing new: no table is read whole (shows' few dozen rows aside), nothing written.
    const tables = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name));
    executed.length = 0;
    const changesBefore = Number((raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    await runCleanup(env, {}, now + 3_600_000);
    expect(Number((raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n)).toBe(changesBefore);
    const scans = executed.flatMap((sql) =>
      raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => (r as { detail: string }).detail)
        .filter((d) => tables.has(d.match(/^SCAN (\w+)/)?.[1] ?? "") && !d.startsWith("SCAN shows")));
    expect(scans).toEqual([]);
    // Nor is there any matching (its every statement picks out name-only stubs):
    // its plans are index lookups, but on production that's one per stub, ~5k of them.
    expect(executed.filter((sql) => sql.includes("name:"))).toEqual([]);

    // A collector brings the track an Account-data listen only named.
    await env.DB.batch(trackStatements(env, spotifyTrack(T4, "Unknown Song", "Mystery Artist", "mysteryArtist00000001", "USAAA0000009"), now));
    expect(await getState(env, STATE_NAMES_RECHECK)).not.toBeNull();
    expect((await runCleanup(env, {}, now + 7_200_000)).resolvedByName).toBe(1);
    expect(await listenBy(env, "account", "2024-04-02T10:00:00Z")).toMatchObject({ track_id: T4 });
    const stubs = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracks WHERE id >= 'name:' AND id < 'name;'").first<{ n: number }>();
    expect(stubs?.n).toBe(0);
    expect(await getState(env, STATE_NAMES_RECHECK)).toBeNull();
  });

  it("flags each catalogue change name matching could act on, and nothing else", async () => {
    await seed(env);
    const now = at("2024-06-01T00:00:00Z");
    await runCleanup(env, {}, now);
    const flags = async (change: () => Promise<unknown>) => {
      await env.DB.prepare("DELETE FROM sync_state WHERE key = ?").bind(STATE_NAMES_RECHECK).run();
      await change();
      return (await getState(env, STATE_NAMES_RECHECK)) !== null;
    };
    const run = (sql: string, ...binds: unknown[]) => () => env.DB.prepare(sql).bind(...binds).run();

    // Nothing to match: known tracks sent again (a month on, so last_seen_at is
    // refreshed), a new play of one, enrichment, duplicates being marked.
    expect(await flags(() => env.DB.batch(trackStatements(env, TRACK1, now)))).toBe(false);
    expect(await flags(() => env.DB.batch(playStatements(env, [live(TRACK2, "2024-06-01T09:00:00Z")], now).statements))).toBe(false);
    expect(await flags(run("UPDATE tracks SET priority = priority + 1, deezer_status = 'ok', features_status = 'ok'"))).toBe(false);
    expect(await flags(run("UPDATE artists SET image_url = 'https://i.scdn.co/image/p', mb_status = 'ok'"))).toBe(false);
    expect(await flags(run("UPDATE listens SET dup_of = NULL"))).toBe(false);

    // Something to match.
    expect(await flags(() => env.DB.batch(trackStatements(env, spotifyTrack(T4, "New Song", "New Artist", "newArtist000000000001", "USAAA0000008"), now)))).toBe(true);
    expect(await flags(() => env.DB.batch(episodeStatements(env, { id: "6kAsbP8pxwaU2kPibKTuHE", name: "Ep Three", duration_ms: 1, show: { id: "showOne000000000000001", name: "Pod Show", images: [] } } as SpotifyEpisode, now)))).toBe(true);
    expect(await flags(run("UPDATE artists SET name_key = 'renamed' WHERE id = 'artistTwo0000000000002'"))).toBe(true);
    expect(await flags(run("UPDATE tracks SET album_id = NULL WHERE id = ?", T1))).toBe(true);
    // The metadata lookup drops name-only credits; the name-only search re-files a stub's listens.
    expect(await flags(run("DELETE FROM track_artists WHERE track_id = ? AND artist_id LIKE 'name:%'", T3))).toBe(true);
    expect(await flags(run("UPDATE listens SET track_id = ?1, song_id = ?1 WHERE track_id >= 'name:' AND track_id < 'name;'", T2))).toBe(true);
    const nameOnly: ImportRow = { ts: at("2024-04-05T10:00:00Z"), src: "account", kind: "track", track: "Other Song", artist: "Other Artist", ms: 60_000 };
    expect(await flags(() => insertImportRows(env, "acct", [nameOnly], now))).toBe(true);
    expect(await flags(run("DELETE FROM listens WHERE import_id = 'acct'"))).toBe(true);
  });

  it("un-hides duplicates when the import that superseded them is deleted", async () => {
    await seed(env);
    await runCleanup(env, {}, at("2024-06-01T00:00:00Z"));
    await env.DB.prepare("DELETE FROM listens WHERE import_id = 'ext'").run();
    // A change made behind the app's back: the manual run checks everything.
    await runCleanup(env, { full: true }, at("2024-06-01T00:00:00Z"));
    expect((await listenBy(env, "live", "2024-03-10T12:00:00Z"))?.dup_of).toBeNull();
    // With the extended copy gone, the account row now duplicates nothing it can see.
    expect((await listenBy(env, "account", "2024-03-11T08:00:00Z"))?.dup_of).toBeNull();
  });
});

describe("stats queries", () => {
  let env: Env;
  beforeEach(async () => {
    env = testEnv().env;
    await seed(env);
    await runCleanup(env, {}, at("2024-06-01T00:00:00Z"));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO track_genres (track_id, genre) VALUES (?1, 'Pop'), (?1, 'Rock'), (?2, 'Rock')").bind(T1, T3),
      env.DB.prepare("INSERT INTO audio_features (track_id, source, energy, valence, tempo, fetched_at) VALUES (?1, 'reccobeats', 0.9, 0.8, 128, 1)").bind(T1),
      env.DB.prepare("INSERT INTO audio_features (track_id, source, energy, valence, tempo, fetched_at) VALUES (?1, 'analysis', 0.3, 0.2, 80, 1)").bind(T2),
      env.DB.prepare("INSERT INTO artist_tags (artist_id, tag, votes) VALUES ('artistOne0000000000001', 'indie pop', 3), ('artistOne0000000000001', 'pop', 1)"),
    ]);
  });

  // Canonical listens after cleanup:
  //   extended T1 200s, T2 180s, T3 15s (skip), T2 100s (local 00:30 on 11 Mar), episode 600s
  //   live T1 200s (May 1, estimated)
  //   account T3 200s (resolved), name-only 120s, episode 300s
  const MUSIC_MS = 200_000 + 180_000 + 15_000 + 100_000 + 200_000 + 200_000 + 120_000;
  const SPOKEN_MS = 600_000 + 300_000;

  it("summarises everything", async () => {
    const s = await Q.summary(env, "Europe/Madrid");
    expect(s.totalStreams).toBe(9);
    expect(s.sources).toEqual({ extended: 5, account: 3, live: 1 });
    expect(s.years).toEqual([2024]);
  });

  it("totals a range, with the previous period", async () => {
    const o = await Q.overview(env, R);
    expect(o.totals).toMatchObject({
      ms: MUSIC_MS + SPOKEN_MS,
      streams: 9,
      plays: 8,
      skips: 1,
      spokenMs: SPOKEN_MS,
      artists: 4, // Artist One, Artist Two, Band Three (stub), Mystery Artist (stub)
    });
    expect(o.previous?.streams).toBe(0);
  });

  it("buckets by local day across midnight", async () => {
    const t = await Q.timeline(env, { ...R, from: at("2024-03-10T00:00:00Z"), to: at("2024-03-12T00:00:00Z") }, "day");
    expect(t.points.map((p) => p.t)).toEqual(["2024-03-10", "2024-03-11", "2024-03-12"]);
    // 23:30Z on the 10th is 00:30 on the 11th in Madrid.
    expect(t.points[0]!.ms).toBe(200_000 + 180_000);
    expect(t.points[1]!.ms).toBe(100_000 + 15_000 + 600_000);
  });

  it("ranks artists, tracks and albums", async () => {
    const artists = await Q.topArtists(env, R, { limit: 10, offset: 0 });
    expect(artists.items[0]).toMatchObject({ name: "Artist One", ms: 400_000, rank: 1 });
    expect(artists.total).toBe(4);
    const tracks = await Q.topTracks(env, R, { limit: 2, offset: 0 });
    expect(tracks.items.map((t) => t.id)).toEqual([T1, T2]);
    expect(tracks.items[0]).toMatchObject({ energy: 0.9, valence: 0.8, artists: [{ name: "Artist One" }] });
    expect(tracks.total).toBe(4);
    const filtered = await Q.topTracks(env, R, { limit: 10, offset: 0, q: "three" });
    expect(filtered.items.map((t) => t.id)).toEqual([T3]);
    const albums = await Q.topAlbums(env, R, { limit: 10, offset: 0 });
    expect(albums.items[0]).toMatchObject({ name: "Artist One LP", ms: 400_000 });
  });

  it("splits genre time across a track's genres", async () => {
    const g = await Q.topGenres(env, R, "deezer", 10);
    const rock = g.items.find((x) => x.genre === "Rock")!;
    expect(rock.ms).toBe(400_000 / 2 + 15_000 + 200_000);
    expect(g.items.find((x) => x.genre === "Pop")!.ms).toBe(200_000);
    expect(g.coverage).toBeCloseTo((400_000 + 215_000) / MUSIC_MS, 5);
    const mb = await Q.topGenres(env, R, "musicbrainz", 10);
    expect(mb.items[0]).toMatchObject({ genre: "indie pop", ms: 300_000 });
    const tl = await Q.genreTimeline(env, { ...R, tz: "UTC" }, "deezer", "month", 5);
    expect(tl.genres).toContain("Rock");
    expect(tl.points.map((p) => p.t)).toEqual(["2024-03", "2024-04", "2024-05"]);
  });

  it("draws the listening clock in local time", async () => {
    const c = await Q.clock(env, R);
    const total = c.cells.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(MUSIC_MS + SPOKEN_MS);
    // The 100 s stream ending 23:30Z Sunday 10 Mar is Monday 00:29 in Madrid.
    expect(c.cells[0]![0]).toBe(100_000);
  });

  it("weights moods by listening time", async () => {
    const m = await Q.mood(env, R, "month");
    expect(m.averages.energy).toBeCloseTo((0.9 * 400_000 + 0.3 * 280_000) / 680_000, 5);
    expect(m.coverage).toBeCloseTo(680_000 / MUSIC_MS, 5);
    expect(m.quadrants.energetic).toBe(400_000);
    expect(m.quadrants.sad).toBe(280_000);
    expect(m.tracks[0]!.id).toBe(T1);
  });

  it("pages through history newest first", async () => {
    const page1 = await Q.history(env, { before: null, limit: 4, q: null, from: null, to: null, artist: null, track: null, album: null, kind: null, source: null, skipped: false, includeDuplicates: false });
    expect(page1.items).toHaveLength(4);
    expect(page1.items[0]!.ts).toBe(at("2024-05-01T10:00:00Z"));
    const page2 = await Q.history(env, { before: page1.nextBefore, limit: 10, q: null, from: null, to: null, artist: null, track: null, album: null, kind: null, source: null, skipped: false, includeDuplicates: false });
    expect(page2.items).toHaveLength(5);
    expect(page2.nextBefore).toBeNull();
    const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
    expect(ids.size).toBe(9);
    const withDups = await Q.history(env, { before: null, limit: 100, q: null, from: null, to: null, artist: null, track: null, album: null, kind: null, source: null, skipped: false, includeDuplicates: true });
    expect(withDups.items).toHaveLength(13);
    const pods = await Q.history(env, { before: null, limit: 100, q: "pod show", from: null, to: null, artist: null, track: null, album: null, kind: null, source: null, skipped: false, includeDuplicates: false });
    expect(pods.items.map((i) => i.episode?.name).sort()).toEqual(["Ep One", "Ep Two"]);
    const skipped = await Q.history(env, { before: null, limit: 100, q: null, from: null, to: null, artist: null, track: null, album: null, kind: null, source: null, skipped: true, includeDuplicates: false });
    expect(skipped.items.map((i) => i.track?.id)).toEqual([T3]);
  });

  it("builds entity pages", async () => {
    const a = await D.artistDetail(env, "artistOne0000000000001", R);
    expect(a?.totals.ms).toBe(400_000);
    expect(a?.firstListen?.ts).toBe(at("2024-03-10T12:00:08Z"));
    expect(a?.lastListen?.track?.id).toBe(T1);
    expect(a?.artist.genres).toEqual({ deezer: ["Pop", "Rock"], musicbrainz: ["indie pop", "pop"] });
    expect(a?.rankAllTime).toBe(1);
    expect(a?.features?.energy).toBeCloseTo(0.9);
    const t = await D.trackDetail(env, T1, R);
    expect(t?.track.isrc).toBe("USAAA0000001");
    expect(t?.featuresSource).toBe("reccobeats");
    expect(t?.reasonsEnd).toEqual([{ reason: "trackdone", streams: 1 }]);
    const al = await D.albumDetail(env, "alartistOne0000000000001", R);
    expect(al?.tracks.map((x) => x.id)).toEqual([T1]);
    expect(await D.artistDetail(env, "nope", R)).toBeNull();
  });

  it("reports podcasts, habits, status and search", async () => {
    const p = await D.podcasts(env, R);
    expect(p.shows[0]).toMatchObject({ name: "Pod Show", ms: SPOKEN_MS, episodes: 2 });
    const h = await D.habits(env, R, "month", at("2024-05-02T12:00:00Z"));
    expect(h.platforms.map((x) => x.name)).toEqual(["Android", "iPhone / iPad"]);
    expect(h.countries[0]).toMatchObject({ code: "ES" });
    expect(h.byYear[0]).toMatchObject({ year: 2024, ms: MUSIC_MS + SPOKEN_MS });
    expect(h.sessions.count).toBeGreaterThan(0);
    expect(h.streaks.current?.days).toBe(1);
    const status = await D.dataStatus(env, new ReadCache(env, () => {}), "UTC", null, { status: "ok", sampleLastRunMinutesAgo: 0, recentLastRunMinutesAgo: 0, lastError: null }, { connected: true, displayName: "x", scopes: [], missingScopes: [], refreshTokenDaysRemaining: 100 });
    const march = status.coverage.find((m) => m.month === "2024-03")!;
    expect(march).toMatchObject({ extended: 5, live: 0, duplicates: 3 });
    expect(status.waitingUntil).toEqual({ spotify: null, deezer: null, features: null, musicbrainz: null });
    const s = await D.search(env, "one");
    expect(s.artists.map((a) => a.name)).toEqual(["Artist One"]);
    expect(s.tracks.map((t) => t.id)).toEqual([T1]);
    const top = await D.spotifyTop(env);
    expect(top).toMatchObject({ scopeGranted: false, takenAt: null });
    const now = await D.now(env, at("2024-05-01T10:01:00Z"));
    expect(now.playing).toBeNull();
    expect(now.recent[0]!.track?.id).toBe(T1);
  });
});
