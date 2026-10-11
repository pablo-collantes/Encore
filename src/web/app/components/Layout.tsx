import { Suspense, useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useSpotifyConnectResult } from "../hooks/useSpotifyConnectResult";
import { AppSidebar } from "./AppSidebar";
import { CommandMenu } from "./CommandMenu";
import { navFor } from "./nav";
import { NowPlayingChip } from "./NowPlaying";
import { RangePicker } from "./RangePicker";

export function Layout() {
  const { pathname } = useLocation();
  useSpotifyConnectResult();
  const title = navFor(pathname)?.label ?? "Encore";

  useEffect(() => {
    document.title = title === "Encore" ? "Encore" : `${title} · Encore`;
  }, [title]);

  // New page, new scroll position (search-param changes like filters keep it).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-4 md:rounded-t-xl">
          <SidebarTrigger className="-ml-1" aria-label="Toggle navigation" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          <NowPlayingChip />
          <CommandMenu />
          <RangePicker />
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-3 pt-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
