import type { AudioFeatures } from "@shared/api";
import { fmtInt } from "../lib/format";

const ROWS: { key: keyof AudioFeatures; label: string; hint: string }[] = [
  { key: "energy", label: "Energy", hint: "Intensity and activity" },
  { key: "valence", label: "Happiness", hint: "Musical positivity (valence)" },
  { key: "danceability", label: "Danceability", hint: "Rhythm stability and beat strength" },
  { key: "acousticness", label: "Acousticness", hint: "Confidence the track is acoustic" },
  { key: "instrumentalness", label: "Instrumental", hint: "Likelihood of no vocals" },
  { key: "speechiness", label: "Speechiness", hint: "Presence of spoken words" },
  { key: "liveness", label: "Liveness", hint: "Presence of an audience" },
];

/** 0..1 audio features as labelled bars, plus tempo and loudness. */
export function FeatureBars({ features, compact }: { features: AudioFeatures; compact?: boolean }) {
  const rows = compact ? ROWS.slice(0, 4) : ROWS;
  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const v = features[r.key];
        return (
          <div key={r.key} title={r.hint}>
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-medium tabular">{v == null ? "—" : Math.round(v * 100)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary/80" style={{ width: `${v == null ? 0 : Math.round(v * 100)}%` }} />
            </div>
          </div>
        );
      })}
      {(features.tempo != null || features.loudness != null) && (
        <div className="flex gap-6 pt-1 text-xs text-muted-foreground">
          {features.tempo != null && (
            <span>
              Tempo <span className="font-medium text-foreground tabular">{fmtInt(features.tempo)} BPM</span>
            </span>
          )}
          {features.loudness != null && !compact && (
            <span>
              Loudness <span className="font-medium text-foreground tabular">{features.loudness.toFixed(1)} dB</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
