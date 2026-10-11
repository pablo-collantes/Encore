import type { Env } from "../types";

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export function errorResponse(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, { status });
}

export function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Length-independent, constant-time-ish string comparison. Hashes both sides
 * first so differing lengths don't leak via early return.
 */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

/**
 * Gate for every /api and /admin route. Accepts `Authorization: Bearer <key>`,
 * `X-API-Key`, or `?key=` (the last one purely so links work from a browser).
 */
export async function requireApiKey(request: Request, env: Env): Promise<Response | null> {
  if (!env.API_KEY) {
    return errorResponse(500, "API_KEY is not configured on this Worker");
  }

  const url = new URL(request.url);
  const header = request.headers.get("authorization") ?? "";
  const presented =
    (header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "") ||
    request.headers.get("x-api-key") ||
    url.searchParams.get("key") ||
    "";

  if (!presented || !(await secretEquals(presented, env.API_KEY))) {
    return errorResponse(401, "unauthorized", {
      hint: "Send Authorization: Bearer <API_KEY>, X-API-Key, or ?key=<API_KEY>",
    });
  }
  return null;
}

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
