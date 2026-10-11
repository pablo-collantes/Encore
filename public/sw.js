// Encore's service worker: it makes the site installable (Android, desktop
// Chrome/Edge) and shows a short "you're offline" page instead of the browser's
// error when a navigation fails. Nothing is cached: the app bundle and every
// /api response sit behind the sign-in, so every request still goes to the
// network exactly as it would without a service worker.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Encore</title><style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#0b0b0c;color:#f2f4f2}
main{text-align:center;padding:24px}h1{font-size:18px;margin:0 0 6px}p{margin:0 0 16px;color:#9aa39c}
a{display:inline-block;padding:9px 18px;border-radius:999px;background:#1fd760;color:#0c1a10;text-decoration:none;font-weight:600}
</style></head><body><main><h1>You're offline</h1><p>Encore needs a connection to load your listening.</p>
<a href="/">Try again</a></main></body></html>`;

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // everything else: the browser's own handling
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
  );
});
