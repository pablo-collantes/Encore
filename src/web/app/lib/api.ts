// Thin fetch wrappers for the dashboard API. Every call is same-origin with the
// session cookie; a 401 means the session ended, so the whole app hands over to
// the sign-in page (a full navigation, which also drops the app's memory).

export type Params = Record<string, string | number | boolean | null | undefined>;

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export function buildUrl(path: string, params?: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    qs.set(k, v === true ? "1" : String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

function toLogin(): never {
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  throw new ApiFailure("Signed out", 401);
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) toLogin();
  if (!res.ok) {
    let message = res.status === 429 ? "Too many requests. Wait a minute and try again." : "Something went wrong. Please try again.";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // not JSON
    }
    throw new ApiFailure(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function send<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiFailure("Couldn't reach the server.", 0);
  }
  return handle<T>(res);
}

export function api<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
  return send<T>("GET", buildUrl(path, params), undefined, signal);
}

export function apiPost<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return send<T>("POST", path, body ?? {}, signal);
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return send<T>("PATCH", path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return send<T>("DELETE", path);
}
