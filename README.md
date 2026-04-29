![Anthers Logo](./.github/assets/anthers-logo-concept-placeholder.png)
# Anthers

---

A federated, creator-first media platform built on the AT Protocol. Creators host games, videos, audio, and writing — keeping 85% of subscription revenue, with 10% funding the Community Resilience Fund and 5% covering platform operations.

Anthers is operated as a non-profit organization that is structurally incapable of prioritizing profit over the people it serves. It cannot be acquired, cannot take corrupting investment, and directs every dollar of surplus into charitable and educational programs for creators through the Creator Resilience Fund.

## Prerequisites
--

- [Bun](https://bun.sh) (runtime, package manager, bundler, test runner)
- [FFmpeg](https://ffmpeg.org/) (media transcoding — HLS, audio normalization, waveform generation)

## Getting Started
--

```sh
# Clone the repository
git clone <repo-url> && cd anthers

# Copy environment config
cp .env.example .env

# Install dependencies
bun install

# Run database migrations (creates ./data/anthers.db)
bun run db:migrate

# (Optional) Seed the database
bun run db:seed

# Start all services
bun run dev
```

The API runs on `http://localhost:8000` and the frontend on `http://localhost:3000`.

## Development Commands
--

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
--

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
--

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Backend | Hono + Drizzle ORM |
| Frontend | React 19 + React Router 7 + TailwindCSS 4 + DaisyUI 5 |
| Database | SQLite (via Bun's built-in driver) |
| Async Jobs | Custom SQLite-backed queue (in-process; cron via croner) |
| Media | FFmpeg (HLS, audio normalization, waveforms) |
| Image Processing | sharp |
| Payments | Stripe Connect |
| Storage | S3-compatible (DigitalOcean Spaces; local filesystem in dev) |
| Linting/Formatting | Biome 2 |
| Deployment | DigitalOcean App Platform |

## Architecture
--

### Backend

The API is a Hono application on Bun with session-based authentication (argon2id password hashing, SQLite session store, CSRF via Origin header checking). No JWT or token auth.

Async jobs run on a small SQLite-backed queue (`apps/api/src/jobs/queue.ts`) in a separate worker process, handling video transcoding, audio processing, cross-publishing, pool distribution, Foundation subsidy calculation, and metrics fetching. The queue uses its own SQLite file (`./data/anthers-queue.db`) to keep claim transactions isolated from app writes.

Storage is abstracted behind a `StorageService` interface with local (dev) and S3 (prod) implementations.

### Frontend

A React SPA built with Bun's built-in bundler (no Vite, no PostCSS). TailwindCSS is integrated via `bun-plugin-tailwind`. The provider stack is `BrowserRouter` > `AuthProvider` > `MediaPlayerProvider` > `App`, with a persistent audio player that survives navigation.

### ATProto Integration

Bluesky identity linking via OAuth (DPoP + PKCE + PAR). All content tables include `atprotoUri` columns in preparation for federation.

## Key Concepts
--

- **Community Resilience Fund (CRF):** 10% of subscription revenue funds infrastructure equity, education, creation grants, and emergency assistance.
- **Subscription Tiers:** Free / Root ($5) / Sprout ($10) / Petal ($20) / Bloom ($40).
- **Creator Pool:** $4.25/mo per Root subscriber, distributed proportionally by attention time (play/watch/read/listen).
- **Boost Pool:** Additional subscriber funds above the Creator Pool, allocated to specific creators and determining access to gated content.
- **Transparent Pass-Through:** On direct purchases, fees are added on top — creators receive the full listed price.

## Environment Variables
--

See [`.env.example`](.env.example) for the full list. Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite file path (default `./data/anthers.db`) |
| `QUEUE_DATABASE_URL` | Queue SQLite file path (default `./data/anthers-queue.db`) |
| `SESSION_SECRET` | Secret for session signing |
| `STORAGE_BACKEND` | `local` or `s3` |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `ATPROTO_CLIENT_ID` | ATProto OAuth client ID |

## Deployment
--

Deployment will be handled by DigitalOcean App Platform via `.do/app.yaml`. The current spec is a documentation placeholder — see the deferred-decision note at the top of `.do/app.yaml` for the open question about how SQLite + the worker process interact with App Platform's volume constraints. This needs a decision before the first non-test deploy.
