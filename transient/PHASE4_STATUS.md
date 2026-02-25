# Phase 4: Subscriptions & Pool/Boost System — STATUS

**Last updated:** 2026-02-25
**Branch:** `main`

---

## Sub-Phase 4A: Subscription Tiers + Stripe Billing — COMPLETE

### Backend — New `subscriptions` Django App

| File | Action | Notes |
|------|--------|-------|
| `backend/subscriptions/__init__.py` | **Created** | Empty |
| `backend/subscriptions/apps.py` | **Created** | SubscriptionsConfig |
| `backend/subscriptions/models.py` | **Created** | 5 models: Subscription, AttentionEvent, BoostAllocation, PoolDistribution, CreatorGate |
| `backend/subscriptions/serializers.py` | **Created** | SubscriptionSerializer, SubscriptionTierSerializer, AttentionEventSerializer/Batch, BoostAllocationSerializer, PoolDistributionSerializer, CreatorGateSerializer |
| `backend/subscriptions/views.py` | **Created** | TierListView, SubscriptionDetailView, SubscribeView (Stripe Checkout + tier change), CancelSubscriptionView, ResumeSubscriptionView, BillingPortalView, SubscriptionWebhookView (6 event types) |
| `backend/subscriptions/urls.py` | **Created** | 7 routes at `/api/v1/subscriptions/` |
| `backend/subscriptions/admin.py` | **Created** | Admin registration for all 5 models |
| `backend/subscriptions/tasks.py` | **Created** | Stub tasks: distribute_pool, aggregate_attention (Phase 4C) |
| `backend/subscriptions/migrations/0001_initial.py` | **Created + Applied** | All 5 tables with indexes |

### Configuration Changes

| File | Action | Notes |
|------|--------|-------|
| `backend/_django/settings.py` | **Modified** | Added `subscriptions` to INSTALLED_APPS; added `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, `STRIPE_PRICE_BASE/SUPPORTER/ADVOCATE/CHAMPION` settings |
| `backend/_django/urls.py` | **Modified** | Added `path("subscriptions/", include("subscriptions.urls"))` |
| `.env.example` | **Modified** | Added `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, `STRIPE_PRICE_BASE/SUPPORTER/ADVOCATE/CHAMPION` |

### Frontend

| File | Action | Notes |
|------|--------|-------|
| `frontend/src/lib/api.ts` | **Modified** | Added `SubscriptionTier` type, `SubscriptionTierOption` and `SubscriptionStatus` interfaces |
| `frontend/src/pages/SubscribePage.tsx` | **Created** | Tier selection cards with highlights, comparison table, "How It Works" section, Stripe Checkout redirect |
| `frontend/src/pages/SubscriptionPage.tsx` | **Created** | Subscriber dashboard: current plan card (pool/boost/hours/gate), cancel/resume/billing portal actions, pool distribution placeholder |
| `frontend/src/App.tsx` | **Modified** | Added `/subscribe` (public) and `/subscription` (protected) routes |
| `frontend/src/components/layout/Layout.tsx` | **Modified** | Added "Subscribe" to nav bar (mobile + desktop); added "Subscription" to user dropdown menu |

### API Endpoints

```
GET    /api/v1/subscriptions/tiers/           — Public tier list (5 tiers with pricing/pool/boost details)
GET    /api/v1/subscriptions/me/              — Current user's subscription status (auth required)
POST   /api/v1/subscriptions/subscribe/       — Create/change subscription (Stripe Checkout or in-place upgrade)
POST   /api/v1/subscriptions/cancel/          — Cancel at period end
POST   /api/v1/subscriptions/resume/          — Resume pending cancellation
POST   /api/v1/subscriptions/billing-portal/  — Stripe billing portal redirect
POST   /api/v1/subscriptions/webhook/         — Stripe webhook (6 event types)
```

### Webhook Events Handled

- `checkout.session.completed` — Links Stripe subscription to Bluebell Subscription model
- `customer.subscription.created` — Syncs subscription state
- `customer.subscription.updated` — Syncs tier/status/period/cancellation
- `customer.subscription.deleted` — Reverts to Window tier
- `invoice.payment_succeeded` — Updates period dates, marks active
- `invoice.payment_failed` — Marks subscription inactive

### Database Tables Created

- `subscriptions_subscription` — OneToOne with User, tier/stripe IDs/period/status
- `subscriptions_attentionevent` — User→Creator attention tracking (indexed by user+date, creator+date)
- `subscriptions_boostallocation` — User→Creator boost amount per billing cycle (unique_together)
- `subscriptions_pooldistribution` — Monthly subscriber→creator distribution ledger
- `subscriptions_creatorgate` — Creator-set thresholds for gated content

### Model Properties (Subscription)

- `is_paid` — True if tier != window and active
- `has_boost_pool` — True for supporter/advocate/champion
- `has_gate_access` — Same as has_boost_pool
- `monthly_content_hours` — 10 (window), 25 (base), None (unlimited for supporter+)
- `creator_pool_amount` — $4.85/$4.70/$4.55/$4.40 by tier
- `boost_pool_amount` — $0/$0/$5/$10/$15 by tier

---

## Remaining Sub-Phases

### 4B — Attention Tracking (NOT STARTED)

- Frontend `AttentionTracker` component (invisible, reports durations every 30-60s)
- Backend batch ingestion endpoint (`POST /api/v1/subscriptions/attention/`)
- Content hour tracking + cap enforcement
- Privacy-conscious design (aggregate only, no per-second tracking)

### 4C — Pool Distribution Engine (NOT STARTED)

- Celery task: `distribute_pool` (monthly per subscriber)
- Attention aggregation per creator per subscriber
- Proportional allocation of creator pool based on attention time
- CRF deduction from pool distributions
- PoolDistribution ledger records
- Frontend: pool distribution details on SubscriptionPage
- Creator earnings view on DashboardPage

### 4D — Boost Allocation + Gates (NOT STARTED)

- Boost slider UI on SubscriptionPage
- Lock-in mechanics (first adjustment locks for billing cycle)
- CreatorGate management for creators (in DashboardPage)
- Gate access computation (boost amount vs threshold)
- Content access control enforcement in PostDetailView and PostListCreateView
- "Subscribe to unlock" prompts on gated content
- Locked content previews (blurred/truncated)
