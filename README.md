# Encore

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Hono](https://img.shields.io/badge/Hono-4-E36002?logo=hono&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)

Encore is a self-hosted Spotify listening archive and dashboard. It is a
full-stack TypeScript app that runs entirely on Cloudflare's edge: a single
Worker serves the API, runs the scheduled jobs and gates a React PWA, with D1
for storage and KV for caching.

---

## Tech stack

### Platform: Cloudflare

| Service | Role |
|---|---|
| **Workers** | API, scheduled jobs and the auth gate, in one Worker |
| **Workers Static Assets** | Serves the PWA from the edge; the Worker runs first only on `/api/*`, `/auth/*`, `/health` and `/protected/*` |
| **D1** (SQLite) | Primary datastore: versioned SQL migrations, partial indexes, triggers |
| **Workers KV** | Response cache, keyed by a build-time hash of the server code |
| **Cron Triggers** | Three schedules (every minute, every 5 minutes, hourly) routed by a single `scheduled()` handler |
| **Service bindings** | `SELF` binding that runs cron work through the fetch handler, so placement applies to it |
| **Placement** | Pins fetch handlers to a region next to the D1 primary |
| **Rate Limiting bindings** | Edge rate limits per client IP for authentication and API routes |
| **Email Sending** | `send_email` binding for invite and password-reset email |
| **Custom Domains** | DNS record, route and certificate created on deploy |
| **Version metadata and Observability** | Cache versioning fallback and structured logs |

### Backend

- **[Hono](https://hono.dev)** for routing and middleware on the Workers runtime
- **TypeScript**, with separate `tsconfig` projects for the Worker, the web app
  and the tests
- **Web Crypto**: PBKDF2-SHA256 password hashing, SHA-256 token digests and HMAC-signed OAuth state
- **OAuth 2.0** authorization-code flow against the Spotify Web API
- Third-party REST clients (Deezer, MusicBrainz, ReccoBeats) that honour `Retry-After` and back off per service

### Frontend

- **React 19** with **React Router**, plus code-split routes behind an authenticated bundle
- **TanStack Query** for server state
- **Tailwind CSS 4** with **shadcn/ui** components built on **Radix UI**
- **Recharts** for charts, **lucide-react** icons, **cmdk** command palette, **sonner** toasts
- **fflate**, which unzips large data exports in the browser off the main thread
- Installable **PWA**: web manifest, service worker and maskable icons

### Tooling and testing

- **Vite 8** with **`@cloudflare/vite-plugin`**: one build for both the Worker and the web app, and local
  development in `workerd` with HMR and a local D1
- **Vitest**, running against an in-memory SQLite harness (`node:sqlite`) that
  applies the real migrations, so production SQL is tested end to end
- **Wrangler 4** for migrations, secrets and deployment

---

## Architecture

```
            ┌────────────────────────── Cloudflare edge ──────────────────────────┐
            │                                                                     │
 Browser ───┼──► Static Assets (public sign-in shell, PWA)                        │
  (PWA)     │        │                                                            │
            │        └─ /api/* /auth/* /protected/* ──► Worker (Hono)             │
            │                                            │   ▲                    │
            │                         ┌──────────────────┤   │ SELF               │
            │                         ▼                  ▼   │                    │
            │                   D1 (SQLite)          KV cache                     │
            │                         ▲                                           │
            │      Cron Triggers ─────┴──► collectors · enrichment · maintenance  │
            └─────────────────────────────────────────────────────────────────────┘
                                      │
                Spotify Web API · Deezer · MusicBrainz · ReccoBeats
```

### Engineering highlights

- **Cost-aware D1 design.** Aggregates are stored and updated incrementally, never
  recomputed by scanning tables. A watermark tracks new rows. Triggers capture
  edits into a change log, and a scheduled fold applies both. SQLite triggers also flag catalogue
  changes, so expensive maintenance passes run only when there is new data. Queue
  tables use partial indexes, so an idle tick reads only a handful of rows.
- **Gated app bundle.** The build splits the signed-in app into `/protected/*`
  chunks. The Worker returns a plain 404 for them without a valid session, and
  the build fails if any signed-in app code lands in a public chunk.
- **Cache invalidation by build hash.** KV keys are prefixed with a hash of the
  server source. A deploy that changes the API starts with a fresh cache, while a
  frontend-only deploy keeps it.
- **Invite-only accounts.** There is no sign-up. Accounts are created by admin invite through
  single-use links. Session cookies, invite links and reset links store only their SHA-256 digest in the database.
  Sessions use host-only `HttpOnly` cookies.
- **Defence in depth.** A strict Content-Security-Policy and security headers
  apply to both static and dynamic responses, alongside edge rate limiting and
  `noindex`.

---

## Project structure

```
src/
  worker/          Cloudflare Worker
    index.ts         fetch + scheduled entry points, /protected gate
    app.ts           Hono app and middleware
    routes/          auth and admin routes
    lib/             sessions, passwords, tokens, email, cache, validation
    enrich/          enrichment pump and external API clients
    stats/           query layer and incremental rollups
  web/             React PWA
    main.tsx, auth/  public sign-in shell
    app/             authenticated app (emitted under /protected/)
    components/ui/   shadcn/ui components
  shared/          types and parsers shared by the Worker and the web app
migrations/        D1 schema migrations (0001–0007)
scripts/           admin bootstrap, CLI importer, local API mock
test/              Vitest suites and the SQLite test harness
public/            PWA manifest, service worker, icons, _headers
```

---

## Getting started

### Prerequisites

- Node.js 24+ (the test harness uses `node:sqlite`)
- A Cloudflare account and `npx wrangler login`
- A Spotify developer app (<https://developer.spotify.com/dashboard>)

### Local development

```bash
npm install
cp .dev.vars.example .dev.vars        # fill in local secrets
npm run db:migrate:local
npm run dev                           # Vite + Worker in workerd on http://127.0.0.1:8787
```

Create a local admin account. This prints a one-time link for setting a password:

```bash
node scripts/invite-admin.mjs you@example.com
```

To work without Spotify credentials, run `node scripts/mock-spotify.mjs` and set
`SPOTIFY_API_BASE=http://127.0.0.1:8788` in `.dev.vars`.

### Checks

```bash
npm test              # Vitest
npm run typecheck     # Worker, web app and tests
npm run build         # production build of both halves
```

---

## Deployment

1. **Create the resources** and put their IDs into `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create encore
   npx wrangler kv namespace create CACHE
   ```
2. **Configure** `wrangler.jsonc`. Set the custom domain (`routes`), `APP_URL`, `SPOTIFY_REDIRECT_URI`,
   `EMAIL_FROM` and `allowed_sender_addresses`, and the `placement` region. The
   redirect URI must also be registered on your Spotify app.
3. **Set the secrets**:
   ```bash
   npx wrangler secret put SPOTIFY_CLIENT_ID
   npx wrangler secret put SPOTIFY_CLIENT_SECRET
   npx wrangler secret put API_KEY          # openssl rand -hex 32
   npx wrangler secret put STATE_SECRET     # openssl rand -hex 32
   ```
4. **Migrate and deploy**:
   ```bash
   npm run db:migrate
   npm run deploy
   ```
5. **Create the first admin**:
   ```bash
   node scripts/invite-admin.mjs you@example.com "Your Name" --remote --email
   ```
   Then sign in and connect Spotify from the app.

Apply schema changes as new numbered files in `migrations/`, and run
`npm run db:migrate` before `npm run deploy`.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Local development server (Vite and `workerd`, local D1) |
| `npm run build` | Production build |
| `npm run deploy` | Build and deploy with Wrangler |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check every TypeScript project |
| `npm run db:migrate` / `db:migrate:local` | Apply D1 migrations remotely or locally |
| `npm run tail` | Stream production logs |
