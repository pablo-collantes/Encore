// Stored listening totals (migration 0005): All time and every calendar year,
// kept in D1 and adjusted by what changes rather than recomputed.
//
// foldRollups() is the only writer. One fold is one D1 batch (one transaction):
//   1. changes   listens above the watermark (new), plus the listens the
//                triggers logged in roll_log (changed or deleted since the last
//                fold; the oldest LOG_CHUNK of them): the logged previous state
//                is taken out (-1) and the current state put in (+1)
//   2. remaps    for tracks/artists whose artists, genres or audio features
//                changed (roll_dirty), the listens already counted are taken
//                out under the previous mapping (roll_old_*) and put back under
//                the current one; only those tracks' listens are read
//   3. derived   artists, albums and shows are summed again from the per-song
//                and per-episode totals, for the ones touched
// and then clears the log and moves the watermark, all in the same transaction,
// so a fold either happens completely or not at all and two folds can't count
// the same listen twice.
//
// The first fold for a database (or after ROLL_DEF or the time zone changes)
// reads the whole timeline once, in chunks of BUILD_CHUNK listens. After that a
// fold reads the listens that changed and nothing else.
//
// Sessions (gaps over 30 minutes) don't add up like the rest; each fold marks
// the time span it touched (roll_sess_dirty) and refreshSessions() works out
// just that span again.

import type { Env } from "../types";
import { offsetAt, offsetSegments, validTimeZone, type OffsetSegment } from "./tz";

/** Bump when the tables change meaning: the next fold rebuilds them (one full read of the timeline). */
export const ROLL_DEF = 1;

export const STATE_ROLL_WM = "roll_wm";
export const STATE_ROLL_READY = "roll_ready";
export const STATE_ROLL_DEF = "roll_def";

const DAY = 86_400_000;
export const SESSION_GAP_MS = 30 * 60_000;

/**
 * Listens per fold while building: a 240k-listen archive takes about fifty.
 * Bigger chunks write less (a song or genre-week spread over many chunks is
 * updated once per chunk), but one fold is one D1 request, which D1 resets
 * past about 30 s of CPU, and blocks every other query while it runs. At this
 * size a fold takes well under a second locally and a few seconds on D1.
 */
export const BUILD_CHUNK = 5_000;

/**
 * roll_log entries per fold. Each is taken out and put back in, so this is
 * about as much work as a BUILD_CHUNK of new listens; deleting a big import or
 * hiding many duplicates is then spread over several folds instead of one D1
 * request too big to finish.
 */
export const LOG_CHUNK = 2_500;

/** The local-time expression is exact from here on (Spotify launched in 2006). */
const SPAN_FROM = Date.UTC(2005, 0, 1);

export const FEATURES = ["energy", "valence", "danceability", "acousticness", "instrumentalness", "speechiness", "liveness", "tempo", "loudness"] as const;

/** The time zone the stored days and years are in (STATS_TZ in wrangler.jsonc). */
export function statsTimeZone(env: Env): string {
  return validTimeZone(env.STATS_TZ ?? "UTC");
}

export const rollDefinition = (tz: string) => `${ROLL_DEF}|${tz}`;

// ---------------------------------------------------------------------------
// Local time in SQL (see tz.ts): one CASE over every UTC offset change since SPAN_FROM.
// ---------------------------------------------------------------------------

const segmentCache = new Map<string, { until: number; segs: OffsetSegment[] }>();

function segmentsFor(tz: string, now: number): OffsetSegment[] {
  const hit = segmentCache.get(tz);
  if (hit && hit.until > now + 2 * DAY) return hit.segs;
  const until = now + 60 * DAY;
  const segs = offsetSegments(tz, SPAN_FROM, until);
  segmentCache.set(tz, { until, segs });
  return segs;
}

export function localSql(tz: string, now: number, col: string): string {
  const segs = segmentsFor(tz, now);
  if (segs.length === 1) return `(${col} + ${segs[0]!.offset})`;
  const branches = segs
    .slice(1)
    .map((s, i) => `WHEN ${col} < ${s.start} THEN ${segs[i]!.offset}`)
    .join(" ");
  return `(${col} + CASE ${branches} ELSE ${segs[segs.length - 1]!.offset} END)`;
}

/** Local calendar year of an instant. */
export function localYear(tz: string, t: number): number {
  return new Date(t + offsetAt(tz, t)).getUTCFullYear();
}

/** The instant local midnight starts on a date. */
export function localMidnight(tz: string, y: number, m: number, d: number): number {
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offsetAt(tz, wall);
  t = wall - offsetAt(tz, t);
  return t;
}

// ---------------------------------------------------------------------------
// SQL pieces. Rows from listens (l) and roll_log (g) share one shape.
// ---------------------------------------------------------------------------

const WM = `(SELECT CAST(value AS INTEGER) FROM sync_state WHERE key = '${STATE_ROLL_WM}')`;

const LCOLS = `l.ts, l.ms_played AS ms, l.kind, l.source, l.song_id AS song, l.episode_id AS ep, l.skipped,
  l.platform, l.country, l.reason_start AS rs, l.reason_end AS re, l.shuffle, l.offline, (l.dup_of IS NULL) AS counted`;
const GCOLS = `g.ts, g.ms_played AS ms, g.kind, g.source, g.song_id AS song, g.episode_id AS ep, g.skipped,
  g.platform, g.country, g.reason_start AS rs, g.reason_end AS re, g.shuffle, g.offline, g.counted`;

/**
 * What this fold adds (+1) and takes out (-1). ?1 = the highest listens.id it
 * takes in; ?3 = the highest roll_log entry it takes in (the rest of the log
 * stays counted as its previous state until a later fold).
 */
const CHANGES = `SELECT 1 AS sign, ${LCOLS} FROM listens l WHERE l.id > ${WM} AND l.id <= ?1
  UNION ALL SELECT -1 AS sign, ${GCOLS} FROM roll_log g WHERE g.listen_id <= ?3
  UNION ALL SELECT 1 AS sign, ${LCOLS} FROM listens l WHERE l.id IN (SELECT listen_id FROM roll_log WHERE listen_id <= ?3) AND l.id <= ${WM}`;

