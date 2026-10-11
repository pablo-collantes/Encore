import type { TimelinePoint } from "@shared/api";

/** Sum a timeline into range totals (used where a detail endpoint reports all-time only). */
export function sumTimeline(points: TimelinePoint[] | undefined) {
  let ms = 0;
  let plays = 0;
  let streams = 0;
  for (const p of points ?? []) {
    ms += p.ms;
    plays += p.plays;
    streams += p.streams;
  }
  return { ms, plays, streams };
}
