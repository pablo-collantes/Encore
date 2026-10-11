import { useState } from "react";
import { KeyRound, List, ReceiptText } from "lucide-react";
import type { ArtistLite, SpotifyTimeRange, TrackLite } from "@shared/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Art } from "../components/Art";
import { ArtistLinks } from "../components/ArtistLinks";
import { PageHeader } from "../components/PageHeader";
import { artistHref, RLink, trackHref } from "../components/RLink";
import { ErrorState, RowsSkeleton } from "../components/States";
import { useSpotifyTop } from "../hooks/queries";
import { effectiveTimeZone, useSettings } from "../lib/settings";
import { fmtClock, fmtDateTime } from "../lib/format";
import { spotifyConnectHref, useIsAdmin } from "../lib/me";

const RANGES: { value: SpotifyTimeRange; label: string; receipt: string }[] = [
  { value: "short_term", label: "4 weeks", receipt: "LAST MONTH" },
  { value: "medium_term", label: "6 months", receipt: "LAST 6 MONTHS" },
  { value: "long_term", label: "About a year", receipt: "LAST YEAR" },
];

export default function SpotifyTop() {
  const q = useSpotifyTop();
  const isAdmin = useIsAdmin();
  const settings = useSettings();
  const tz = effectiveTimeZone(settings);
  const [range, setRange] = useState<SpotifyTimeRange>("short_term");
  const [view, setView] = useState<"lists" | "receipt">("lists");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spotify's top lists"
        description={
          q.data?.takenAt
            ? `Spotify's own ranking of your listening, as of ${fmtDateTime(q.data.takenAt, tz)}. Refreshed daily.`
            : "Spotify's own ranking of your listening, the same lists Receiptify and Wrapped-style apps show."
        }
        actions={
          q.data?.scopeGranted ? (
            <ToggleGroup type="single" size="sm" variant="outline" spacing={0} value={view} onValueChange={(v) => v && setView(v as "lists" | "receipt")} aria-label="View">
              <ToggleGroupItem value="lists" className="gap-1.5 px-3 text-xs">
                <List className="size-3.5" /> Lists
              </ToggleGroupItem>
              <ToggleGroupItem value="receipt" className="gap-1.5 px-3 text-xs">
                <ReceiptText className="size-3.5" /> Receipt
              </ToggleGroupItem>
            </ToggleGroup>
          ) : undefined
        }
      />

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <RowsSkeleton rows={10} />
      ) : !q.data.scopeGranted ? (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> One more permission needed
            </CardTitle>
            <CardDescription>
              Spotify only shares its top-tracks and top-artists lists with apps that have the “top read” permission.{" "}
              {isAdmin ? "Reconnect Spotify and approve it" : "Once an admin reconnects Spotify and approves it"}; the lists are then
              saved every day so you build up a history of them.
            </CardDescription>
          </CardHeader>
          {isAdmin && (
            <CardContent>
              <Button asChild className="rounded-full">
                <a href={spotifyConnectHref("/spotify-top")}>Reconnect Spotify</a>
              </Button>
            </CardContent>
          )}
        </Card>
      ) : !q.data.takenAt ? (
        <p className="text-sm text-muted-foreground">
          Permission granted — the first snapshot is taken within the hour. Check back soon.
        </p>
      ) : (
        <>
          <Tabs value={range} onValueChange={(v) => setRange(v as SpotifyTimeRange)}>
            <TabsList>
              {RANGES.map((r) => (
                <TabsTrigger key={r.value} value={r.value}>
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {view === "lists" ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <TopTracksCard tracks={q.data.ranges[range].tracks} />
              <TopArtistsCard artists={q.data.ranges[range].artists} />
            </div>
          ) : (
            <Receipt
              tracks={q.data.ranges[range].tracks}
              label={RANGES.find((r) => r.value === range)!.receipt}
              takenAt={q.data.takenAt}
              tz={tz}
            />
          )}
        </>
      )}
    </div>
  );
}