/** The listens of `songs` exactly as the totals currently count them. */
function applied(songs: string): string {
  return `SELECT ${LCOLS} FROM listens l
           WHERE l.song_id IN (${songs}) AND l.id <= ${WM} AND l.id NOT IN (SELECT listen_id FROM roll_log)
          UNION ALL SELECT ${GCOLS} FROM roll_log g WHERE g.song_id IN (${songs})`;
}

const DAYX = `date(lt / 1000, 'unixepoch')`;
const YEARX = `CAST(strftime('%Y', lt / 1000, 'unixepoch') AS INTEGER)`;
const WEEKX = `date(lt / 1000, 'unixepoch', '-6 days', 'weekday 1')`;
const MONTHX = `strftime('%Y-%m', lt / 1000, 'unixepoch')`;
/** Hour and weekday (Monday = 0) of the stream's midpoint, like the listening clock. */
const HOURX = `CAST(strftime('%H', lm / 1000, 'unixepoch') AS INTEGER)`;
const WDX = `((CAST(strftime('%w', lm / 1000, 'unixepoch') AS INTEGER) + 6) % 7)`;
/** Genre-timeline bucket keys. Weeks carry the year, so a week across New Year splits between the two. */
const WEEKB = `'w' || ${YEARX} || ':' || ${WEEKX}`;
const MONTHB = `'m:' || ${MONTHX}`;

class Sql {
  constructor(
    readonly tz: string,
    readonly now: number,
  ) {}

  /** Rows with local end time (lt) and local midpoint (lm). */
  local(source: string): string {
    return `SELECT c.*, ${localSql(this.tz, this.now, "c.ts")} AS lt, ${localSql(this.tz, this.now, "(c.ts - c.ms / 2)")} AS lm
              FROM (${source}) c`;
  }

  /** Each row twice: once for All time (p = 0), once for its year. */
  periods(source: string): string {
    return `SELECT y.*, CASE k.a WHEN 0 THEN 0 ELSE ${YEARX} END AS p
              FROM (${this.local(source)}) y CROSS JOIN (SELECT 0 AS a UNION ALL SELECT 1 AS a) k`;
  }
}

/** `INSERT … SELECT SUM(…) … GROUP BY` that adds into existing rows and skips groups that sum to zero. */
function addInto(o: {
  with: string;
  table: string;
  keys: [string, string][];
  sums: [string, string][];
  from: string;
  where?: string;
  /** [column, select expression (an aggregate), DO UPDATE expression] */
  extra?: [string, string, string][];
}): string {
  const extra = o.extra ?? [];
  const cols = [...o.keys.map(([c]) => c), ...o.sums.map(([c]) => c), ...extra.map(([c]) => c)];
  const select = [
    ...o.keys.map(([c, e]) => `${e} AS ${c}`),
    ...o.sums.map(([c, e]) => `SUM(${e}) AS ${c}`),
    ...extra.map(([c, e]) => `${e} AS ${c}`),
  ];
  const sets = [...o.sums.map(([c]) => `${c} = ${c} + excluded.${c}`), ...extra.map(([c, , set]) => `${c} = ${set}`)];
  return `WITH ${o.with}
INSERT INTO ${o.table} (${cols.join(", ")})
SELECT * FROM (SELECT ${select.join(", ")} FROM ${o.from}${o.where ? ` WHERE ${o.where}` : ""}
                GROUP BY ${o.keys.map(([, e]) => e).join(", ")})
 WHERE ${o.sums.map(([c]) => `${c} != 0`).join(" OR ")}
ON CONFLICT (${o.keys.map(([c]) => c).join(", ")}) DO UPDATE SET ${sets.join(", ")}`;
}

/** D1 allows at most 5 terms in one compound SELECT (SQLite's default is 500). */
const COMPOUND_MAX = 5;

/** `a UNION ALL b UNION ALL …` of any length: longer lists nest in groups of 5. The first branch names the columns. */
function unionAll(branches: string[]): string {
  if (branches.length <= COMPOUND_MAX) return branches.join("\n UNION ALL ");
  const groups: string[] = [];
  for (let i = 0; i < branches.length; i += COMPOUND_MAX) {
    groups.push(`SELECT * FROM (${unionAll(branches.slice(i, i + COMPOUND_MAX))})`);
  }
  return unionAll(groups);
}

/** Facts rows from a UNION ALL of `SELECT p, k, ms, n` branches. */
function addFacts(withClause: string, branches: string[]): string {
  return `WITH ${withClause}
INSERT INTO roll_facts (p, k, ms, n)
SELECT * FROM (SELECT p, k, SUM(ms) AS ms, SUM(n) AS n FROM (${unionAll(branches)}) GROUP BY p, k)
 WHERE ms != 0 OR n != 0
ON CONFLICT (p, k) DO UPDATE SET ms = ms + excluded.ms, n = n + excluded.n`;
}

const SKIP = "(ms < 30000 OR skipped = 1)";

