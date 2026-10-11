import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { CleanupResult, DataStatusResponse } from "@shared/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiPost } from "../../lib/api";
import { fmtInt, fmtRelative } from "../../lib/format";

const LOOKUPS: { key: keyof DataStatusResponse["waitingUntil"]; label: string; note: string }[] = [
  { key: "spotify", label: "Spotify", note: "Track details, artwork, artist photos, name-only matches" },
  { key: "deezer", label: "Deezer", note: "Broad genres, once a track has its Spotify details" },
  { key: "features", label: "Audio features", note: "ReccoBeats, or analysis of Deezer's preview" },
  { key: "musicbrainz", label: "MusicBrainz", note: "Detailed genres" },
];

export function Enrichment({ status }: { status: DataStatusResponse }) {
  const [running, setRunning] = useState(false);
  const client = useQueryClient();

  const cleanup = async () => {
    setRunning(true);
    try {
      const r = await apiPost<CleanupResult>("/api/maintenance/cleanup");
      toast.success(
        `Cleanup done: ${fmtInt(r.duplicates)} duplicates hidden, ${fmtInt(r.resolvedByName)} matched by name, ${fmtInt(r.mergedArtists)} artists merged`,
      );
      await client.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cleanup failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Background lookups</CardTitle>
        <CardDescription>
          Artwork, genres and audio features, filled in a little every minute.
          {status.lastPumpAt ? ` Last step ${fmtRelative(status.lastPumpAt)}.` : ""}
        </CardDescription>
        <CardAction>
          <Button size="sm" variant="outline" onClick={() => void cleanup()} disabled={running}>
            <Sparkles /> {running ? "Cleaning up…" : "Run cleanup now"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {LOOKUPS.map((l) => {
          const until = status.waitingUntil[l.key];
          return (
            <div key={l.key} className="flex items-baseline justify-between gap-3 text-sm">
              <div>
                <div>{l.label}</div>
                <div className="text-xs text-muted-foreground">{l.note}</div>
              </div>
              {until ? (
                <Badge variant="outline" className="shrink-0">
                  Rate limited, next try {fmtRelative(until)}
                </Badge>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">OK</span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
