// Name normalisation and synthetic ids, shared by the Worker (import, cleanup)
// and the web app (export parsing). Both sides must agree byte-for-byte, which
// is why this lives in one file.

/** FNV-1a, 32-bit, hex. Only used to derive stable synthetic ids. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Comparison form of a track/artist/album name: diacritics stripped, lower-cased,
 * `&` read as "and", punctuation dropped, whitespace collapsed.
 *
 * Deliberately conservative: "(Live)" or "- Remastered 2011" are kept, because
 * stripping them would merge genuinely different recordings. The goal is to match
 * the same Spotify metadata written two ways, not to fuzzy-match.
 */
export function normName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Key used to match a name-only listen (Account data export) to a known track. */
export function trackNameKey(track: string | null | undefined, artist: string | null | undefined): string {
  return `${normName(track)}|${normName(artist)}`;
}

/**
 * Synthetic ids for entities known only by name. The `name:` prefix marks them
 * as "not a Spotify id": the Worker never sends them to Spotify, and the cleanup
 * pass replaces them with real ids once a match turns up.
 */
export const NAME_PREFIX = "name:";

export const artistStubId = (artist: string | null | undefined) => `${NAME_PREFIX}${fnv1aHex(normName(artist))}`;
export const albumStubId = (artist: string | null | undefined, album: string | null | undefined) =>
  `${NAME_PREFIX}${fnv1aHex(`${normName(artist)}|${normName(album)}`)}`;
export const trackStubId = (track: string | null | undefined, artist: string | null | undefined) =>
  `${NAME_PREFIX}${fnv1aHex(trackNameKey(track, artist))}`;
export const showStubId = (show: string | null | undefined) => `${NAME_PREFIX}${fnv1aHex(`show|${normName(show)}`)}`;
export const episodeStubId = (show: string | null | undefined, episode: string | null | undefined) =>
  `${NAME_PREFIX}${fnv1aHex(`episode|${normName(show)}|${normName(episode)}`)}`;

/** True for ids that are real Spotify ids (not `name:` / `local:` synthetics). */
export function isSpotifyId(id: string | null | undefined): id is string {
  return Boolean(id) && !id!.startsWith(NAME_PREFIX) && !id!.startsWith("local:");
}

/** `spotify:track:abc` -> `abc` when the URI has the expected type, else null. */
export function idFromUri(uri: string | null | undefined, type: "track" | "episode" | "show" | "artist" | "album"): string | null {
  if (!uri) return null;
  const parts = uri.split(":");
  if (parts.length === 3 && parts[0] === "spotify" && parts[1] === type && /^[A-Za-z0-9]{10,40}$/.test(parts[2]!)) {
    return parts[2]!;
  }
  return null;
}