/** Every statement of one fold, in order. ?1 = the highest listens.id it takes in, ?2 = now, ?3 = the highest roll_log entry. */
export function foldStatements(tz: string, now: number): string[] {
  const s = new Sql(tz, now);
  const X = `x AS (${s.periods(CHANGES)})`;
  const out: string[] = [];

  // --- Days ------------------------------------------------------------------
  out.push(
    addInto({
      with: `x AS (${s.local(CHANGES)})`,
      table: "roll_days",
      keys: [["day", DAYX]],
      sums: [
        ["ms", "CASE WHEN counted THEN sign * ms ELSE 0 END"],
        ["streams", "CASE WHEN counted THEN sign ELSE 0 END"],
        ["plays", "CASE WHEN counted AND ms >= 30000 THEN sign ELSE 0 END"],
        ["skips", `CASE WHEN counted AND ${SKIP} THEN sign ELSE 0 END`],
        ["spoken_ms", "CASE WHEN counted AND kind != 'track' THEN sign * ms ELSE 0 END"],
        ["extended", "CASE WHEN counted AND source = 'extended' THEN sign ELSE 0 END"],
        ["account", "CASE WHEN counted AND source = 'account' THEN sign ELSE 0 END"],
        ["live", "CASE WHEN counted AND source = 'live' THEN sign ELSE 0 END"],
        ["dups", "CASE WHEN NOT counted THEN sign ELSE 0 END"],
      ],
      from: "x",
    }),
  );

  // --- Songs and episodes --------------------------------------------------------
  const firstLast = (table: string): [string, string, string][] => [
    ["first_ts", "COALESCE(MIN(CASE WHEN sign > 0 THEN ts END), MIN(ts))", `CASE WHEN excluded.first_ts < ${table}.first_ts THEN excluded.first_ts ELSE ${table}.first_ts END`],
    ["last_ts", "COALESCE(MAX(CASE WHEN sign > 0 THEN ts END), MAX(ts))", `CASE WHEN excluded.last_ts > ${table}.last_ts THEN excluded.last_ts ELSE ${table}.last_ts END`],
  ];
  out.push(
    addInto({
      with: X,
      table: "roll_songs",
      keys: [["song_id", "song"], ["p", "p"]],
      sums: [
        ["ms", "sign * ms"],
        ["plays", "CASE WHEN ms >= 30000 THEN sign ELSE 0 END"],
        ["streams", "sign"],
        ["skips", `CASE WHEN ${SKIP} THEN sign ELSE 0 END`],
      ],
      extra: [
        ...firstLast("roll_songs"),
        [
          "first_day",
          `date(COALESCE(MIN(CASE WHEN sign > 0 THEN lt END), MIN(lt)) / 1000, 'unixepoch')`,
          "CASE WHEN excluded.first_ts < roll_songs.first_ts THEN excluded.first_day ELSE roll_songs.first_day END",
        ],
      ],
      from: "x",
      where: "counted AND kind = 'track' AND song IS NOT NULL",
    }),
    // Songs whose listens were taken out: drop the empty ones, and their first
    // and last listen may have moved inwards (read from their own listens).
    "DELETE FROM roll_songs WHERE streams <= 0",
    `WITH f AS (SELECT song, p, MIN(ts) AS f, MAX(ts) AS la, date(MIN(lt) / 1000, 'unixepoch') AS fd
                  FROM (${s.periods(`SELECT ${LCOLS} FROM listens l
                                      WHERE l.song_id IN (SELECT song_id FROM roll_log WHERE listen_id <= ?3) AND l.dup_of IS NULL
                                        AND l.kind = 'track' AND l.id <= MAX(${WM}, ?1)`)})
                 GROUP BY song, p)
     UPDATE roll_songs SET first_ts = f.f, last_ts = f.la, first_day = f.fd FROM f
      WHERE roll_songs.song_id = f.song AND roll_songs.p = f.p
        AND (roll_songs.first_ts != f.f OR roll_songs.last_ts != f.la OR roll_songs.first_day != f.fd)`,
  );
  out.push(
    addInto({
      with: X,
      table: "roll_episodes",
      keys: [["episode_id", "ep"], ["p", "p"]],
      sums: [
        ["ms", "sign * ms"],
        ["streams", "sign"],
      ],
      extra: [
        firstLast("roll_episodes")[1]!,
        ["kind", "MIN(kind)", "CASE WHEN excluded.kind < roll_episodes.kind THEN excluded.kind ELSE roll_episodes.kind END"],
      ],
      from: "x",
      where: "counted AND kind != 'track' AND ep IS NOT NULL",
    }),
    "DELETE FROM roll_episodes WHERE streams <= 0",
    `WITH f AS (SELECT ep, p, MAX(ts) AS la
                  FROM (${s.periods(`SELECT ${LCOLS} FROM listens l
                                      WHERE l.episode_id IN (SELECT episode_id FROM roll_log WHERE listen_id <= ?3 AND episode_id IS NOT NULL)
                                        AND l.dup_of IS NULL AND l.kind != 'track' AND l.id <= MAX(${WM}, ?1)`)})
                 GROUP BY ep, p)
     UPDATE roll_episodes SET last_ts = f.la FROM f
      WHERE roll_episodes.episode_id = f.ep AND roll_episodes.p = f.p AND roll_episodes.last_ts != f.la`,
  );

  // --- Facts that only depend on the listens themselves ------------------------
  out.push(
    addFacts(`${X}, y AS (SELECT * FROM x WHERE counted)`, [
      "SELECT p, 'tot' AS k, sign * ms AS ms, sign AS n FROM y",
      "SELECT p, 'plays', 0, sign FROM y WHERE ms >= 30000",
      `SELECT p, 'skips', 0, sign FROM y WHERE ${SKIP}`,
      "SELECT p, 'spoken', sign * ms, sign FROM y WHERE kind != 'track'",
      "SELECT p, 'mt', sign * ms, sign FROM y WHERE kind = 'track'",
      "SELECT p, 'detailed', 0, sign FROM y WHERE platform IS NOT NULL",
      "SELECT p, 'shuffle', sign * shuffle, sign FROM y WHERE shuffle IS NOT NULL",
      "SELECT p, 'offline', sign * offline, sign FROM y WHERE offline IS NOT NULL",
      "SELECT p, 'src:' || source, 0, sign FROM y",
      `SELECT p, 'c:' || ${WDX} || ':' || ${HOURX}, sign * ms, sign FROM y`,
      `SELECT p, 'mh:' || ${HOURX}, sign * ms, sign FROM y WHERE kind = 'track'`,
      "SELECT p, 'pf:' || platform, sign * ms, sign FROM y WHERE platform IS NOT NULL",
      "SELECT p, 'cc:' || country, sign * ms, sign FROM y WHERE country IS NOT NULL",
      "SELECT p, 'rs:' || rs, 0, sign FROM y WHERE rs IS NOT NULL",
      "SELECT p, 're:' || re, 0, sign FROM y WHERE re IS NOT NULL",
    ]),
  );

  // --- Audio features (mood) ---------------------------------------------------
  const fcols = (a: string) => FEATURES.map((f) => `${a}.${f}`).join(", ");
  const FEAT = `${X},
    ds AS (SELECT key AS song FROM roll_dirty WHERE kind = 'feat'),
    a AS (${s.periods(applied("SELECT song FROM ds"))}),
    r AS (
      SELECT x.sign, x.p, x.ms, x.lt, x.lm, ${fcols("f")} FROM x JOIN audio_features f ON f.track_id = x.song
       WHERE x.counted AND x.kind = 'track'
      UNION ALL
      SELECT -1, a.p, a.ms, a.lt, a.lm, ${fcols("f")} FROM a JOIN roll_old_feat f ON f.track_id = a.song
       WHERE a.counted AND a.kind = 'track'
      UNION ALL
      SELECT 1, a.p, a.ms, a.lt, a.lm, ${fcols("f")} FROM a JOIN audio_features f ON f.track_id = a.song
       WHERE a.counted AND a.kind = 'track')`;
  const QUADRANT = `CASE WHEN energy >= 0.8 AND valence >= 0.5 THEN 'energetic' WHEN energy >= 0.5 AND valence >= 0.5 THEN 'happy'
                         WHEN energy >= 0.5 THEN 'tense' WHEN valence >= 0.5 THEN 'calm' ELSE 'sad' END`;
  out.push(
    addFacts(FEAT, [
      ...FEATURES.map((f) => `SELECT p, 'mf:${f}' AS k, sign * ${f} * ms AS ms, sign * ms AS n FROM r WHERE ${f} IS NOT NULL`),
      `SELECT p, 'mhe:' || ${HOURX}, sign * energy * ms, sign * ms FROM r WHERE energy IS NOT NULL`,
      `SELECT p, 'mhv:' || ${HOURX}, sign * valence * ms, sign * ms FROM r WHERE valence IS NOT NULL`,
      "SELECT p, 'meh:' || MIN(CAST(energy * 10 AS INTEGER), 9), sign * ms, 0 FROM r WHERE energy IS NOT NULL",
      "SELECT p, 'mvh:' || MIN(CAST(valence * 10 AS INTEGER), 9), sign * ms, 0 FROM r WHERE valence IS NOT NULL",
      "SELECT p, 'mth:' || MIN(MAX(CAST((tempo - 60) / 10 AS INTEGER), 0), 13), sign * ms, 0 FROM r WHERE tempo IS NOT NULL AND tempo > 0",
      `SELECT p, 'mq:' || ${QUADRANT}, sign * ms, 0 FROM r WHERE energy IS NOT NULL AND valence IS NOT NULL`,
    ]),
    addInto({
      with: FEAT,
      table: "roll_days",
      keys: [["day", DAYX]],
      sums: [
        ["e_sum", "CASE WHEN energy IS NOT NULL THEN sign * energy * ms ELSE 0 END"],
        ["e_ms", "CASE WHEN energy IS NOT NULL THEN sign * ms ELSE 0 END"],
        ["v_sum", "CASE WHEN valence IS NOT NULL THEN sign * valence * ms ELSE 0 END"],
        ["v_ms", "CASE WHEN valence IS NOT NULL THEN sign * ms ELSE 0 END"],
        ["d_sum", "CASE WHEN danceability IS NOT NULL THEN sign * danceability * ms ELSE 0 END"],
        ["d_ms", "CASE WHEN danceability IS NOT NULL THEN sign * ms ELSE 0 END"],
      ],
      from: "r",
      where: "p != 0",
    }),
  );

  // --- Deezer genres (per track, split evenly between its genres) ----------------
  const DEEZER = `${X},
    ds AS (SELECT key AS song FROM roll_dirty WHERE kind = 'tg'),
    a AS (${s.periods(applied("SELECT song FROM ds"))}),
    cur AS (SELECT track_id, genre, 1.0 / COUNT(*) OVER (PARTITION BY track_id) AS w FROM track_genres
             WHERE track_id IN (SELECT song FROM x UNION SELECT song FROM ds)),
    old AS (SELECT track_id, genre, 1.0 / COUNT(*) OVER (PARTITION BY track_id) AS w FROM roll_old_tg),
    r AS (
      SELECT x.sign, x.p, x.ms, x.lt, g.genre, g.w FROM x JOIN cur g ON g.track_id = x.song WHERE x.counted AND x.kind = 'track'
      UNION ALL
      SELECT -1, a.p, a.ms, a.lt, g.genre, g.w FROM a JOIN old g ON g.track_id = a.song WHERE a.counted AND a.kind = 'track'
      UNION ALL
      SELECT 1, a.p, a.ms, a.lt, g.genre, g.w FROM a JOIN cur g ON g.track_id = a.song WHERE a.counted AND a.kind = 'track')`;
  out.push(
    addFacts(DEEZER, [
      "SELECT p, 'gd:' || genre AS k, sign * ms * w AS ms, CASE WHEN ms >= 30000 THEN sign * w ELSE 0 END AS n FROM r",
      "SELECT p, 'gdc', sign * ms * w, 0 FROM r",
    ]),
    genreBuckets(DEEZER, "d"),
  );

  // --- MusicBrainz genres (per artist, split by votes) ---------------------------
  const MB = `${X},
    dt AS (SELECT key AS artist FROM roll_dirty WHERE kind = 'tags'),
    ds AS (SELECT key AS song FROM roll_dirty WHERE kind = 'ta'
           UNION SELECT track_id FROM track_artists WHERE artist_id IN (SELECT artist FROM dt)
           UNION SELECT track_id FROM roll_old_ta WHERE artist_id IN (SELECT artist FROM dt)),
    a AS (${s.periods(applied("SELECT song FROM ds"))}),
    curA AS (SELECT track_id, artist_id FROM track_artists WHERE track_id IN (SELECT song FROM x UNION SELECT song FROM ds)),
    oldA AS (SELECT track_id, artist_id FROM roll_old_ta
             UNION ALL
             SELECT track_id, artist_id FROM curA
              WHERE track_id IN (SELECT song FROM ds) AND track_id NOT IN (SELECT key FROM roll_dirty WHERE kind = 'ta')),
    curT AS (SELECT artist_id, tag, votes * 1.0 / SUM(votes) OVER (PARTITION BY artist_id) AS w FROM artist_tags
              WHERE artist_id IN (SELECT artist_id FROM curA)),
    oldT AS (SELECT artist_id, tag, votes * 1.0 / SUM(votes) OVER (PARTITION BY artist_id) AS w FROM (
               SELECT artist_id, tag, votes FROM roll_old_tags
               UNION ALL
               SELECT artist_id, tag, votes FROM artist_tags
                WHERE artist_id IN (SELECT artist_id FROM oldA) AND artist_id NOT IN (SELECT artist FROM dt))),
    r AS (
      SELECT x.sign, x.p, x.ms, x.lt, ar.artist_id, t.tag AS genre, t.w FROM x
        JOIN curA ar ON ar.track_id = x.song LEFT JOIN curT t ON t.artist_id = ar.artist_id
       WHERE x.counted AND x.kind = 'track'
      UNION ALL
      SELECT -1, a.p, a.ms, a.lt, ar.artist_id, t.tag, t.w FROM a
        JOIN oldA ar ON ar.track_id = a.song LEFT JOIN oldT t ON t.artist_id = ar.artist_id
       WHERE a.counted AND a.kind = 'track'
      UNION ALL
      SELECT 1, a.p, a.ms, a.lt, ar.artist_id, t.tag, t.w FROM a
        JOIN curA ar ON ar.track_id = a.song LEFT JOIN curT t ON t.artist_id = ar.artist_id
       WHERE a.counted AND a.kind = 'track')`;
  out.push(
    addFacts(MB, [
      "SELECT p, 'gm:' || genre AS k, sign * ms * w AS ms, CASE WHEN ms >= 30000 THEN sign * w ELSE 0 END AS n FROM r WHERE genre IS NOT NULL",
      "SELECT p, 'gmc', sign * ms * w, 0 FROM r WHERE genre IS NOT NULL",
      // Every artist credit counts towards the total, with genres or not (weights add up to 1).
      "SELECT p, 'gmt', sign * ms * COALESCE(w, 1), 0 FROM r",
    ]),
    genreBuckets(`${MB}, rg AS (SELECT * FROM r WHERE genre IS NOT NULL)`, "m", "rg"),
    addInto({
      with: MB,
      table: "roll_garts",
      keys: [["p", "p"], ["src", "'m'"], ["genre", "genre"], ["artist_id", "artist_id"]],
      sums: [
        ["ms", "sign * ms"],
        ["n", "sign"],
      ],
      from: "r",
      where: "genre IS NOT NULL",
    }),
  );

  // Deezer genre x artist: depends on the track's genres and its artists.
  out.push(
    addInto({
      with: `${X},
        ds AS (SELECT key AS song FROM roll_dirty WHERE kind IN ('tg', 'ta')),
        a AS (${s.periods(applied("SELECT song FROM ds"))}),
        curG AS (SELECT track_id, genre FROM track_genres WHERE track_id IN (SELECT song FROM x UNION SELECT song FROM ds)),
        curA AS (SELECT track_id, artist_id FROM track_artists WHERE track_id IN (SELECT song FROM x UNION SELECT song FROM ds)),
        oldG AS (SELECT track_id, genre FROM roll_old_tg
                 UNION ALL
                 SELECT track_id, genre FROM curG
                  WHERE track_id IN (SELECT song FROM ds) AND track_id NOT IN (SELECT key FROM roll_dirty WHERE kind = 'tg')),
        oldA AS (SELECT track_id, artist_id FROM roll_old_ta
                 UNION ALL
                 SELECT track_id, artist_id FROM curA
                  WHERE track_id IN (SELECT song FROM ds) AND track_id NOT IN (SELECT key FROM roll_dirty WHERE kind = 'ta')),
        r AS (
          SELECT x.sign, x.p, x.ms, g.genre, ar.artist_id FROM x
            JOIN curG g ON g.track_id = x.song JOIN curA ar ON ar.track_id = x.song
           WHERE x.counted AND x.kind = 'track'
          UNION ALL
          SELECT -1, a.p, a.ms, g.genre, ar.artist_id FROM a
            JOIN oldG g ON g.track_id = a.song JOIN oldA ar ON ar.track_id = a.song
           WHERE a.counted AND a.kind = 'track'
          UNION ALL
          SELECT 1, a.p, a.ms, g.genre, ar.artist_id FROM a
            JOIN curG g ON g.track_id = a.song JOIN curA ar ON ar.track_id = a.song
           WHERE a.counted AND a.kind = 'track')`,
      table: "roll_garts",
      keys: [["p", "p"], ["src", "'d'"], ["genre", "genre"], ["artist_id", "artist_id"]],
      sums: [
        ["ms", "sign * ms"],
        ["n", "sign"],
      ],
      from: "r",
    }),
    "DELETE FROM roll_garts WHERE n = 0",
  );

  // --- Artists, albums and shows: summed again from the song/episode totals ------
  // CROSS JOIN keeps SQLite on the artist's (album's, show's) own tracks first.
  // Left to choose, it walked every song of the period for each artist (an
  // index search on p, so no SCAN), which took 30 s per fold on D1.
  const TOUCHED = `touched AS (SELECT DISTINCT song, ep FROM (${CHANGES}))`;
  const ARTISTS = `${TOUCHED},
    aff AS (SELECT key AS id FROM roll_dirty WHERE kind = 'art'
            UNION SELECT artist_id FROM track_artists WHERE track_id IN (SELECT song FROM touched))`;
  out.push(
    `WITH ${ARTISTS},
       agg AS (SELECT ta.artist_id AS id, s.p, SUM(s.ms) AS ms, SUM(s.plays) AS plays, SUM(s.streams) AS streams,
                      COUNT(*) AS tracks, MIN(s.first_ts) AS f, MAX(s.last_ts) AS la, MIN(s.first_day) AS fd
                 FROM track_artists ta CROSS JOIN roll_songs s ON s.song_id = ta.track_id
                WHERE ta.artist_id IN (SELECT id FROM aff) GROUP BY ta.artist_id, s.p)
     INSERT INTO roll_artists (artist_id, p, ms, plays, streams, tracks, first_ts, last_ts, first_day)
     SELECT id, p, ms, plays, streams, tracks, f, la, fd FROM agg WHERE true
     ON CONFLICT (artist_id, p) DO UPDATE SET
       ms = excluded.ms, plays = excluded.plays, streams = excluded.streams, tracks = excluded.tracks,
       first_ts = excluded.first_ts, last_ts = excluded.last_ts, first_day = excluded.first_day
     WHERE ms != excluded.ms OR plays != excluded.plays OR streams != excluded.streams OR tracks != excluded.tracks
        OR first_ts != excluded.first_ts OR last_ts != excluded.last_ts OR first_day != excluded.first_day`,
    `WITH ${ARTISTS}
     DELETE FROM roll_artists WHERE artist_id IN (SELECT id FROM aff)
       AND NOT EXISTS (SELECT 1 FROM track_artists ta CROSS JOIN roll_songs s ON s.song_id = ta.track_id AND s.p = roll_artists.p
                        WHERE ta.artist_id = roll_artists.artist_id)`,
  );
  const ALBUMS = `${TOUCHED},
    aff AS (SELECT key AS id FROM roll_dirty WHERE kind = 'alb'
            UNION SELECT album_id FROM tracks WHERE id IN (SELECT song FROM touched) AND album_id IS NOT NULL)`;
  out.push(
    `WITH ${ALBUMS},
       agg AS (SELECT t.album_id AS id, s.p, SUM(s.ms) AS ms, SUM(s.plays) AS plays, SUM(s.streams) AS streams,
                      COUNT(*) AS tracks, MIN(s.first_ts) AS f, MAX(s.last_ts) AS la
                 FROM tracks t CROSS JOIN roll_songs s ON s.song_id = t.id
                WHERE t.album_id IN (SELECT id FROM aff) GROUP BY t.album_id, s.p)
     INSERT INTO roll_albums (album_id, p, ms, plays, streams, tracks, first_ts, last_ts)
     SELECT id, p, ms, plays, streams, tracks, f, la FROM agg WHERE true
     ON CONFLICT (album_id, p) DO UPDATE SET
       ms = excluded.ms, plays = excluded.plays, streams = excluded.streams, tracks = excluded.tracks,
       first_ts = excluded.first_ts, last_ts = excluded.last_ts
     WHERE ms != excluded.ms OR plays != excluded.plays OR streams != excluded.streams OR tracks != excluded.tracks
        OR first_ts != excluded.first_ts OR last_ts != excluded.last_ts`,
    `WITH ${ALBUMS}
     DELETE FROM roll_albums WHERE album_id IN (SELECT id FROM aff)
       AND NOT EXISTS (SELECT 1 FROM tracks t CROSS JOIN roll_songs s ON s.song_id = t.id AND s.p = roll_albums.p
                        WHERE t.album_id = roll_albums.album_id)`,
  );
  const SHOWS = `${TOUCHED},
    aff AS (SELECT key AS id FROM roll_dirty WHERE kind = 'show'
            UNION SELECT show_id FROM episodes WHERE id IN (SELECT ep FROM touched) AND show_id IS NOT NULL)`;
  out.push(
    `WITH ${SHOWS},
       agg AS (SELECT e.show_id AS id, x.p, SUM(x.ms) AS ms, COUNT(*) AS episodes, MAX(x.last_ts) AS la, MIN(x.kind) AS kind
                 FROM episodes e CROSS JOIN roll_episodes x ON x.episode_id = e.id
                WHERE e.show_id IN (SELECT id FROM aff) GROUP BY e.show_id, x.p)
     INSERT INTO roll_shows (show_id, p, ms, episodes, last_ts, kind)
     SELECT id, p, ms, episodes, la, kind FROM agg WHERE true
     ON CONFLICT (show_id, p) DO UPDATE SET
       ms = excluded.ms, episodes = excluded.episodes, last_ts = excluded.last_ts, kind = excluded.kind
     WHERE ms != excluded.ms OR episodes != excluded.episodes OR last_ts != excluded.last_ts OR kind != excluded.kind`,
    `WITH ${SHOWS}
     DELETE FROM roll_shows WHERE show_id IN (SELECT id FROM aff)
       AND NOT EXISTS (SELECT 1 FROM episodes e CROSS JOIN roll_episodes x ON x.episode_id = e.id AND x.p = roll_shows.p
                        WHERE e.show_id = roll_shows.show_id)`,
  );

  // Enrichment works through tracks and artists in order of all-time listening.
  out.push(
    `WITH ${TOUCHED}
     UPDATE tracks SET priority = COALESCE((SELECT ms FROM roll_songs WHERE song_id = tracks.id AND p = 0), 0)
      WHERE id IN (SELECT song FROM touched)
        AND priority != COALESCE((SELECT ms FROM roll_songs WHERE song_id = tracks.id AND p = 0), 0)`,
    `WITH ${ARTISTS}
     UPDATE artists SET priority = COALESCE((SELECT ms FROM roll_artists WHERE artist_id = artists.id AND p = 0), 0)
      WHERE id IN (SELECT id FROM aff)
        AND priority != COALESCE((SELECT ms FROM roll_artists WHERE artist_id = artists.id AND p = 0), 0)`,
  );

  // --- Bookkeeping ---------------------------------------------------------------
  out.push(
    "DELETE FROM roll_days WHERE streams = 0 AND dups = 0 AND new_songs = 0 AND new_artists = 0",
    // Every period this fold touched gets a new version (KV keys of stored answers).
    `WITH ${X},
       ds AS (SELECT key AS song FROM roll_dirty WHERE kind IN ('feat', 'tg', 'ta')
              UNION SELECT track_id FROM track_artists WHERE artist_id IN (SELECT key FROM roll_dirty WHERE kind IN ('tags', 'art'))
              UNION SELECT id FROM tracks WHERE album_id IN (SELECT key FROM roll_dirty WHERE kind = 'alb'))
     INSERT INTO roll_pv (p, v)
     SELECT DISTINCT p, 1 FROM (
       SELECT p FROM x
       UNION SELECT p FROM roll_songs WHERE song_id IN (SELECT song FROM ds)
       UNION SELECT p FROM roll_episodes WHERE episode_id IN (SELECT id FROM episodes WHERE show_id IN (SELECT key FROM roll_dirty WHERE kind = 'show'))
     ) WHERE true
     ON CONFLICT (p) DO UPDATE SET v = v + 1`,
    `INSERT INTO roll_sess_dirty (lo, hi)
     SELECT lo, hi FROM (SELECT MIN(ts - ms) AS lo, MAX(ts) AS hi FROM (${CHANGES})) WHERE lo IS NOT NULL`,
    "DELETE FROM roll_log WHERE listen_id <= ?3",
    "DELETE FROM roll_dirty",
    "DELETE FROM roll_old_ta",
    "DELETE FROM roll_old_tg",
    "DELETE FROM roll_old_tags",
    "DELETE FROM roll_old_feat",
    `UPDATE sync_state SET value = MAX(CAST(value AS INTEGER), ?1), updated_at = ?2 WHERE key = '${STATE_ROLL_WM}'`,
  );
  return out;
}

