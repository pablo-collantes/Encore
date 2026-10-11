// Turn ids from an aggregate query into display objects (names, artwork,
// credits). Ids travel as one JSON parameter (json_each) because D1 caps a
// statement at 100 bound parameters.

import type { AlbumLite, ArtistLite, TrackLite } from "../../shared/api";
import type { Env } from "../types";

const uniq = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => Boolean(x)))];

export async function hydrateArtists(env: Env, ids: (string | null | undefined)[]): Promise<Map<string, ArtistLite>> {
  const list = uniq(ids);
  const out = new Map<string, ArtistLite>();
  if (!list.length) return out;
  const { results } = await env.DB.prepare(
    "SELECT id, name, image_url FROM artists WHERE id IN (SELECT value FROM json_each(?1))",
  )
    .bind(JSON.stringify(list))
    .all<{ id: string; name: string; image_url: string | null }>();
  for (const r of results) out.set(r.id, { id: r.id, name: r.name, imageUrl: r.image_url });
  return out;
}

interface TrackRow {
  id: string;
  name: string;
  duration_ms: number | null;
  album_id: string | null;
  album_name: string | null;
  album_image: string | null;
  release_year: number | null;
}

export async function hydrateTracks(env: Env, ids: (string | null | undefined)[]): Promise<Map<string, TrackLite>> {
  const list = uniq(ids);
  const out = new Map<string, TrackLite>();
  if (!list.length) return out;
  const j = JSON.stringify(list);
  const [tracks, credits] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.id, t.name, t.duration_ms, al.id AS album_id, al.name AS album_name,
              al.image_url AS album_image, al.release_year
         FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
        WHERE t.id IN (SELECT value FROM json_each(?1))`,
    ).bind(j),
    env.DB.prepare(
      `SELECT ta.track_id, a.id, a.name, a.image_url
         FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
        WHERE ta.track_id IN (SELECT value FROM json_each(?1))
        ORDER BY ta.track_id, ta.position`,
    ).bind(j),
  ]);
  const artistsByTrack = new Map<string, ArtistLite[]>();
  for (const r of (credits?.results ?? []) as { track_id: string; id: string; name: string; image_url: string | null }[]) {
    const arr = artistsByTrack.get(r.track_id) ?? [];
    arr.push({ id: r.id, name: r.name, imageUrl: r.image_url });
    artistsByTrack.set(r.track_id, arr);
  }
  for (const r of (tracks?.results ?? []) as TrackRow[]) {
    out.set(r.id, {
      id: r.id,
      name: r.name,
      durationMs: r.duration_ms,
      artists: artistsByTrack.get(r.id) ?? [],
      album: r.album_id
        ? { id: r.album_id, name: r.album_name ?? "", imageUrl: r.album_image, releaseYear: r.release_year }
        : null,
    });
  }
  return out;
}

export async function hydrateAlbums(env: Env, ids: (string | null | undefined)[]): Promise<Map<string, AlbumLite & { artists: ArtistLite[] }>> {
  const list = uniq(ids);
  const out = new Map<string, AlbumLite & { artists: ArtistLite[] }>();
  if (!list.length) return out;
  const j = JSON.stringify(list);
  const [albums, credits] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, name, image_url, release_year FROM albums WHERE id IN (SELECT value FROM json_each(?1))",
    ).bind(j),
    env.DB.prepare(
      `SELECT aa.album_id, a.id, a.name, a.image_url
         FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
        WHERE aa.album_id IN (SELECT value FROM json_each(?1))
        ORDER BY aa.album_id, aa.position`,
    ).bind(j),
  ]);
  const artistsByAlbum = new Map<string, ArtistLite[]>();
  for (const r of (credits?.results ?? []) as { album_id: string; id: string; name: string; image_url: string | null }[]) {
    const arr = artistsByAlbum.get(r.album_id) ?? [];
    arr.push({ id: r.id, name: r.name, imageUrl: r.image_url });
    artistsByAlbum.set(r.album_id, arr);
  }
  for (const r of (albums?.results ?? []) as { id: string; name: string; image_url: string | null; release_year: number | null }[]) {
    out.set(r.id, { id: r.id, name: r.name, imageUrl: r.image_url, releaseYear: r.release_year, artists: artistsByAlbum.get(r.id) ?? [] });
  }
  return out;
}

/** Placeholder for an id that vanished between the aggregate and the hydrate. */
export const missingTrack = (id: string): TrackLite => ({ id, name: "Unknown track", artists: [], album: null, durationMs: null });
