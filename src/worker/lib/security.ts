// Security headers + a Context-free cookie parser (used by the raw fetch
// handler that gates /protected/* before Hono is involved).

/**
 * Applied to every response the Worker emits. Static files served straight from
 * the edge get the same set via public/_headers. Keep the two in sync.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://i.scdn.co https://*.scdn.co https://*.spotifycdn.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:", // fflate unzips exports in blob: workers
    "manifest-src 'self'",
  ].join("; "),
};

/** Return a copy of `res` (whose headers may be immutable) with the security headers set. */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

/** Parse a single cookie value out of a raw Cookie header (no Hono Context needed). */
export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Best-effort client IP. CF-Connecting-IP is set by Cloudflare on every edge request. */
export function clientIp(headers: Headers): string {
  return headers.get("CF-Connecting-IP") || headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** 32 random bytes, base64url. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}