/** Genre timeline rows: per genre, plus '*' (all genres together), by week and by month. */
function genreBuckets(withClause: string, src: "d" | "m", rows = "r"): string {
  return `WITH ${withClause}
INSERT INTO roll_gb (src, genre, b, ms)
SELECT * FROM (SELECT '${src}' AS src, genre, b, SUM(ms) AS ms FROM (
    SELECT genre, ${WEEKB} AS b, sign * ms * w AS ms FROM ${rows} WHERE p != 0
    UNION ALL SELECT genre, ${MONTHB}, sign * ms * w FROM ${rows} WHERE p != 0
    UNION ALL SELECT '*', ${WEEKB}, sign * ms * w FROM ${rows} WHERE p != 0
    UNION ALL SELECT '*', ${MONTHB}, sign * ms * w FROM ${rows} WHERE p != 0
  ) GROUP BY genre, b) WHERE ms != 0
ON CONFLICT (src, genre, b) DO UPDATE SET ms = ms + excluded.ms`;
}

// ---------------------------------------------------------------------------
// Running folds
// ---------------------------------------------------------------------------

const ROLL_TABLES = [
  // Entity totals first: their triggers write into roll_days / roll_facts, cleared after.
  "roll_sessions",
  "roll_garts",
  "roll_artists",
  "roll_albums",
  "roll_shows",
  "roll_episodes",
  "roll_songs",
  "roll_days",
  "roll_facts",
  "roll_gb",
  "roll_log",
  "roll_dirty",
  "roll_old_ta",
  "roll_old_tg",
  "roll_old_tags",
  "roll_old_feat",
  "roll_sess_dirty",
];

