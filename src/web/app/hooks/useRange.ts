import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { resolveRange, type ResolvedRange } from "../lib/range";
import { effectiveTimeZone, useSettings } from "../lib/settings";
import { useNow } from "./useNow";
import { useSummary } from "./queries";

/** The global date range, resolved against the URL, the time zone and the data's first listen. */
export function useRange(): ResolvedRange {
  const [search] = useSearchParams();
  const settings = useSettings();
  const now = useNow();
  const summary = useSummary();
  const tz = effectiveTimeZone(settings);
  const firstTs = summary.data?.firstTs ?? null;
  const qs = search.toString();
  return useMemo(
    () => resolveRange(new URLSearchParams(qs), { now, tz, firstTs, defaultRange: settings.defaultRange }),
    [qs, now, tz, firstTs, settings.defaultRange],
  );
}

/** The `{from, to, tz}` triple every range endpoint takes. */
export function rangeParams(r: ResolvedRange) {
  return { from: r.from, to: r.to, tz: r.tz };
}
