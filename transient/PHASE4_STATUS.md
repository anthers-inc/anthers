# Phase 4: Subscriptions & Pool/Boost System — STATUS

**Last updated:** 2026-02-25
**Branch:** `main`

---

## COMPLETED — All 4 Sub-Phases

### Sub-Phase 4A: Subscription Tiers + Stripe Billing ✅

**Commit:** `8f2b00b`

- New `subscriptions` Django app with 5 models
- Stripe Checkout for subscription creation, in-place tier upgrades
- Cancel/resume/billing portal endpoints
- Webhook handler for 6 Stripe event types
- Frontend SubscribePage (tier cards + comparison table) and SubscriptionPage (dashboard)
- Navigation links in navbar and user dropdown

### Sub-Phase 4B: Attention Tracking ✅

**Commit:** `c3f2c08`

- `POST /api/v1/subscriptions/attention/` — batch event ingestion (50 events max, 300s cap per event, self-attention filtered)
- `GET /api/v1/subscriptions/attention/summary/` — content hours used this cycle
- Frontend `useAttentionTracker` hook — accumulates seconds when page visible, flushes every 30s
- Integrated into PostPage (read/watch/listen), ProjectPage (play/page_view), MediaPlayerProvider (background listen)
- Added `creator_id` to all content serializers (Project, Post, list variants)
- SubscriptionPage shows content hours progress bar

### Sub-Phase 4C: Pool Distribution Engine ✅

**Commit:** `cc451cd`

- Celery task `distribute_pool` — aggregates attention per creator, distributes pool proportionally, applies boost allocations, writes PoolDistribution ledger
- Rounding drift correction (adjusts largest allocation)
- `GET /api/v1/subscriptions/distributions/` — subscriber's per-creator breakdown
- `GET /api/v1/subscriptions/earnings/` — creator's total pool/boost income + supporter count
- SubscriptionPage shows distribution table (creator, time, pool, boost, total)
- DashboardPage shows creator earnings card (pool income, boost income, total, supporters)

### Sub-Phase 4D: Boost Allocation + Gates ✅

**Commit:** `f04d093`

- `GET/POST /api/v1/subscriptions/boosts/` — list/set boost allocations with budget enforcement
- `GET/POST /api/v1/subscriptions/gates/` — creator gate CRUD
- `PUT/DELETE /api/v1/subscriptions/gates/<pk>/` — gate update/delete
- `GET /api/v1/subscriptions/access/<pk>/` — content access check
- PostDetailView enforces visibility: redacts body/media for unauthorized users, adds `access_granted` field
- PostPage shows locked content gate with subscribe/boost prompts
- Access logic: public (always), subscribers_only (paid tier required), gated (boost >= creator's lowest gate threshold)

---

## API Endpoints (Complete)

```
# Subscription Management
GET    /api/v1/subscriptions/tiers/             — Public tier list
GET    /api/v1/subscriptions/me/                — Current subscription status
POST   /api/v1/subscriptions/subscribe/         — Create/change subscription
POST   /api/v1/subscriptions/cancel/            — Cancel at period end
POST   /api/v1/subscriptions/resume/            — Resume pending cancellation
POST   /api/v1/subscriptions/billing-portal/    — Stripe billing portal

# Attention Tracking
POST   /api/v1/subscriptions/attention/         — Batch event ingestion
GET    /api/v1/subscriptions/attention/summary/  — Content hours used

# Pool Distributions
GET    /api/v1/subscriptions/distributions/     — Subscriber's distributions
GET    /api/v1/subscriptions/earnings/          — Creator's earnings

# Boost Allocations
GET    /api/v1/subscriptions/boosts/            — List boost allocations
POST   /api/v1/subscriptions/boosts/            — Set/update boost allocation

# Creator Gates
GET    /api/v1/subscriptions/gates/             — List gates
POST   /api/v1/subscriptions/gates/             — Create gate
PUT    /api/v1/subscriptions/gates/<pk>/        — Update gate
DELETE /api/v1/subscriptions/gates/<pk>/        — Delete gate

# Access Control
GET    /api/v1/subscriptions/access/<pk>/       — Check content access

# Webhook
POST   /api/v1/subscriptions/webhook/           — Stripe subscription events
```

---

## Architecture Notes

### Content Access Control Flow
1. PostDetailView.retrieve() checks `post.visibility`
2. For `subscribers_only`: requires `subscription.is_paid`
3. For `gated`: requires `subscription.has_gate_access` AND boost allocation >= creator's lowest gate threshold
4. Unauthorized: body/body_html redacted, media nullified, `access_granted: false` returned
5. Frontend shows locked gate card with subscribe/boost CTA

### Attention Tracking Flow
1. Frontend `useAttentionTracker` ticks every 1s when page is visible
2. Accumulated seconds flushed to pending queue every 30s
3. Pending queue posted to `/attention/` endpoint every 30s
4. Also flushes on page visibility change (tab switch/close)
5. Backend: bulk_create with validation (50 max, 300s cap, no self-attention)

### Pool Distribution Flow
1. Celery task `distribute_pool` runs per subscriber (or all)
2. Queries AttentionEvent for current billing cycle
3. Calculates proportional split of `creator_pool_amount`
4. Applies BoostAllocation amounts
5. Creates/updates PoolDistribution ledger entries
6. Rounding drift corrected on largest allocation
