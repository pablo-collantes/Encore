import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { useSearch } from "../hooks/queries";
import { useDebounced } from "../hooks/useDebounced";
import { useIsAdmin } from "../lib/me";
import { rangeSearch } from "../lib/range";
import { Art } from "./Art";
import { ALL_NAV } from "./nav";
import { albumHref, artistHref, trackHref } from "./RLink";

/** ⌘K / Ctrl+K: jump to any page, artist, track or album. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDebounced(query, 200);
  const results = useSearch(q);
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const isAdmin = useIsAdmin();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setQuery("");
    navigate(path + rangeSearch(search));
  };

  const needle = query.trim().toLowerCase();
  const pages = ALL_NAV.filter((p) => (isAdmin || !p.adminOnly) && (!needle || p.label.toLowerCase().includes(needle)));
  const r = q.trim().length >= 2 ? results.data : undefined;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-2 text-muted-foreground sm:w-52 sm:justify-start"
        aria-label="Search"
      >
        <Search className="size-4" aria-hidden />
        <span className="hidden sm:inline">Search…</span>
        <Kbd className="ml-auto hidden sm:inline-flex">⌘K</Kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Find a page, artist, track or album">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search artists, tracks, albums, pages…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>
              {results.isFetching ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner /> Searching…
                </span>
              ) : (
                "No matches."
              )}
            </CommandEmpty>
            {r && r.artists.length > 0 && (
              <CommandGroup heading="Artists">
                {r.artists.map((a) => (
                  <CommandItem key={a.id} value={`artist-${a.id}`} onSelect={() => go(artistHref(a.id))}>
                    <Art src={a.imageUrl} alt={a.name} kind="artist" className="size-6" />
                    {a.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {r && r.tracks.length > 0 && (
              <CommandGroup heading="Tracks">
                {r.tracks.map((t) => (
                  <CommandItem key={t.id} value={`track-${t.id}`} onSelect={() => go(trackHref(t.id))}>
                    <Art src={t.album?.imageUrl} alt="" className="size-6" />
                    <span className="truncate">{t.name}</span>
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {t.artists.map((a) => a.name).join(", ")}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {r && r.albums.length > 0 && (
              <CommandGroup heading="Albums">
                {r.albums.map((a) => (
                  <CommandItem key={a.id} value={`album-${a.id}`} onSelect={() => go(albumHref(a.id))}>
                    <Art src={a.imageUrl} alt="" kind="album" className="size-6" />
                    <span className="truncate">{a.name}</span>
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {a.artists.map((x) => x.name).join(", ")}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {pages.length > 0 && (
              <CommandGroup heading="Pages">
                {pages.map((p) => (
                  <CommandItem key={p.to} value={`page-${p.to}`} onSelect={() => go(p.to)}>
                    <p.icon />
                    {p.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
