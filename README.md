![Anthers Logo](./.github/assets/anthers-logo-concept-placeholder.png)
# Anthers

---

A creator-first, non-profit media platform — **centralized-first, with per-node federation on the roadmap.** Creators host games, videos, audio, and writing. **Anthers keeps $0** — users choose a Badge plan whose price flows to creators (a watch-time **Time Pool** + $1 **Seeds**, 100% to creators) and a **Community Share** to the Anthers Foundation; 100% of Seeds and direct purchases go to the creator. Bandwidth is a separate, at-cost prepaid wallet.

Anthers is operated as a non-profit organization that is structurally incapable of prioritizing profit over the people it serves. It cannot be acquired, cannot take corrupting investment, and directs every dollar of surplus into charitable and educational programs for creators through the Creator Resilience Fund.

## Prerequisites

- [Bun](https://bun.sh) (runtime, package manager, bundler, test runner)
- [FFmpeg](https://ffmpeg.org/) (media transcoding — HLS, audio normalization, waveform generation)

## Getting Started

```sh
# Clone the repository
git clone <repo-url> && cd anthers

# Copy environment config
cp .env.example .env

# Install dependencies
bun install

# Start the local Postgres (Docker; see compose.yaml)
make db-up

# Run database migrations
bun run db:migrate

# (Optional) Seed the database
bun run db:seed

# Start all services
bun run dev
```

Dev requires a local Postgres — `make db-up` starts one in Docker (the hub left SQLite behind; production uses DigitalOcean Managed Postgres).

The API runs on `http://localhost:8000` and the frontend on `http://localhost:3000`.

## Development Commands

### Services

| Command | Description |
|---|---|
| `bun run dev` | Start all services (API + worker + frontend) |
| `bun run dev:api` | API only (port 8000) |
| `bun run dev:worker` | Background job worker only |
| `bun run dev:web` | Frontend only (port 3000) |

### Database (Drizzle ORM)

| Command | Description |
|---|---|
| `make db-up` | Start the local dev Postgres (Docker, detached) |
| `make db-down` | Stop the local dev Postgres (keeps data) |
| `make db-reset` | Recreate the dev Postgres from scratch (wipes data) |
| `bun run db:generate` | Generate migrations from schema changes |
| `bun run db:migrate` | Run migrations |
| `bun run db:push` | Push schema directly (dev only) |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run db:seed` | Seed the database |
| `bun run db:seed:reset` | Reset and re-seed the database |

### Quality

| Command | Description |
|---|---|
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | Biome lint |
| `bun run lint:fix` | Biome lint + auto-fix |
| `bun run format` | Biome format |
| `bun test` | Run tests |

## Project Structure

```
apps/
  api/
    src/
      index.ts          Hono app entry point (port 8000)
      routes/           Route handlers by domain
      middleware/        Auth and CSRF middleware
      services/         Auth, ATProto, image, storage services
      jobs/             Background worker, queue, and job handlers
    Dockerfile          Shared by API, worker, and migration runner
  web/
    src/
      pages/            Route-level components
      components/       Organized by domain (ui, cards, media, editor, etc.)
      lib/              Shared logic (api client, auth, media player, uploads)
    serve.ts            Production SPA server
    build.ts            Build script
packages/
  db/
    src/
      schema/           Drizzle schema files by domain
      client.ts         Drizzle client
      migrate.ts        Migration runner
  shared/
    src/
      fees.ts           Fee calculation (processing + CRF)
      constants.ts      Shared constants
```

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Backend | Hono + Drizzle ORM |
| Frontend | React 19 + React Router 7 + TailwindCSS 4 + DaisyUI 5 |
| Database | **Managed Postgres** for the hub (SQLite remains for future creator nodes) |
| Async Jobs | pg-boss (Postgres-backed queue + cron), separate worker process |
| Media | FFmpeg (HLS, audio normalization, waveforms) |
| Image Processing | sharp |
| Payments | Stripe Connect |
| Storage | S3-compatible (DigitalOcean Spaces; local filesystem in dev) |
| Linting/Formatting | Biome 2 |
| Deployment | DigitalOcean App Platform + Managed Postgres (centralized hub) |

## Architecture

### Backend

The API is a Hono application on Bun with session-based authentication (argon2id password hashing, Postgres session store, CSRF via Origin header checking). No JWT or token auth.

Async jobs run on pg-boss (`apps/api/src/jobs/queue.ts`) in a separate worker process, handling video transcoding, audio processing, cross-publishing, pool distribution, Foundation subsidy calculation, and metrics fetching. pg-boss keeps its own tables in the app database's `pgboss` schema and provides cron scheduling with multi-instance dedup.

Storage is abstracted behind a `StorageService` interface with local (dev) and S3 (prod) implementations.

### Frontend

A React SPA built with Bun's built-in bundler (no Vite, no PostCSS). TailwindCSS is integrated via `bun-plugin-tailwind`. The provider stack is `BrowserRouter` > `AuthProvider` > `MediaPlayerProvider` > `App`, with a persistent audio player that survives navigation.

### ATProto Integration

Bluesky identity linking via OAuth (DPoP + PKCE + PAR). All content tables include `atprotoUri` columns as a cheap hook for future federation. Note: ATProto adoption is currently **deferred** — Anthers is centralized-first and, when federation is built, it's bespoke-first; ATProto is a re-openable choice for the eventual protocol layer, not a current dependency.

## Key Concepts

- **Badge plans:** Users choose a plan — Free $0 / Root $4 / Sprout $8 / Petal $16 / Blossom $32 — held **point-in-time** (you must currently hold a level to reach its gated content). Each whole-dollar price decomposes into a **Time Pool** + **Seeds** + a **Community Share** (the derived remainder). Anthers keeps **$0**; money to creators = Time Pool + Seeds.
- **Time Pool:** the badge plan's creator-funding budget (Free $0.05 subsidized / $2 / $4 / $9 / $18), distributed across the creators the user watched **in proportion to watch-time** — a minute is a minute across media (play/watch/read/listen). A higher badge means a bigger pool, so all of that user's watch-time pays creators more, with no per-item multiplier.
- **Seeds:** $1 units of direct, per-creator support — 100% to the creator (no fee, no payout processing). Each plan **includes** some Seeds (0/1/2/3/4); users can buy more and **direct** them to creators, unlocking those creators' **Seed Gates**.
- **Community Share:** the derived remainder of the plan price (—/$1/$2/$4/$10), funding the **Anthers Foundation** (Admin 10% / Programs 40% / Subsidy 50%). Together with the creators' storage AF Fee it funds all free access.
- **Bandwidth wallet:** bandwidth is decoupled from creator funding and billed **at cost** ($0.01/GiB) via a prepaid wallet; every plan gets a free monthly allowance (5–50 GiB) drawn down first, unused → subsidy pool.
- **Transparent Pass-Through:** On direct purchases the creator receives the full listed price (0% cut); the Digital AF Fee, delivery bandwidth, and card + tax are added on top.

## Environment Variables

See [`.env.example`](.env.example) for the full list. Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (default `postgres://anthers:anthers@localhost:5432/anthers`) |
| `SESSION_SECRET` | Secret for session signing |
| `SITE_PASSWORD` | Pre-launch gate password (empty disables the gate) |
| `STORAGE_BACKEND` | `local` or `s3` |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `ATPROTO_CLIENT_ID` | ATProto OAuth client ID |

## Deployment

The centralized **hub** deploys to DigitalOcean App Platform with a managed Postgres database (decided 2026-07-01, superseding the earlier single-droplet direction). Moving the hub's DB from SQLite to managed Postgres dissolves the App Platform volume constraint; the worker runs as its own component, a pre-deploy job runs migrations, and the SPA is served as a static site. `.do/app.yaml` is being reshaped from placeholder into the live spec — see its header. SQLite remains the engine for the future self-hostable creator-node role.

## License

Anthers is free software, licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [`LICENSE.md`](./LICENSE.md) for the full text.
