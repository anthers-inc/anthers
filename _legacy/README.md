# Bluebell

A creator-first media platform built on the AT Protocol. Transparent economics, zero platform cuts, portable identity.

## What Is This

Bluebell is a federated content hosting platform where creators keep 100% of their earnings and real infrastructure costs are passed through transparently rather than hidden behind percentage-based platform fees. Revenue comes from a subscriber pool model — viewers pay a single subscription, and funds are distributed to creators proportionally by attention time, supplemented by optional direct boost allocations.

The first product is a game hosting marketplace (think itch.io replacement), with video, audio, and writing support planned for later phases.

## Architecture

- **Backend:** Django 5.2 + Django REST Framework + Gunicorn + Celery
- **Frontend:** React 19 + React Router 7 + TailwindCSS 4 + DaisyUI 5
- **Runtime:** Bun (replaces Node/npm/Vite)
- **Database:** PostgreSQL 17
- **Reverse Proxy:** Caddy 2 (blue-green deployment)
- **Identity/Data:** AT Protocol (ATProto) — users and creators have portable DIDs
- **Payments:** Stripe Connect (subscriptions, marketplace purchases, creator payouts)
- **Storage:** S3-compatible object storage (game builds, media assets)

## Project Structure

```
backend/
  _django/          Project config (settings, urls, wsgi, asgi, celery, health)
  accounts/         User model, auth, follows, creator profiles
  content/          Projects, assets, posts, comments, ratings, media transcoding
  payments/         Stripe Connect, purchases, CRF ledger, fee calculations
frontend/
  src/              Source code (pages, components, styles)
  serve.ts          Production SPA server (Bun.serve + fallback)
db/init/            PostgreSQL initialization scripts
```

## Quick Start

### Prerequisites

- Docker and Docker Compose
- (Optional) Bun — for local frontend development outside Docker

### Setup

```bash
# Install dependencies and create .env
make setup

# Review .env and set secure passwords
vim .env

# Build and start services
make build && make up

# Run database migrations
make migrate

# Create admin user
make createsuperuser
```

### Access

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000/api/v1/ |
| Django Admin | http://localhost:8000/admin/ |
| Health Check | http://localhost:8000/health/ |
| API Docs | http://localhost:8000/api/v1/docs/ |

### API Routes

- `/api/v1/accounts/` — Registration, login, profiles, follows, creator discovery
- `/api/v1/content/` — Projects, assets, screenshots, posts, comments, ratings, media uploads
- `/api/v1/payments/` — Stripe Connect onboarding, checkout, purchase history, webhooks

## Development

```bash
make up          # Start services
make down        # Stop services
make rebuild     # Rebuild and restart
make logs        # Follow logs
make ps          # Show containers
make bash        # Shell into backend
make shell       # Django shell
```

## Deployment

Blue-green deployment with zero downtime:

```bash
make caddy-up        # Start reverse proxy
make deploy          # Deploy to inactive slot
make deploy-status   # Show current state
make deploy-rollback # Rollback if needed
```

## Key Concepts

**Community Resilience Fund (CRF):** 3% of all transactions funds platform infrastructure, free-tier hosting, and community reserves.

**Creator Pool:** Subscribers' base contribution is distributed to creators proportionally by watch/read/play/listen time.

**Boost Pool:** Additional subscriber funds allocated manually or automatically to specific creators. Determines access to gated content.

**Transparent Pass-Through:** No percentage cut. Creators see itemized costs (processing fees, infrastructure, CRF) rather than an opaque platform take.

## License

TBD
