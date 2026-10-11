// Per-device preferences, kept in localStorage.
import { useSyncExternalStore } from "react";

const KEY = "encore.settings";

export type Theme = "dark" | "light";

export interface Settings {
  /** IANA zone; null = follow the browser. */
  timeZone: string | null;
  theme: Theme;
  /** Range preset used when the URL has none. */
  defaultRange: string;
}

const DEFAULTS: Settings = { timeZone: null, theme: "dark", defaultRange: "12m" };

let current: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // ignore corrupt storage
  }
  return DEFAULTS;
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // private mode: keep it in memory
  }
  applyTheme(current.theme);
  for (const l of listeners) l();
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function effectiveTimeZone(s: Settings = current): string {
  return s.timeZone || browserTimeZone();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0b0c" : "#fafcfa");
}
