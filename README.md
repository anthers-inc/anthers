![Anthers Logo](./packages/brand/svg/anthers/anthers-logo-temp-cleanup/anthers-hlock-reverse.png)
# Anthers

---

A creator-first, non-profit media platform — **centralized-first, with per-node federation on the roadmap.** Creators host games, videos, audio, and writing. The model is one primitive: a **Seed**, a flat **$3/month**, pointed one of two ways. Given to a **creator**, it reaches them **100%** and clears that creator's Seed Gates. Pointed at **Anthers**, it covers your own streaming at cost, funds the **Time Pool** that pays creators by watch-time, and leaves a **remainder** to the Anthers Foundation.

Anthers is operated as a non-profit — no investors, no profit-taking. It cannot be acquired and cannot take corrupting investment. Every user dollar is money to a creator, the user's own bandwidth at cost, the Foundation's remainder, or the at-cost Payments line a card transaction carries — never platform profit.

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

- **Seeds:** the single support primitive — a flat **$3/month** unit, pointed at a creator or at Anthers. **Given to a creator** it reaches them 100% (no fee, no payout processing) and clears that creator's **Seed Gates**, which are set in whole $3 steps. The verb is *give*. Why $3 and not $1: a $1 card charge loses ~33% to processing, a $3 charge ~13%, so micro-support is batched into a $3 unit.
- **Anthers-Seeds and rank:** a Seed pointed at Anthers backs the commons. Your **rank simply is your Anthers-Seed count** — Free 0 / **Root** 1 / **Sprout** 2 / **Petal** 3 / **Blossom** 4, with a **"+"** beyond four — held **point-in-time** (you must currently hold a level to reach its gated content). There is no plan to subscribe to; you hold as many Seeds as you choose, in either direction.
- **Time Pool:** each Anthers-Seed funds **$1.50** of Time Pool — a fixed target, not a remainder — distributed across the creators you spent time with **in proportion to watch-time**: Free $0.05 (subsidized, you pay $0) / $1.50 / $3.00 / $4.50 / $6.00, and up from there. A minute is a minute across media (play/watch/read/listen). A higher rank simply means a bigger pool, with no per-item multiplier. Only **content entities** earn — post bodies, project pages, and other connective tissue don't.
- **The Foundation remainder:** what's left of each Anthers-Seed after your bandwidth and the Time Pool — derived, not a held slice. It funds the **Anthers Foundation** (free access + programs), read obligations-first with Admin held ≤ 30%. Together with the creators' storage AF Fee it funds all free access. It is program-service revenue, not a donation.
- **Bandwidth (folded in, no wallet):** billed **at cost** ($0.01/GiB) inside the Anthers-Seeds. Every account gets a **15 GiB** free monthly floor drawn down first, plus ~**60 GiB per Anthers-Seed** on top; unused allowance returns to the subsidy pool. Creators fund storage (first 50 GiB free, then cost + a 50% AF Fee).
- **Payments ride on top:** the at-cost card + processing line is added **on top** of the whole monthly charge, like sales tax (ACH-discountable) — never carved out of a Seed. That's what makes "every $3 reaches its destination in full" true.
- **Transparent Pass-Through:** on direct purchases the creator receives the full listed price (0% cut); the Digital AF Fee, delivery bandwidth, and card + tax are added on top.

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
