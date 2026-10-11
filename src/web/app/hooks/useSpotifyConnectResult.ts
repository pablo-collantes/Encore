import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

// After "Reconnect Spotify" the Worker sends the browser back to the page it came
// from with ?spotify=<outcome>. Say what happened once, then drop the parameter.
const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Spotify reconnected. Collection continues with the fresh permission." },
  denied: { ok: false, text: "Spotify connection was cancelled." },
  state: { ok: false, text: "The Spotify connection attempt expired. Please try again." },
  wrong_account: { ok: false, text: "That's a different Spotify account from the one this archive belongs to." },
  rate_limited: { ok: false, text: "Too many attempts. Wait a minute and try again." },
  failed: { ok: false, text: "Couldn't connect to Spotify. Please try again." },
};

export function useSpotifyConnectResult() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const outcome = params.get("spotify");

  useEffect(() => {
    if (!outcome) return;
    const o = OUTCOMES[outcome] ?? OUTCOMES.failed!;
    // A fixed id, so StrictMode's double effect (or a re-render) shows it once.
    (o.ok ? toast.success : toast.error)(o.text, { id: "spotify-connect" });
    if (o.ok) void client.invalidateQueries();
    setParams(
      (p) => {
        p.delete("spotify");
        return p;
      },
      { replace: true },
    );
  }, [outcome, client, setParams]);
}