interface RollState {
  wm: number;
  top: number;
  pending: boolean;
  /** The highest roll_log entry the next fold takes in (all of them when the log is short). */
  logCut: number;
  ready: boolean;
  def: string | null;
}

async function rollState(env: Env, logChunk = LOG_CHUNK): Promise<RollState> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COALESCE(MAX(id), 0) FROM listens) AS top,
            (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key = ?1) AS wm,
            (SELECT value FROM sync_state WHERE key = ?2) AS ready,
            (SELECT value FROM sync_state WHERE key = ?3) AS def,
            (EXISTS (SELECT 1 FROM roll_log) OR EXISTS (SELECT 1 FROM roll_dirty)) AS pending,
            (SELECT listen_id FROM roll_log ORDER BY listen_id LIMIT 1 OFFSET ?4) AS cut`,
  )
    .bind(STATE_ROLL_WM, STATE_ROLL_READY, STATE_ROLL_DEF, logChunk - 1)
    .first<{ top: number; wm: number | null; ready: string | null; def: string | null; pending: number; cut: number | null }>();
  return {
    top: row?.top ?? 0,
    wm: row?.wm ?? -1,
    pending: Boolean(row?.pending),
    logCut: row?.cut ?? Number.MAX_SAFE_INTEGER,
    ready: row?.ready === "1",
    def: row?.def ?? null,
  };
}

/**
 * Empty every stored total and start the build over (first run, or the
 * definition or time zone changed). Every statement re-checks the definition,
 * so of two runs that start a build at once (the minute cron and the hourly
 * one), the second does nothing instead of wiping the first one's progress.
 */
async function resetRollups(env: Env, def: string, now: number): Promise<void> {
  const stale = `((SELECT value FROM sync_state WHERE key = '${STATE_ROLL_DEF}') IS NOT ?1
                  OR NOT EXISTS (SELECT 1 FROM sync_state WHERE key = '${STATE_ROLL_WM}'))`;
  const guarded = (sql: string) => env.DB.prepare(`${sql} WHERE ${stale}`).bind(def);
  const state = (key: string, value: string) =>
    env.DB.prepare(
      `INSERT INTO sync_state (key, value, updated_at) SELECT ?2, ?3, ?4 WHERE ${stale}
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(def, key, value, now);
  await env.DB.batch([
    // Stop the change triggers first: nothing is counted any more.
    env.DB.prepare(`DELETE FROM sync_state WHERE key = ?2 AND ${stale}`).bind(def, STATE_ROLL_WM),
    ...ROLL_TABLES.map((t) => guarded(`DELETE FROM ${t}`)),
    guarded("UPDATE roll_pv SET v = v + 1"),
    state(STATE_ROLL_READY, "0"),
    state(STATE_ROLL_WM, "0"),
    state(STATE_ROLL_DEF, def), // last: what the others check
  ]);
}

