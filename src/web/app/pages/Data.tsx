import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/Stat";
import { ErrorState } from "../components/States";
import { useDataStatus, useSummary } from "../hooks/queries";
import { fmtDate, fmtDuration, fmtInt } from "../lib/format";
import { useIsAdmin } from "../lib/me";
import { effectiveTimeZone, useSettings } from "../lib/settings";
import { Connection } from "./data/Connection";
import { Coverage } from "./data/Coverage";
import { Enrichment } from "./data/Enrichment";
import { ImportHistory } from "./data/ImportHistory";
import { ImportPanel } from "./data/ImportPanel";

export default function Data() {
  const isAdmin = useIsAdmin();
  const status = useDataStatus(true);
  const summary = useSummary();
  const tz = effectiveTimeZone(useSettings());
  const s = summary.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import & data"
        description={
          isAdmin
            ? "Fill in your past from Spotify's data download, and see what's been collected."
            : "What's been collected so far. Imports are made by an admin."
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total listening" loading={!s} value={fmtDuration(s?.totalMs ?? 0)} sub={s && `${fmtInt(s.totalStreams)} streams`} />
        <StatCard label="From exports" loading={!s} value={fmtInt(s?.sources.extended)} sub="Extended streaming history" />
        <StatCard label="From account data" loading={!s} value={fmtInt(s?.sources.account)} sub="Last-year downloads" />
        <StatCard
          label="Collected live"
          loading={!s}
          value={fmtInt(s?.sources.live)}
          sub={s?.firstTs ? `History from ${fmtDate(s.firstTs, tz)}` : undefined}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          {isAdmin && <ImportPanel />}
          {status.isError ? (
            <ErrorState error={status.error} onRetry={() => status.refetch()} />
          ) : status.data ? (
            <>
              <Coverage coverage={status.data.coverage} />
              <ImportHistory imports={status.data.imports} tz={tz} canEdit={isAdmin} />
            </>
          ) : (
            <Skeleton className="h-72" />
          )}
        </div>
        <div className="space-y-6 xl:col-span-2">
          {isAdmin && <HowToGetData />}
          {status.data ? (
            <>
              <Enrichment status={status.data} />
              <Connection status={status.data} canReconnect={isAdmin} />
            </>
          ) : (
            !status.isError && <Skeleton className="h-96" />
          )}
        </div>
      </div>
    </div>
  );
}

function HowToGetData() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Getting your data from Spotify</CardTitle>
        <CardDescription>Spotify will email you a download link. Both kinds can be imported here.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ol className="space-y-3">
          <li>
            <div className="font-medium">1. Open Spotify's privacy page</div>
            <a
              href="https://www.spotify.com/account/privacy/"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              spotify.com/account/privacy <ExternalLink className="size-3.5" />
            </a>
          </li>
          <li>
            <div className="font-medium">2. Tick “Extended streaming history”</div>
            <p className="text-muted-foreground">
              Your whole account history, with track IDs, skips and devices. Takes up to 30 days to arrive. Recommended.
            </p>
          </li>
          <li>
            <div className="font-medium">or “Account data”</div>
            <p className="text-muted-foreground">
              Only the last year, names without IDs, ready in about 5 days. Good for filling a gap quickly.
            </p>
          </li>
          <li>
            <div className="font-medium">3. Confirm by email, then drop the zip here</div>
            <p className="text-muted-foreground">
              Overlapping downloads, and overlaps with live collection, are de-duplicated automatically.
            </p>
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}
