/** The app glyph: an equaliser in a rounded tile. Same drawing as public/icon.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect width="64" height="64" rx="16" className="fill-primary" />
      <g className="fill-primary-foreground">
        <rect x="14" y="28" width="7" height="22" rx="3.5" />
        <rect x="24.5" y="16" width="7" height="34" rx="3.5" />
        <rect x="35" y="22" width="7" height="28" rx="3.5" />
        <rect x="45.5" y="33" width="7" height="17" rx="3.5" />
      </g>
    </svg>
  );
}
