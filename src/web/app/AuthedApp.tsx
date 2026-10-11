// PROTECTED entry: everything a signed-in user sees. Emitted under /protected/,
// which the Worker serves only to a valid session. The router lives here (not in
// the public entry) so no page code ends up in the public bundle.
import { lazy, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Toaster } from "sonner";
import type { Me } from "@shared/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "./components/Layout";
import { ApiFailure } from "./lib/api";
import { MeProvider } from "./lib/me";
import { applyTheme, getSettings, useSettings } from "./lib/settings";

const Overview = lazy(() => import("./pages/Overview"));
const History = lazy(() => import("./pages/History"));
const Artists = lazy(() => import("./pages/Artists"));
const ArtistDetail = lazy(() => import("./pages/ArtistDetail"));
const Tracks = lazy(() => import("./pages/Tracks"));
const TrackDetail = lazy(() => import("./pages/TrackDetail"));
const Albums = lazy(() => import("./pages/Albums"));
const AlbumDetail = lazy(() => import("./pages/AlbumDetail"));
const Podcasts = lazy(() => import("./pages/Podcasts"));
const Genres = lazy(() => import("./pages/Genres"));
const Mood = lazy(() => import("./pages/Mood"));
const Habits = lazy(() => import("./pages/Habits"));
const SpotifyTop = lazy(() => import("./pages/SpotifyTop"));
const Data = lazy(() => import("./pages/Data"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const Admin = lazy(() => import("./pages/Admin"));
const NotFound = lazy(() => import("./pages/NotFound"));

function makeRouter() {
  return createBrowserRouter([
    {
      element: <Layout />,
      children: [
        { index: true, element: <Overview /> },
        { path: "history", element: <History /> },
        { path: "artists", element: <Artists /> },
        { path: "artists/:id", element: <ArtistDetail /> },
        { path: "tracks", element: <Tracks /> },
        { path: "tracks/:id", element: <TrackDetail /> },
        { path: "albums", element: <Albums /> },
        { path: "albums/:id", element: <AlbumDetail /> },
        { path: "podcasts", element: <Podcasts /> },
        { path: "genres", element: <Genres /> },
        { path: "mood", element: <Mood /> },
        { path: "habits", element: <Habits /> },
        { path: "spotify-top", element: <SpotifyTop /> },
        { path: "data", element: <Data /> },
        { path: "admin", element: <Admin /> },
        { path: "settings", element: <SettingsPage /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ]);
}

export default function AuthedApp({ me }: { me: Me }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 10 * 60_000,
            refetchOnWindowFocus: false,
            // 4xx answers won't change on retry; network blips might.
            retry: (count, err) => !(err instanceof ApiFailure && err.status >= 400 && err.status < 500) && count < 2,
          },
        },
      }),
  );
  const [router] = useState(makeRouter);
  const settings = useSettings();

  useEffect(() => applyTheme(getSettings().theme), []);

  return (
    <MeProvider me={me}>
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={200}>
          <RouterProvider router={router} />
          <Toaster theme={settings.theme} position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </QueryClientProvider>
    </MeProvider>
  );
}
