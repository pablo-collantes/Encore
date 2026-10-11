// Who is signed in, for any component that needs it. `me` is fixed for the life
// of the app: signing out (or a 401) is a full navigation that drops it.
//
// Roles: admins can do everything; users can only look. The UI hides what a
// user can't do, but the Worker enforces it (403 on every write and admin route).
import { createContext, useContext, type ReactNode } from "react";
import type { Me } from "@shared/api";

const MeContext = createContext<Me | null>(null);

export function MeProvider({ me, children }: { me: Me; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe() outside <MeProvider>");
  return me;
}

export const useIsAdmin = () => useMe().role === "admin";

export const ROLE_LABEL: Record<Me["role"], string> = { admin: "Admin", user: "Viewer" };

/** What to call the signed-in person in the UI. */
export const displayName = (me: Pick<Me, "name" | "email">) => me.name || me.email || "API key";

/**
 * Admins only. A full navigation: the Worker sends you through Spotify's consent
 * screen and back to `next` with `?spotify=<outcome>` (see useSpotifyConnectResult).
 */
export const spotifyConnectHref = (next: string) => `/auth/spotify?next=${encodeURIComponent(next)}`;
