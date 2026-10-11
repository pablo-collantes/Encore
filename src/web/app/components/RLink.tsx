import { Link, NavLink, useSearchParams, type LinkProps, type NavLinkProps } from "react-router";
import { rangeSearch } from "../lib/range";

/** Hook form: the current range as a "?range=…" suffix for hand-built hrefs. */
export function useRangeSuffix(): string {
  const [search] = useSearchParams();
  return rangeSearch(search);
}

/** A Link that keeps the global date range when moving between pages. */
export function RLink({ to, ...props }: Omit<LinkProps, "to"> & { to: string }) {
  const suffix = useRangeSuffix();
  return <Link to={withSuffix(to, suffix)} {...props} />;
}

export function RNavLink({ to, ...props }: Omit<NavLinkProps, "to"> & { to: string }) {
  const suffix = useRangeSuffix();
  return <NavLink to={withSuffix(to, suffix)} {...props} />;
}

function withSuffix(to: string, suffix: string): string {
  if (!suffix) return to;
  return to.includes("?") ? `${to}&${suffix.slice(1)}` : `${to}${suffix}`;
}

export const artistHref = (id: string) => `/artists/${encodeURIComponent(id)}`;
export const trackHref = (id: string) => `/tracks/${encodeURIComponent(id)}`;
export const albumHref = (id: string) => `/albums/${encodeURIComponent(id)}`;
