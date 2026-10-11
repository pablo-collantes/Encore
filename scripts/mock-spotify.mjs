#!/usr/bin/env node
// Minimal stand-in for the Spotify Web API, for exercising the collectors
// locally without touching a real account.
//
//   node scripts/mock-spotify.mjs &                       # listens on :8788
//   # then set SPOTIFY_API_BASE=http://127.0.0.1:8788 in .dev.vars
//
// Flags:
//   --port <n>       listen port (default 8788)
//   --no-playback    respond 204 to /me/player (nothing playing)
//   --progress <ms>  progress_ms reported for the current track
//   --track <id>     which mock track is "playing"

import http from "node:http";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const port = Number(flag("port", 8788));
const noPlayback = argv.includes("--no-playback");
const progressMs = Number(flag("progress", 45000));
const playingTrackId = flag("track", "3n3Ppam7vgaVa1iaRUc9Lp");

const artist = (id, name) => ({ id, name, uri: `spotify:artist:${id}`, type: "artist" });

const album = (id, name, artists) => ({
  id,
  name,
  uri: `spotify:album:${id}`,
  album_type: "album",
  release_date: "2001-03-05",
  release_date_precision: "day",
  total_tracks: 12,
  images: [{ url: `https://i.example/${id}-640.jpg`, height: 640, width: 640 }],
  artists,
});

const track = (id, name, artists, alb, durationMs) => ({
  id,
  name,
  uri: `spotify:track:${id}`,
  type: "track",
  duration_ms: durationMs,
  explicit: false,
  popularity: 71,
  track_number: 4,
  disc_number: 1,
  external_ids: { isrc: `US${id.slice(0, 10).toUpperCase()}` },
  is_local: false,
  artists,
  album: alb,
});

const a1 = artist("22bE4uQ6baNwSHPVcDxLCe", "The Rolling Stones");
const a2 = artist("3WrFJ7ztbogyGnTHbHJFl2", "The Beatles");
const alb1 = album("6QaVfG1pHYl1z15ZxkvVDW", "Mock Album One", [a1]);
const alb2 = album("1klALx0u4AavZNEvC4LrTL", "Mock Album Two", [a2]);

const t1 = track(playingTrackId, "Mr. Brightside (Mock)", [a1, a2], alb1, 222075);
const t2 = track("7ouMYWpwJ422jRcDASZB7P", "Second Mock Song", [a2], alb2, 195000);

// Two completed plays, 6 and 3 minutes ago.
const now = Date.now();
const recentItems = [
  { track: t2, played_at: new Date(now - 6 * 60_000).toISOString(), context: { type: "playlist", uri: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M" } },
  { track: t1, played_at: new Date(now - 3 * 60_000).toISOString(), context: { type: "album", uri: `spotify:album:${alb1.id}` } },
];

let requestCount = 0;

const server = http.createServer((req, res) => {
  requestCount++;
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const send = (status, body) => {
    console.log(`[mock] ${status} ${req.method} ${url.pathname}${url.search}`);
    if (status === 204) return res.writeHead(204).end();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/me/player/recently-played") {
    const after = url.searchParams.get("after");
    const items = after
      ? recentItems.filter((i) => Date.parse(i.played_at) > Number(after))
      : recentItems;
    return send(200, {
      href: url.toString(),
      limit: Number(url.searchParams.get("limit") ?? 20),
      next: null,
      cursors: items.length
        ? { after: String(Date.parse(items.at(-1).played_at)), before: String(Date.parse(items[0].played_at)) }
        : null,
      total: items.length,
      items,
    });
  }

  if (url.pathname === "/me/player") {
    if (noPlayback) return send(204, null);
    return send(200, {
      device: { id: "mockdevice1", is_active: true, is_private_session: false, is_restricted: false, name: "Mock Laptop", type: "Computer", volume_percent: 65, supports_volume: true },
      repeat_state: "off",
      shuffle_state: true,
      context: { type: "album", uri: `spotify:album:${alb1.id}`, href: null, external_urls: {} },
      timestamp: now,
      progress_ms: progressMs,
      is_playing: true,
      item: t1,
      currently_playing_type: "track",
      actions: { pausing: true },
    });
  }

  if (url.pathname === "/artists") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    return send(200, {
      artists: ids.map((id) => {
        const base = [a1, a2].find((a) => a.id === id) ?? artist(id, `Mock Artist ${id.slice(0, 6)}`);
        return {
          ...base,
          genres: ["mock rock", "test pop"],
          popularity: 78,
          followers: { href: null, total: 1234567 },
          images: [{ url: `https://i.example/${id}-artist.jpg`, height: 640, width: 640 }],
        };
      }),
    });
  }

  if (url.pathname === "/albums") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    return send(200, {
      albums: ids.map((id) => {
        const base = [alb1, alb2].find((a) => a.id === id) ?? album(id, `Mock Album ${id.slice(0, 6)}`, [a1]);
        return { ...base, label: "Mock Records", popularity: 64, genres: [] };
      }),
    });
  }

  if (url.pathname === "/me") {
    return send(200, { id: "mockuser", display_name: "Mock User", country: "US" });
  }

  if (url.pathname === "/__count") return send(200, { requestCount });

  return send(404, { error: { status: 404, message: "mock: no such endpoint" } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] Spotify mock listening on http://127.0.0.1:${port}`);
  console.log(`[mock] recently-played returns ${recentItems.length} items; /me/player ${noPlayback ? "204 (idle)" : "200 (playing)"}`);
});
