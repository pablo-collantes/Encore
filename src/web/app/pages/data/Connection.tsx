import { KeyRound, RefreshCw } from "lucide-react";
import type { DataStatusResponse } from "@shared/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtInt } from "../../lib/format";
import { spotifyConnectHref } from "../../lib/me";

const SCOPE_LABEL: Record<string, string> = {
  "user-top-read": "Spotify's top tracks & artists",
  "user-read-recently-played": "Recently played",
  "user-read-playback-state": "What's playing",
  "user-read-currently-playing": "Currently playing",
  "user-read-private": "Account profile",
};

/** `canReconnect`: admins get the Reconnect Spotify button; everyone else sees status only. */
export function Connection({ status, canReconnect }: { status: DataStatusResponse; canReconnect: boolean }) {
  const { auth, collector } = status;
  const expiring = auth.refreshTokenDaysRemaining != null && auth.refreshTokenDaysRemaining <= 14;
  const statusBadge =
    collector.status === "ok" ? (
      <Badge>Collecting</Badge>
    ) : collector.status === "degraded" ? (
      <Badge variant="destructive">Degraded</Badge>
    ) : (
      <Badge variant="outline">Not connected</Badge>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Live collection {statusBadge}</CardTitle>
        <CardDescription>
          {auth.connected ? (
            <>
              Connected to Spotify as <span className="font-medium text-foreground">{auth.displayName ?? "your account"}</span>. New
              listening is picked up every few minutes.
            </>
          ) : (
            "No Spotify account is connected for collection."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">Player last checked</dt>
          <dd className="text-right tabular">{collector.sampleLastRunMinutesAgo == null ? "—" : `${fmtInt(collector.sampleLastRunMinutesAgo)} min ago`}</dd>
          <dt className="text-muted-foreground">Recent plays last fetched</dt>
          <dd className="text-right tabular">{collector.recentLastRunMinutesAgo == null ? "—" : `${fmtInt(collector.recentLastRunMinutesAgo)} min ago`}</dd>
          <dt className="text-muted-foreground">Spotify permission lasts</dt>
          <dd className="text-right tabular">
            {auth.refreshTokenDaysRemaining == null ? "—" : `${fmtInt(auth.refreshTokenDaysRemaining)} more days`}
          </dd>
        </dl>
        {collector.lastError && (
          <p className="rounded-lg bg-muted/50 p-2 font-mono text-xs break-words text-muted-foreground">Last error: {collector.lastError}</p>
        )}
        {expiring && (
          <p className="text-sm text-destructive">
            Spotify's permission expires soon. {canReconnect ? "Reconnect Spotify" : "An admin needs to reconnect Spotify"} to keep
            collecting.
          </p>
        )}
        {auth.missingScopes.length > 0 && (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <div className="flex items-center gap-2 font-medium">
              <KeyRound className="size-4" /> Permissions to grant
            </div>
            <ul className="list-disc pl-5 text-muted-foreground">
              {auth.missingScopes.map((s) => (
                <li key={s}>{SCOPE_LABEL[s] ?? s}</li>
              ))}
            </ul>
            {canReconnect ? (
              <Button asChild size="sm" className="rounded-full">
                <a href={spotifyConnectHref("/data")}>Reconnect Spotify to grant</a>
              </Button>
            ) : (
              <p className="text-muted-foreground">An admin needs to reconnect Spotify to grant these.</p>
            )}
          </div>
        )}
        {canReconnect && auth.missingScopes.length === 0 && (
          <div className="space-y-2 border-t pt-4">
            <Button asChild size="sm" variant={expiring || !auth.connected ? "default" : "outline"} className="rounded-full">
              <a href={spotifyConnectHref("/data")}>
                <RefreshCw /> {auth.connected ? "Reconnect Spotify" : "Connect Spotify"}
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">
              Opens Spotify's permission screen and resets the 6-month clock. Use the account this archive belongs to.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
