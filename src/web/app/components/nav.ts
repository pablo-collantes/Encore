import {
  Activity,
  CalendarClock,
  Database,
  Disc3,
  History,
  LayoutDashboard,
  MicVocal,
  Music,
  Podcast,
  Receipt,
  Settings,
  Tags,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown only to admins (the Worker refuses the matching API calls to anyone else). */
  adminOnly?: boolean;
}

export const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Listening",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard },
      { to: "/history", label: "History", icon: History },
      { to: "/artists", label: "Artists", icon: MicVocal },
      { to: "/tracks", label: "Tracks", icon: Music },
      { to: "/albums", label: "Albums", icon: Disc3 },
      { to: "/podcasts", label: "Podcasts", icon: Podcast },
    ],
  },
  {
    label: "Insights",
    items: [
      { to: "/genres", label: "Genres", icon: Tags },
      { to: "/mood", label: "Mood & energy", icon: Activity },
      { to: "/habits", label: "Habits", icon: CalendarClock },
      { to: "/spotify-top", label: "Spotify's top lists", icon: Receipt },
    ],
  },
  {
    label: "Data",
    items: [
      { to: "/data", label: "Import & data", icon: Database },
      { to: "/admin", label: "People", icon: UsersRound, adminOnly: true },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

/** The nav as this person sees it: admin-only entries dropped for everyone else. */
export function visibleNav(isAdmin: boolean) {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => isAdmin || !i.adminOnly) })).filter((g) => g.items.length > 0);
}

/** Which nav entry a path belongs to (detail pages map to their list page). */
export function navFor(pathname: string): NavItem | undefined {
  if (pathname === "/") return ALL_NAV[0];
  return ALL_NAV.filter((i) => i.to !== "/").find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
}