export interface FoldResult {
  /** Folds run (one D1 batch each). */
  folds: number;
  /** Highest listens.id now included. */
  watermark: number;
  /** Listens not included yet (the build continues on the next run). */
  behind: number;
  ready: boolean;
  rebuilt: boolean;
  sessions: number;
}

/**
 * Bring the stored totals up to date: rebuild if needed, fold what changed, and
 * work out the touched sessions again. Stops after `budgetMs` (the rest is
 * picked up by the next run). Cheap when there is nothing to do: one read.
 */
export async function foldRollups(
  env: Env,
  opts: { now?: number; budgetMs?: number; chunk?: number; logChunk?: number } = {},
): Promise<FoldResult> {
  const now = opts.now ?? Date.now();
  const budget = opts.budgetMs ?? 60_000;
  const chunk = opts.chunk ?? BUILD_CHUNK;
  const logChunk = opts.logChunk ?? LOG_CHUNK;
  const started = Date.now();
  const tz = statsTimeZone(env);
  const def = rollDefinition(tz);

  let st = await rollState(env, logChunk);
  let rebuilt = false;
  if (st.def !== def || st.wm < 0) {
    await resetRollups(env, def, now);
    rebuilt = true;
    st = await rollState(env, logChunk);
  }

  // D1 wants exactly as many values as the highest ?N a statement uses.
  const statements = foldStatements(tz, now).map((sql) => ({ sql, params: Math.max(0, ...[...sql.matchAll(/\?(\d)/g)].map((m) => Number(m[1]))) }));
  let folds = 0;
  while (st.top > st.wm || st.pending) {
    const binds = [Math.min(st.top, st.wm + chunk), now, st.logCut];
    await env.DB.batch(statements.map(({ sql, params }) => (params ? env.DB.prepare(sql).bind(...binds.slice(0, params)) : env.DB.prepare(sql))));
    folds++;
    const before = st;
    st = await rollState(env, logChunk);
    if (Date.now() - started > budget) break;
    // Nothing moved (shouldn't happen): stop rather than spin until the budget runs out.
    if (st.wm === before.wm && !before.pending) break;
  }

  if (!st.ready && st.top <= st.wm) {
    await env.DB.prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?1, '1', ?2)
       ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
    )
      .bind(STATE_ROLL_READY, now)
      .run();
    st.ready = true;
  }
  // While a build is still catching up its spans cover most of the timeline;
  // sessions are worked out once it has.
  const sessions = st.top <= st.wm ? await refreshSessions(env, tz) : 0;
  return { folds, watermark: st.wm, behind: Math.max(0, st.top - st.wm), ready: st.ready, rebuilt, sessions };
}