function TopTracksCard({ tracks }: { tracks: TrackLite[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top tracks</CardTitle>
      </CardHeader>
      <CardContent>
        {tracks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Spotify returned no tracks for this period.</p>
        ) : (
          <ol className="space-y-1">
            {tracks.map((t, i) => (
              <li key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <span className="w-6 shrink-0 text-right text-sm font-medium text-muted-foreground tabular">{i + 1}</span>
                <Art src={t.album?.imageUrl} alt="" className="size-10" />
                <div className="min-w-0 flex-1">
                  <RLink to={trackHref(t.id)} className="block truncate text-sm font-medium hover:underline">
                    {t.name}
                  </RLink>
                  <ArtistLinks artists={t.artists} className="block text-xs text-muted-foreground" />
                </div>
                <span className="text-xs text-muted-foreground tabular">{fmtClock(t.durationMs)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function TopArtistsCard({ artists }: { artists: ArtistLite[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top artists</CardTitle>
      </CardHeader>
      <CardContent>
        {artists.length === 0 ? (
          <p className="text-sm text-muted-foreground">Spotify returned no artists for this period.</p>
        ) : (
          <ol className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
            {artists.map((a, i) => (
              <li key={a.id} className="text-center">
                <RLink to={artistHref(a.id)} className="group block">
                  <div className="relative">
                    <Art src={a.imageUrl} alt={a.name} kind="artist" className="w-full transition-transform group-hover:scale-[1.03]" />
                    <span className="absolute -top-1 -left-1 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground tabular">
                      {i + 1}
                    </span>
                  </div>
                  <div className="mt-2 truncate text-xs font-medium group-hover:underline">{a.name}</div>
                </RLink>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/** Receiptify-style printout. Deliberately light-on-white so it screenshots like paper. */
function Receipt({ tracks, label, takenAt, tz }: { tracks: TrackLite[]; label: string; takenAt: number; tz: string }) {
  const items = tracks.slice(0, 15);
  const total = items.reduce((s, t) => s + (t.durationMs ?? 0), 0);
  const order = String(Math.floor(takenAt / 1000) % 1_000_000).padStart(6, "0");
  return (
    <div className="flex justify-center">
      <article
        aria-label="Receipt of your top tracks"
        className="w-full max-w-sm bg-[#fbfaf7] px-6 py-8 font-mono text-[12px] leading-relaxed text-[#1b1b1b] shadow-2xl [clip-path:polygon(0_0,100%_0,100%_calc(100%-8px),95%_100%,90%_calc(100%-8px),85%_100%,80%_calc(100%-8px),75%_100%,70%_calc(100%-8px),65%_100%,60%_calc(100%-8px),55%_100%,50%_calc(100%-8px),45%_100%,40%_calc(100%-8px),35%_100%,30%_calc(100%-8px),25%_100%,20%_calc(100%-8px),15%_100%,10%_calc(100%-8px),5%_100%,0_calc(100%-8px))]"
      >
        <header className="text-center">
          <div className="text-lg font-bold tracking-[0.3em]">ENCORE</div>
          <div className="mt-1 tracking-widest">{label}</div>
          <div className="mt-3 text-[11px]">ORDER #{order} FOR YOU</div>
          <div className="text-[11px]">{fmtDateTime(takenAt, tz).toUpperCase()}</div>
        </header>
        <div className="my-4 border-t border-dashed border-[#1b1b1b]/60" />
        <div className="flex justify-between text-[11px]">
          <span>QTY ITEM</span>
          <span>AMT</span>
        </div>
        <div className="my-2 border-t border-dashed border-[#1b1b1b]/60" />
        <ol className="space-y-1.5">
          {items.map((t, i) => (
            <li key={t.id} className="flex gap-3">
              <span className="w-5 shrink-0 tabular">{String(i + 1).padStart(2, "0")}</span>
              <span className="min-w-0 flex-1 uppercase">
                {t.name}
                <span className="block text-[10px] opacity-70">{t.artists.map((a) => a.name).join(", ")}</span>
              </span>
              <span className="shrink-0 tabular">{fmtClock(t.durationMs)}</span>
            </li>
          ))}
        </ol>
        <div className="my-3 border-t border-dashed border-[#1b1b1b]/60" />
        <div className="flex justify-between">
          <span>ITEM COUNT:</span>
          <span className="tabular">{items.length}</span>
        </div>
        <div className="flex justify-between font-bold">
          <span>TOTAL:</span>
          <span className="tabular">{fmtClock(total)}</span>
        </div>
        <div className="my-3 border-t border-dashed border-[#1b1b1b]/60" />
        <footer className="space-y-1 text-center text-[11px]">
          <div>CARD #: **** **** **** {new Date(takenAt).getUTCFullYear()}</div>
          <div>AUTH CODE: {order}</div>
          <div className="pt-3 font-bold tracking-widest">THANK YOU FOR LISTENING!</div>
          <div className="mx-auto mt-3 h-8 w-48 bg-[repeating-linear-gradient(90deg,#1b1b1b_0_2px,transparent_2px_4px,#1b1b1b_4px_5px,transparent_5px_8px)]" aria-hidden />
        </footer>
      </article>
    </div>
  );
}
