// Typed TanStack Query hooks, one per endpoint in src/shared/api.ts.
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  AdminUsersResponse,
  AlbumDetailResponse,
  ArtistDetailResponse,
  Bucket,
  ClockResponse,
  DataStatusResponse,
  GenreSource,
  GenreTimelineResponse,
  HabitsResponse,
  HistoryResponse,
  MoodResponse,
  NowResponse,
  OverviewResponse,
  PodcastsResponse,
  SearchResponse,
  SpotifyTopResponse,
  SummaryResponse,
  TimelineResponse,
  TopAlbumsResponse,
  TopArtistsResponse,
  TopGenresResponse,
  TopTracksResponse,
  TrackDetailResponse,
} from "@shared/api";
import { HISTORY_PAGE_SIZE } from "@shared/api";
import { api, type Params } from "../lib/api";
import type { ResolvedRange } from "../lib/range";

const rp = (r: ResolvedRange) => ({ from: r.from, to: r.to, tz: r.tz });

function useApi<T>(path: string, params?: Params, opts: { enabled?: boolean; refetchInterval?: number; keep?: boolean } = {}) {
  return useQuery({
    queryKey: [path, params ?? {}],
    queryFn: ({ signal }) => api<T>(path, params, signal),
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval,
    placeholderData: opts.keep === false ? undefined : keepPreviousData,
  });
}

export const useSummary = () => useApi<SummaryResponse>("/api/summary", undefined, { keep: false });

export const useOverview = (r: ResolvedRange) => useApi<OverviewResponse>("/api/overview", rp(r));

export interface EntityFilter {
  artist?: string;
  track?: string;
  album?: string;
  genre?: string;
  genreSource?: GenreSource;
}

export const useTimeline = (r: ResolvedRange, bucket: Bucket, filter: EntityFilter = {}) =>
  useApi<TimelineResponse>("/api/timeline", { ...rp(r), bucket, ...filter });

export interface ListOpts {
  limit?: number;
  offset?: number;
  q?: string;
  sort?: string;
  artist?: string;
  album?: string;
}

export const useTopArtists = (r: ResolvedRange, o: ListOpts = {}) =>
  useApi<TopArtistsResponse>("/api/top/artists", { ...rp(r), limit: 10, ...o });
export const useTopTracks = (r: ResolvedRange, o: ListOpts = {}) =>
  useApi<TopTracksResponse>("/api/top/tracks", { ...rp(r), limit: 10, ...o });
export const useTopAlbums = (r: ResolvedRange, o: ListOpts = {}) =>
  useApi<TopAlbumsResponse>("/api/top/albums", { ...rp(r), limit: 10, ...o });
export const useTopGenres = (r: ResolvedRange, source: GenreSource, limit = 30) =>
  useApi<TopGenresResponse>("/api/top/genres", { ...rp(r), source, limit });
export const useGenreTimeline = (r: ResolvedRange, source: GenreSource, bucket: Bucket, top = 8) =>
  useApi<GenreTimelineResponse>("/api/genres/timeline", { ...rp(r), source, bucket, top });

export const useClock = (r: ResolvedRange, filter: { artist?: string; track?: string } = {}) =>
  useApi<ClockResponse>("/api/clock", { ...rp(r), ...filter });
export const useMood = (r: ResolvedRange) => useApi<MoodResponse>("/api/mood", rp(r));
export const useHabits = (r: ResolvedRange) => useApi<HabitsResponse>("/api/habits", rp(r));
export const usePodcasts = (r: ResolvedRange) => useApi<PodcastsResponse>("/api/podcasts", rp(r));

export const useArtist = (id: string) => useApi<ArtistDetailResponse>(`/api/artists/${encodeURIComponent(id)}`, undefined, { keep: false });
export const useTrack = (id: string) => useApi<TrackDetailResponse>(`/api/tracks/${encodeURIComponent(id)}`, undefined, { keep: false });
export const useAlbum = (id: string) => useApi<AlbumDetailResponse>(`/api/albums/${encodeURIComponent(id)}`, undefined, { keep: false });

export const useNowPlaying = () => useApi<NowResponse>("/api/now", undefined, { refetchInterval: 30_000 });
export const useSpotifyTop = () => useApi<SpotifyTopResponse>("/api/spotify-top", undefined, { keep: false });
export const useDataStatus = (poll = false) =>
  useApi<DataStatusResponse>("/api/data/status", undefined, { refetchInterval: poll ? 15_000 : 60_000, keep: false });

/** Admins only (the Worker answers 403 to anyone else, so don't even ask). */
export const ADMIN_USERS = "/api/admin/users";
export const useAdminUsers = (enabled: boolean) => useApi<AdminUsersResponse>(ADMIN_USERS, undefined, { enabled, keep: false });

export const useSearch = (q: string) =>
  useApi<SearchResponse>("/api/search", { q }, { enabled: q.trim().length >= 2 });

export interface HistoryFilters {
  q?: string;
  kind?: string;
  source?: string;
  skipped?: boolean;
  includeDuplicates?: boolean;
  artist?: string;
  track?: string;
  album?: string;
}

export function useHistory(r: ResolvedRange, f: HistoryFilters) {
  const params = { ...rp(r), limit: HISTORY_PAGE_SIZE, ...f };
  return useInfiniteQuery({
    queryKey: ["/api/history", params],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api<HistoryResponse>("/api/history", { ...params, before: pageParam }, signal),
    getNextPageParam: (last) => last.nextBefore,
  });
}