/** Whether the stored totals are built, for this definition and time zone. */
export async function rollupsReady(env: Env): Promise<boolean> {
  const { results } = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN (?1, ?2)")
    .bind(STATE_ROLL_READY, STATE_ROLL_DEF)
    .all<{ key: string; value: string | null }>();
  const get = (k: string) => results.find((r) => r.key === k)?.value;
  return get(STATE_ROLL_READY) === "1" && get(STATE_ROLL_DEF) === rollDefinition(statsTimeZone(env));
}

/** How many listens the stored totals are behind (one read). */
export async function rollupBacklog(env: Env): Promise<{ behind: number; pending: boolean; built: boolean }> {
  const st = await rollState(env);
  return { behind: st.wm < 0 ? st.top : Math.max(0, st.top - st.wm), pending: st.pending, built: st.ready };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface Span {
  lo: number;
  hi: number;
}

/** Work out the sessions in every span a fold touched again. Returns how many sessions were written. */
export async function refreshSessions(env: Env, tz: string): Promise<number> {
  const { results: dirty } = await env.DB.prepare("SELECT id, lo, hi FROM roll_sess_dirty ORDER BY lo").all<{ id: number; lo: number; hi: number }>();
  if (!dirty.length) return 0;
  const maxId = Math.max(...dirty.map((d) => d.id));

  // Merge spans that could share a session.
  const spans: Span[] = [];
  for (const d of dirty) {
    const last = spans[spans.length - 1];
    if (last && d.lo <= last.hi + SESSION_GAP_MS) last.hi = Math.max(last.hi, d.hi);
    else spans.push({ lo: d.lo, hi: d.hi });
  }

  const writes: D1PreparedStatement[] = [];
  const periods = new Set<number>([0]);
  let written = 0;
  for (const span of spans) {
    // Widen to the sessions the span touches: the one running into it, and any starting inside it.
    const [before, inside] = await env.DB.batch([
      env.DB.prepare("SELECT start, end, p FROM roll_sessions WHERE start <= ?1 ORDER BY start DESC LIMIT 1").bind(span.lo),
      env.DB.prepare("SELECT start, end, p FROM roll_sessions WHERE start > ?1 AND start <= ?2").bind(span.lo, span.hi + SESSION_GAP_MS),
    ]);
    let { lo, hi } = span;
    for (const s of [...((before?.results ?? []) as { start: number; end: number; p: number }[]), ...((inside?.results ?? []) as { start: number; end: number; p: number }[])]) {
      if (s.end < span.lo - SESSION_GAP_MS) continue;
      lo = Math.min(lo, s.start);
      hi = Math.max(hi, s.end);
      periods.add(s.p);
    }

    const sessions: { start: number; end: number; ms: number; p: number }[] = [];
    let cur: { start: number; end: number; ms: number } | null = null;
    let prevTs: number | null = null;
    for (let after = lo - 1; ; ) {
      // Paged by ts so a whole-history span (the first build) never loads at once.
      const { results } = await env.DB.prepare(
        `SELECT ts, ms_played AS ms FROM listens WHERE dup_of IS NULL AND ts > ?1 AND ts <= ?2 ORDER BY ts LIMIT 20000`,
      )
        .bind(after, hi)
        .all<{ ts: number; ms: number }>();
      for (const l of results) {
        if (prevTs === null || l.ts - l.ms - prevTs > SESSION_GAP_MS) {
          if (cur) sessions.push({ ...cur, p: localYear(tz, cur.start) });
          cur = { start: l.ts - l.ms, end: l.ts, ms: 0 };
        }
        cur!.start = Math.min(cur!.start, l.ts - l.ms);
        cur!.end = Math.max(cur!.end, l.ts);
        cur!.ms += l.ms;
        prevTs = l.ts;
      }
      if (results.length < 20000) break;
      after = results[results.length - 1]!.ts;
    }
    if (cur) sessions.push({ ...cur, p: localYear(tz, cur.start) });

    writes.push(env.DB.prepare("DELETE FROM roll_sessions WHERE start >= ?1 AND start <= ?2").bind(lo, hi));
    for (let i = 0; i < sessions.length; i += 2000) {
      const chunk = sessions.slice(i, i + 2000).map((x) => [x.start, x.end, x.ms, x.p]);
      writes.push(
        env.DB.prepare(
          `INSERT INTO roll_sessions (start, end, ms, p)
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
             FROM json_each(?1) WHERE true
           ON CONFLICT (start) DO UPDATE SET end = excluded.end, ms = excluded.ms, p = excluded.p`,
        ).bind(JSON.stringify(chunk)),
      );
    }
    for (const x of sessions) periods.add(x.p);
    written += sessions.length;
  }
  writes.push(env.DB.prepare("DELETE FROM roll_sess_dirty WHERE id <= ?1").bind(maxId));
  writes.push(
    env.DB.prepare(
      `INSERT INTO roll_pv (p, v) SELECT value, 1 FROM json_each(?1) WHERE true ON CONFLICT (p) DO UPDATE SET v = v + 1`,
    ).bind(JSON.stringify([...periods])),
  );
  await env.DB.batch(writes);
  return written;
}
