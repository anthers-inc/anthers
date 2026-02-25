# Bluebell Testing & Validation Guide

This document covers setup, testing, and validation for every significant feature implemented across Phases 1-8 of the Bluebell implementation plan.

---

## Table of Contents

1. [Environment Setup](#1-environment-setup)
2. [Phase 1: Game Marketplace MVP](#2-phase-1-game-marketplace-mvp)
3. [Phase 2: Payments & Marketplace Transactions](#3-phase-2-payments--marketplace-transactions)
4. [Phase 3: Multi-Media Content](#4-phase-3-multi-media-content)
5. [Phase 4: Subscriptions & Pool/Boost System](#5-phase-4-subscriptions--poolboost-system)
6. [Phase 5: ATProto Integration](#6-phase-5-atproto-integration)
7. [Phase 6: Cross-Publishing & Analytics](#7-phase-6-cross-publishing--analytics)
8. [Phase 7: Game Jams](#8-phase-7-game-jams)
9. [Phase 8: Migration Tools & Growth](#9-phase-8-migration-tools--growth)
10. [Backend API Smoke Tests](#10-backend-api-smoke-tests)
11. [Frontend TypeScript Verification](#11-frontend-typescript-verification)
12. [Database & Migration Integrity](#12-database--migration-integrity)
13. [Celery Task Verification](#13-celery-task-verification)

---

## 1. Environment Setup

### Prerequisites

- Docker and Docker Compose
- Bun (frontend runtime)
- Git

### Start the Development Stack

```bash
make build          # Build all containers
make up             # Start: db, backend, redis, celery-worker, frontend
make migrate        # Apply all migrations
make createsuperuser  # Create admin account
```

Verify all 5 services are running:

```bash
make ps
# Expected: bluebell-db, bluebell-backend, bluebell-redis,
#           bluebell-celery-worker, bluebell-frontend — all "Up"
```

### Service URLs

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000/api/v1/ |
| Django Admin | http://localhost:8000/admin/ |
| Swagger Docs | http://localhost:8000/api/v1/docs/ |

### Create Test Accounts

You'll need multiple accounts to test multi-user features. Create them via the API or the registration page.

```bash
# Register "creator1" — will be our primary creator
curl -X POST http://localhost:8000/api/v1/accounts/register/ \
  -H "Content-Type: application/json" \
  -d '{"username":"creator1","email":"creator1@test.com","password":"testpass123","password_confirm":"testpass123"}'

# Register "viewer1" — will be our subscriber/viewer
curl -X POST http://localhost:8000/api/v1/accounts/register/ \
  -H "Content-Type: application/json" \
  -d '{"username":"viewer1","email":"viewer1@test.com","password":"testpass123","password_confirm":"testpass123"}'

# Register "creator2" — secondary creator for multi-creator tests
curl -X POST http://localhost:8000/api/v1/accounts/register/ \
  -H "Content-Type: application/json" \
  -d '{"username":"creator2","email":"creator2@test.com","password":"testpass123","password_confirm":"testpass123"}'
```

Enable creator mode via Django admin (`http://localhost:8000/admin/`) — set `is_creator=True` on creator1 and creator2.

---

## 2. Phase 1: Game Marketplace MVP

### 2.1 User Registration & Authentication

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 1.1 | Register new account | Go to `/register`, fill form, submit | Account created, redirected to dashboard |
| 1.2 | Login | Go to `/login`, enter credentials | Logged in, user menu shows username |
| 1.3 | Logout | Click user menu > Logout | Session cleared, redirected to `/` |
| 1.4 | Session persistence | Login, close tab, open new tab to `/dashboard` | Still logged in |
| 1.5 | Protected route redirect | Logged out, navigate to `/dashboard` | Redirected to `/login` |
| 1.6 | Protected route after login | Login from redirect | Returned to original `/dashboard` URL |

### 2.2 User Profile & Settings

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 2.1 | Edit profile | `/settings` > change display name, bio, location | Saved, visible on profile page |
| 2.2 | Upload avatar | `/settings` > upload image | Avatar shown in navbar and profile |
| 2.3 | Upload header image | `/settings` > upload header | Visible on creator profile page |
| 2.4 | Enable creator mode | `/settings` > toggle "Become a creator" | `is_creator` set, dashboard shows create buttons |
| 2.5 | Public profile | Navigate to `/:username` | Shows display name, bio, avatar, projects, posts |

### 2.3 Project CRUD (Creator)

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 3.1 | Create project | `/dashboard/projects/new` > fill title, description, media_type=game | Project created, redirected to edit or detail |
| 3.2 | Slug auto-generation | Type title "My Cool Game" | Slug auto-fills as `my-cool-game` |
| 3.3 | Cover image upload | Upload image via FileUpload | Cover image preview shown, saved |
| 3.4 | Screenshot upload | Add 3 screenshots | All displayed in order |
| 3.5 | Screenshot deletion | Delete middle screenshot | Removed, order maintained |
| 3.6 | Set pricing (free) | Set pricing_type=free | No price fields shown |
| 3.7 | Set pricing (PWYW) | Set pricing_type=pwyw, suggested_price=$5 | Min/suggested price fields visible |
| 3.8 | Set pricing (paid) | Set pricing_type=paid, price=$10 | Price field shown |
| 3.9 | Tags | Add tags: "platformer", "pixel-art" | Tags saved and displayed |
| 3.10 | Embed URL | Set embed_url to an HTML5 game URL | Embed iframe visible on project page |
| 3.11 | Publish toggle | Toggle is_published=true | Project visible on Explore page |
| 3.12 | Edit project | `/dashboard/projects/:slug/edit` | Form pre-populated, changes saved |
| 3.13 | Delete project | Delete from edit page | Project removed |

### 2.4 Build/Asset Management

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 4.1 | Upload asset | `/dashboard/projects/:slug/builds` > upload file | File listed with name, size, platform |
| 4.2 | Set platform | Upload with platform=windows | Platform label shown |
| 4.3 | Set version | Upload with version="1.0.0" | Version displayed |
| 4.4 | Delete asset | Click delete on asset row | Asset removed |
| 4.5 | Download asset | On project page, click Download | File downloads, download_count increments |

### 2.5 Posts (Devlog)

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 5.1 | Create text post | `/dashboard/posts/new` > title, body, publish | Post created |
| 5.2 | Link to project | Select a project in the dropdown | Post shows project badge |
| 5.3 | Edit post | `/dashboard/posts/:id/edit` | Form pre-populated, changes saved |
| 5.4 | View post | Navigate to `/posts/:id` | Body rendered, markdown/rich text |

### 2.6 Comments & Ratings

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 6.1 | Comment on project | On project page, type comment, submit | Comment appears in list |
| 6.2 | Comment on post | On post page, type comment, submit | Comment appears |
| 6.3 | Rate project | On project page, click 4 stars | Rating saved, aggregate updates |
| 6.4 | Re-rate project | Change to 3 stars | Rating updated (not duplicated) |
| 6.5 | Anonymous viewing | Logged out, view project | Comments visible, cannot submit |

### 2.7 Discovery & Navigation

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 7.1 | Explore page | `/explore` | Published projects displayed in grid |
| 7.2 | Media type filter | Click "Games" tab | Only game projects shown |
| 7.3 | Search | Search "cool game" | Matching projects shown |
| 7.4 | Pagination | Browse past first page | Next/prev work, page number updates URL |
| 7.5 | Follow creator | On creator profile, click Follow | "Following" shown, follower count increments |
| 7.6 | Feed page | `/feed` | Posts from followed creators appear |
| 7.7 | Feed empty state | Unfollow everyone, visit `/feed` | "Follow creators to see posts" message |
| 7.8 | Homepage | Visit `/` | Featured projects, recent posts, creators shown |
| 7.9 | Marketing pages | `/for-creators`, `/for-users` | Content renders, no broken images |
| 7.10 | Dashboard | `/dashboard` | Stats, project table, post table shown |

---

## 3. Phase 2: Payments & Marketplace Transactions

> **Note:** Stripe tests require Stripe test mode API keys in `.env`. Use [Stripe test cards](https://docs.stripe.com/testing) for checkout.

### 3.1 Stripe Connect Onboarding

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 8.1 | Start onboarding | As creator, `/settings` > Stripe section > "Connect" | Redirect to Stripe Express onboarding |
| 8.2 | Onboarding status | After completing Stripe setup | `charges_enabled=true`, status shown in settings |
| 8.3 | Check via API | `GET /api/v1/payments/stripe/onboard/` | Returns `StripeAccountStatus` with all fields |

### 3.2 Checkout Flow

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 9.1 | Checkout paid project | As viewer, visit paid project, click Buy | Stripe checkout form appears |
| 9.2 | Fee breakdown | During checkout | Processing fee (2.9% + $0.30), CRF (3%), creator earnings shown |
| 9.3 | Successful payment | Use test card `4242 4242 4242 4242` | Purchase created, status=completed |
| 9.4 | Failed payment | Use test card `4000 0000 0000 0002` | Error shown, purchase status=failed |
| 9.5 | Ownership check | After purchase, revisit project | Downloads unlocked, "Owned" badge |
| 9.6 | Duplicate purchase | Try to buy again | Prevented or shows "Already owned" |

### 3.3 Fee Calculation Verification

Test via Django shell (`make shell`):

```python
from decimal import Decimal
from payments.fees import calculate_fees

# $10 purchase
fees = calculate_fees(Decimal("10.00"))
assert fees["processing_fee"] == Decimal("0.59")  # 2.9% + $0.30
assert fees["crf_fee"] == Decimal("0.30")          # 3%
assert fees["creator_earnings"] == Decimal("9.11")  # remainder

# $1 minimum purchase
fees = calculate_fees(Decimal("1.00"))
assert fees["processing_fee"] == Decimal("0.33")
assert fees["crf_fee"] == Decimal("0.03")
assert fees["creator_earnings"] == Decimal("0.64")

# $100 purchase
fees = calculate_fees(Decimal("100.00"))
assert fees["processing_fee"] == Decimal("3.20")
assert fees["crf_fee"] == Decimal("3.00")
assert fees["creator_earnings"] == Decimal("93.80")

print("All fee calculations correct")
```

### 3.4 CRF Ledger

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 10.1 | CRF inflow | Complete a purchase | CRFLedger entry with positive amount (=crf_fee) |
| 10.2 | Ledger in admin | Django admin > CRF Ledger | Shows all entries with amounts and descriptions |

### 3.5 Webhook Idempotency

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 11.1 | Duplicate webhook | Send same payment_intent.succeeded twice | Purchase updated once, no duplicate CRF entry |

---

## 4. Phase 3: Multi-Media Content

### 4.1 Video Upload & Transcoding

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 12.1 | Upload video post | Create post with content_type=video, attach .mp4 | Upload progress shown, TranscodingJob created |
| 12.2 | Transcoding status | View post during processing | Status shows "Processing" with progress % |
| 12.3 | Transcoding complete | Wait for Celery worker to finish | Status "Completed", HLS manifest URL set |
| 12.4 | HLS playback | After transcoding, view post | VideoPlayer loads, adaptive quality works |
| 12.5 | Auto-thumbnail | Check post after transcoding | Thumbnail auto-generated at 25% position |
| 12.6 | Transcoding failure | Upload corrupt file | Status "Failed", error message shown |

Check transcoding jobs in Django shell:

```python
from content.models import TranscodingJob
jobs = TranscodingJob.objects.all()
for job in jobs:
    print(f"Post {job.post_id}: {job.media_type} — {job.status} ({job.progress}%)")
    if job.hls_manifest_url:
        print(f"  HLS: {job.hls_manifest_url}")
    if job.error_message:
        print(f"  Error: {job.error_message}")
```

### 4.2 Audio Upload & Processing

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 13.1 | Upload audio post | Create post with content_type=audio, attach .mp3/.wav | Upload progress shown |
| 13.2 | Audio processing | Wait for Celery | Normalized MP3 output, waveform data generated |
| 13.3 | Waveform display | View audio post | 128-point waveform visualization shown |
| 13.4 | Audio playback | Click play on audio post | AudioPlayer plays processed MP3 |

### 4.3 Persistent Audio Player

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 14.1 | Start playback | Play audio on a post page | MiniPlayer appears at bottom |
| 14.2 | Navigate away | Click to a different page | Audio keeps playing, MiniPlayer persists |
| 14.3 | Seek | Drag seek bar in MiniPlayer | Playback jumps to position |
| 14.4 | Pause/Resume | Click pause, then play | Playback pauses and resumes |
| 14.5 | Close player | Click X on MiniPlayer | Audio stops, player hidden |
| 14.6 | Track info | While playing | Title, creator name, thumbnail visible in MiniPlayer |

### 4.4 Rich Text Editor

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 15.1 | Bold/Italic | Select text, click B/I | Formatting applied in editor |
| 15.2 | Headings | Apply H1, H2, H3 | Heading sizes render |
| 15.3 | Lists | Create bullet and numbered lists | Lists render correctly |
| 15.4 | Links | Insert hyperlink | Link clickable in preview |
| 15.5 | Inline image | Upload image via editor toolbar | Image inserted, uploaded to `/api/v1/content/inline-images/` |
| 15.6 | HTML output | Save post with rich text | `body_html` field populated, `body` has plain text |

### 4.5 Content Type Filtering

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 16.1 | Explore by type | `/explore?media_type=video` | Only video projects shown |
| 16.2 | Post feed by type | Filter posts by content_type on feed | Only matching posts shown |
| 16.3 | Creator profile tabs | View creator, switch between content tabs | Content filtered correctly |

---

## 5. Phase 4: Subscriptions & Pool/Boost System

### 5.1 Subscription Tiers

Verify tier properties in Django shell:

```python
from subscriptions.models import Subscription
from decimal import Decimal

# Test tier properties
for tier_value, tier_label in Subscription.Tier.choices:
    s = Subscription(tier=tier_value, is_active=True)
    print(f"{tier_label}: pool=${s.creator_pool_amount}, "
          f"boost=${s.boost_pool_amount}, "
          f"hours={s.monthly_content_hours}, "
          f"gate={s.has_gate_access}")

# Expected:
# Window:    pool=$0.00, boost=$0.00, hours=10,   gate=False
# Base:      pool=$4.85, boost=$0.00, hours=25,   gate=False
# Supporter: pool=$4.70, boost=$5.00, hours=None, gate=True
# Advocate:  pool=$4.55, boost=$10.00, hours=None, gate=True
# Champion:  pool=$4.40, boost=$15.00, hours=None, gate=True
```

### 5.2 Subscription CRUD

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 17.1 | View tiers | `GET /api/v1/subscriptions/tiers/` | All 5 tiers with pricing |
| 17.2 | Subscribe (Base) | As viewer, `POST /subscribe/` with tier=base | Stripe checkout session, subscription created |
| 17.3 | View subscription | `GET /api/v1/subscriptions/me/` | Shows tier, dates, active status |
| 17.4 | Cancel | `POST /api/v1/subscriptions/cancel/` | `canceled_at` set, active until period end |
| 17.5 | Resume | `POST /api/v1/subscriptions/resume/` | `canceled_at` cleared |
| 17.6 | Subscription page | `/subscription` | Shows current tier, pool info, boost controls |

### 5.3 Attention Tracking

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 18.1 | Page view event | Visit a project page while logged in | AttentionEvent created (event_type=page_view) |
| 18.2 | Play event | Play a game (project with embed) | AttentionEvent (event_type=play) with duration |
| 18.3 | Watch event | Watch a video post | AttentionEvent (event_type=watch) with duration |
| 18.4 | Listen event | Listen to audio via MiniPlayer | AttentionEvent (event_type=listen) with duration |
| 18.5 | Read event | Read a text post | AttentionEvent (event_type=read) with duration |
| 18.6 | Batch reporting | Wait 30+ seconds on content | Events flushed to API in batch |
| 18.7 | Tab visibility | Switch tabs while content is active | Duration accumulation pauses |
| 18.8 | Attention summary | `GET /api/v1/subscriptions/attention/summary/` | Hours used, cap, tier shown |

Verify events in Django shell:

```python
from subscriptions.models import AttentionEvent
events = AttentionEvent.objects.order_by("-created_at")[:10]
for e in events:
    print(f"{e.user} -> {e.creator}: {e.event_type} {e.duration_seconds}s "
          f"(project={e.project_id}, post={e.post_id})")
```

### 5.4 Pool Distribution

Test the distribution algorithm in Django shell:

```python
from subscriptions.tasks import distribute_pool
from subscriptions.models import Subscription, AttentionEvent, PoolDistribution
from django.contrib.auth import get_user_model
from decimal import Decimal

User = get_user_model()
viewer = User.objects.get(username="viewer1")
creator1 = User.objects.get(username="creator1")
creator2 = User.objects.get(username="creator2")

# Ensure viewer has an active Base subscription
sub, _ = Subscription.objects.get_or_create(
    user=viewer, defaults={"tier": "base", "is_active": True}
)

# Create test attention events
from django.utils import timezone
AttentionEvent.objects.create(
    user=viewer, creator=creator1,
    event_type="play", duration_seconds=3600  # 1 hour
)
AttentionEvent.objects.create(
    user=viewer, creator=creator2,
    event_type="watch", duration_seconds=1800  # 30 min
)

# Run distribution
result = distribute_pool(subscription_id=sub.pk)
print(f"Processed: {result}")

# Check distributions
for pd in PoolDistribution.objects.filter(subscriber=viewer):
    print(f"  -> {pd.creator.username}: pool=${pd.pool_amount}, "
          f"boost=${pd.boost_amount}, attention={pd.attention_seconds}s")

# Expected for Base ($4.85 pool):
#   creator1: ~$3.23 (2/3 of attention)
#   creator2: ~$1.62 (1/3 of attention)
#   Sum should equal $4.85 exactly (drift correction applied)
```

### 5.5 Boost Allocations

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 19.1 | View boosts | `GET /api/v1/subscriptions/boosts/` | List of current allocations, remaining budget |
| 19.2 | Allocate boost | `POST /api/v1/subscriptions/boosts/` with creator + amount | Allocation created |
| 19.3 | Budget enforcement | Try to allocate more than boost_pool_amount | Error: insufficient budget |
| 19.4 | Lock-in | Adjust allocation a second time | `is_locked=True` on first adjustment |
| 19.5 | Boost in distribution | Run distribute_pool after boost | PoolDistribution shows boost_amount |

### 5.6 Creator Gates & Content Access

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 20.1 | Create gate | As creator, `POST /api/v1/subscriptions/gates/` | Gate created with threshold |
| 20.2 | Gated post | Create post with visibility=gated | Post created |
| 20.3 | Access denied | As non-subscriber, view gated post | Paywall/locked message |
| 20.4 | Access granted | As subscriber with sufficient boost | Full content visible |
| 20.5 | Subscribers-only | Create post with visibility=subscribers_only | Only paid subscribers can read |

---

## 6. Phase 5: ATProto Integration

> **Note:** ATProto tests require a Bluesky PDS (Personal Data Server) or sandbox. For basic validation, the OAuth flow can be tested against `bsky.social`.

### 6.1 Bluesky Identity

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 21.1 | Client metadata | `GET /api/v1/accounts/atproto/client-metadata.json` | Valid OAuth client metadata JSON |
| 21.2 | Auth initiation | `POST /api/v1/accounts/atproto/auth/` with handle | Returns `authorization_url` |
| 21.3 | Link Bluesky | In Settings, enter Bluesky handle, complete OAuth | `atproto_did` and `atproto_handle` populated on user |
| 21.4 | Unlink Bluesky | In Settings, click "Disconnect Bluesky" | Fields cleared |
| 21.5 | Login with Bluesky | On login page, use "Sign in with Bluesky" | OAuth flow, account linked or new account created |

### 6.2 ATProto Lexicons

Verify lexicon files exist:

```bash
ls backend/lexicons/
# Expected: com.bluebell.game.json, com.bluebell.devlog.json,
#           com.bluebell.rating.json, com.bluebell.follow.json,
#           com.bluebell.boost.json
```

### 6.3 ATProto Write Paths

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 22.1 | atproto_uri on Project | Create project with linked Bluesky | `atproto_uri` field populated |
| 22.2 | atproto_uri on Post | Create post with linked Bluesky | `atproto_uri` field populated |
| 22.3 | atproto_uri on Rating | Rate a project | `atproto_uri` on Rating record |
| 22.4 | atproto_uri on Follow | Follow a creator | `atproto_uri` on Follow record |

### 6.4 Source of Truth Sync

Verify the rebuild command exists:

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python manage.py shell -c "
from accounts.atproto_sync import rebuild_index
print('Sync module importable:', True)
"
```

---

## 7. Phase 6: Cross-Publishing & Analytics

### 7.1 Native Analytics

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 23.1 | Analytics overview | `GET /api/v1/integrations/analytics/overview/?period=30` | Aggregated metrics for last 30 days |
| 23.2 | Content analytics | `GET /api/v1/integrations/analytics/content/` | Per-project and per-post breakdown |
| 23.3 | Timeseries | `GET /api/v1/integrations/analytics/timeseries/?period=7` | Daily data points |
| 23.4 | Cross-platform comparison | `GET /api/v1/integrations/analytics/comparison/` | Bluebell vs external metrics |
| 23.5 | Analytics dashboard | `/dashboard/analytics` | Charts, tables, stats cards load |
| 23.6 | Period selector | Change period from 30 to 7 days | Data updates accordingly |

### 7.2 Platform Connections

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 24.1 | List platforms | `GET /api/v1/integrations/platforms/` | Empty list initially |
| 24.2 | Connect API key platform | `POST /api/v1/integrations/platforms/connect/` with platform=itchio, api_key=test | Connection created |
| 24.3 | YouTube OAuth init | `POST /api/v1/integrations/platforms/youtube/auth/` | Returns authorization_url (requires Google credentials) |
| 24.4 | Disconnect platform | `DELETE /api/v1/integrations/platforms/itchio/disconnect/` | Connection removed |
| 24.5 | Settings page connections | `/settings` > Platform Connections section | Connect/disconnect buttons for all platforms |

### 7.3 Cross-Publishing

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 25.1 | Initiate cross-publish | `POST /api/v1/integrations/cross-publish/initiate/` | CrossPublishResult created with status=pending |
| 25.2 | View history | `GET /api/v1/integrations/cross-publish/` | List of cross-publish results |
| 25.3 | Dashboard section | Analytics dashboard > Cross-Publish History | Results table with status badges |

### 7.4 Revenue Section

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 26.1 | Earnings display | Analytics dashboard > Revenue section | Pool income, boost income, total, supporter count |

---

## 8. Phase 7: Game Jams

### 8.1 Jam CRUD

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 27.1 | Create jam | `/dashboard/jams/new` > fill form with future dates | Jam created with status=upcoming |
| 27.2 | List jams | `/jams` | Jams shown, filterable by status tabs |
| 27.3 | View upcoming jam | `/jams/:slug` | Theme hidden, "Starts in X days" shown |
| 27.4 | Edit jam | `/dashboard/jams/:slug/edit` | Form pre-populated, changes saved |
| 27.5 | Jam status transitions | Set dates to trigger each status | upcoming -> active -> voting -> ended |

To test status transitions, create a jam with dates in the past via Django shell:

```python
from jams.models import GameJam
from django.contrib.auth import get_user_model
from django.utils import timezone
from datetime import timedelta

User = get_user_model()
creator = User.objects.get(username="creator1")

# Active jam (started 1 day ago, ends in 6 days)
jam = GameJam.objects.create(
    creator=creator,
    title="Test Active Jam",
    slug="test-active-jam",
    description="A test jam",
    theme="Minimalism",
    start_at=timezone.now() - timedelta(days=1),
    end_at=timezone.now() + timedelta(days=6),
    voting_end_at=timezone.now() + timedelta(days=9),
)
print(f"Status: {jam.status}")           # "active"
print(f"Theme visible: {jam.is_theme_visible}")  # True
```

### 8.2 Jam Entries

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 28.1 | Submit entry | On active jam page, select project, submit | Entry created, shown in list |
| 28.2 | Duplicate entry | Submit same project again | Error: already submitted |
| 28.3 | Entry from non-published | Submit unpublished project | Error: project must be published |
| 28.4 | Entry after deadline | Submit after end_at | Error: jam is no longer accepting entries |

### 8.3 Voting

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 29.1 | Vote on entry | During voting phase, rate entry 1-5 stars | Vote recorded |
| 29.2 | Change vote | Vote again on same entry | Vote updated (not duplicated) |
| 29.3 | Self-voting | Try to vote on own entry | Error: cannot vote on own entry |
| 29.4 | Vote outside period | Try voting during active or ended phase | Error: voting not open |

### 8.4 Results

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 30.1 | View results | After voting_end_at, visit jam results | Entries ranked by average score |
| 30.2 | Results before end | During voting, try to view results | Error or results hidden |
| 30.3 | Ranking order | Entries with scores 4.5, 3.0, 4.8 | Ranked: 4.8 (#1), 4.5 (#2), 3.0 (#3) |

---

## 9. Phase 8: Migration Tools & Growth

### 9.1 Project Sorting on Explore Page

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 31.1 | Sort: Newest | `/explore?sort=newest` | Projects by created_at descending |
| 31.2 | Sort: Popular | `/explore?sort=popular` | Projects by view_count descending |
| 31.3 | Sort: Top Rated | `/explore?sort=top_rated` | Projects by rating_average descending |
| 31.4 | Sort: Trending | `/explore?sort=trending` | Projects by recent attention events (7 days) |
| 31.5 | Sort: Downloads | `/explore?sort=downloads` | Projects by download_count descending |
| 31.6 | Sort dropdown | Change sort option | URL param updates, results re-fetch |
| 31.7 | Sort + filter combo | Sort=popular + media_type=game | Filtered AND sorted correctly |

### 9.2 View & Download Tracking

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 32.1 | View count increment | Visit `/explore/:slug` | Project view_count increments by 1 |
| 32.2 | View count in sidebar | Check ProjectSidebar | Eye icon with count displayed |
| 32.3 | Download count | Click Download on an asset | download_count increments via API |
| 32.4 | Download count display | Check ProjectSidebar | Download icon with count (if > 0) |

Verify in Django shell:

```python
from content.models import Project
p = Project.objects.get(slug="your-test-project")
print(f"Views: {p.view_count}, Downloads: {p.download_count}")
```

### 9.3 itch.io Import Tool

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 33.1 | Preview games | `/dashboard/import` > enter known itch.io username | List of public games appears |
| 33.2 | No games found | Enter nonexistent username | "No public games found" error |
| 33.3 | Select games | Check/uncheck individual games | Selection count updates |
| 33.4 | Select all | Click "Select all" checkbox | All games checked |
| 33.5 | Import games | Click "Import X selected" | Games imported as draft projects |
| 33.6 | Import results | After import completes | Results show imported/failed with "Edit Draft" links |
| 33.7 | Drafts created | Visit Dashboard | New draft projects visible in project list |
| 33.8 | Cover images | Open an imported project | Cover image downloaded from itch.io |
| 33.9 | Tags preserved | Check imported project tags | Tags from itch.io page present |

> **Note:** This test requires network access to itch.io. Use a real public itch.io username with games.

### 9.4 CRF Subsidy Logic

Test the subsidy calculation in Django shell:

```python
from payments.tasks import calculate_crf_subsidies, _estimate_hosting_cost, _get_creator_earnings, _get_cycle_date
from payments.models import CRFLedger, CRFSubsidy
from django.contrib.auth import get_user_model
from decimal import Decimal

User = get_user_model()
creator = User.objects.get(username="creator1")

# Seed CRF balance (simulate purchase fees collected)
CRFLedger.objects.create(amount=Decimal("50.00"), description="Test CRF seed")

# Check hosting cost estimate
cost = _estimate_hosting_cost(creator)
print(f"Hosting cost: ${cost['total_cost']}")
print(f"  Storage: {cost['storage_bytes']} bytes")
print(f"  Projects: {cost['project_count']}")
print(f"  Posts: {cost['post_count']}")

# Check earnings
cycle = _get_cycle_date()
earnings = _get_creator_earnings(creator, cycle)
print(f"Earnings: ${earnings}")

# Run subsidy calculation
result = calculate_crf_subsidies()
print(f"Creators subsidized: {result}")

# Check subsidy records
for s in CRFSubsidy.objects.filter(creator=creator):
    print(f"  Cycle {s.billing_cycle}: hosting=${s.estimated_hosting_cost}, "
          f"earnings=${s.creator_earnings}, subsidy=${s.subsidy_amount}")

# Check CRF balance after subsidy
from django.db.models import Sum
balance = CRFLedger.objects.aggregate(total=Sum("amount"))["total"]
print(f"CRF Balance: ${balance}")
```

### 9.5 CRF Status API

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 34.1 | CRF status endpoint | `GET /api/v1/payments/crf/status/` | Returns crf_balance and subsidies list |
| 34.2 | Analytics dashboard | `/dashboard/analytics` > Hosting Costs section | Shows hosting cost, earnings, subsidy, storage |
| 34.3 | Subsidy messaging | Creator with subsidy > 0 | "CRF is covering part of your hosting costs" |
| 34.4 | Self-sufficient | Creator with earnings > costs | "Your earnings cover your hosting costs" |

---

## 10. Backend API Smoke Tests

Run all endpoints in sequence to verify nothing returns 500. This can be run from outside Docker with `curl` or from within the backend container.

```bash
# Save session cookie after login
LOGIN_RESP=$(curl -s -c cookies.txt -X POST http://localhost:8000/api/v1/accounts/login/ \
  -H "Content-Type: application/json" \
  -d '{"username":"creator1","password":"testpass123"}')
echo "Login: $LOGIN_RESP"

# Extract CSRF token
CSRF=$(grep csrftoken cookies.txt | awk '{print $NF}')

# Helper function
api_get() {
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b cookies.txt \
    "http://localhost:8000$1")
  echo "$STATUS $1"
}

api_post() {
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b cookies.txt \
    -H "X-CSRFToken: $CSRF" -H "Content-Type: application/json" \
    -X POST "http://localhost:8000$1" -d "${2:-{}}")
  echo "$STATUS $1"
}

# ─── Accounts ───
api_get "/api/v1/accounts/me/"
api_get "/api/v1/accounts/creators/"
api_get "/api/v1/accounts/me/feed/"
api_get "/api/v1/accounts/me/following/"
api_get "/api/v1/accounts/atproto/client-metadata.json"

# ─── Content ───
api_get "/api/v1/content/projects/"
api_get "/api/v1/content/projects/?sort=popular"
api_get "/api/v1/content/projects/?sort=trending"
api_get "/api/v1/content/projects/?media_type=game"
api_get "/api/v1/content/posts/"

# ─── Payments ───
api_get "/api/v1/payments/stripe/onboard/"
api_get "/api/v1/payments/purchases/"
api_get "/api/v1/payments/crf/status/"

# ─── Subscriptions ───
api_get "/api/v1/subscriptions/tiers/"
api_get "/api/v1/subscriptions/me/"
api_get "/api/v1/subscriptions/attention/summary/"
api_get "/api/v1/subscriptions/distributions/"
api_get "/api/v1/subscriptions/earnings/"
api_get "/api/v1/subscriptions/boosts/"
api_get "/api/v1/subscriptions/gates/"

# ─── Integrations ───
api_get "/api/v1/integrations/analytics/overview/"
api_get "/api/v1/integrations/analytics/content/"
api_get "/api/v1/integrations/analytics/timeseries/"
api_get "/api/v1/integrations/analytics/comparison/"
api_get "/api/v1/integrations/platforms/"
api_get "/api/v1/integrations/cross-publish/"

# ─── Jams ───
api_get "/api/v1/jams/"

echo "Smoke tests complete. Any 500s above indicate bugs."
```

Expected: all endpoints return 200, 201, or 403/404 (never 500).

---

## 11. Frontend TypeScript Verification

```bash
# Run TypeScript type checking (inside container)
docker compose -f docker-compose.dev.yml exec frontend bun run typecheck

# Expected: clean output, no errors
# $ tsc --noEmit
```

Verify the frontend builds without errors:

```bash
docker compose -f docker-compose.dev.yml exec frontend bun run build
```

---

## 12. Database & Migration Integrity

```bash
# Check for unapplied migrations
docker compose -f docker-compose.dev.yml exec backend \
  python manage.py showmigrations | grep "\[ \]"
# Expected: empty output (all migrations applied)

# Check for model/migration drift
docker compose -f docker-compose.dev.yml exec backend \
  python manage.py makemigrations --check --dry-run
# Expected: "No changes detected"

# Verify all models load
docker compose -f docker-compose.dev.yml exec backend \
  python manage.py shell -c "
from accounts.models import User, Follow, ATProtoSession
from content.models import Project, Post, Asset, Screenshot, Comment, Rating, TranscodingJob, InlineImage
from payments.models import StripeAccount, Purchase, CRFLedger, CRFSubsidy
from subscriptions.models import Subscription, AttentionEvent, BoostAllocation, PoolDistribution, CreatorGate
from integrations.models import PlatformConnection, CrossPublishResult, ExternalMetricSnapshot
from jams.models import GameJam, JamEntry, JamVote
print('All 23 models loaded successfully')
"
```

---

## 13. Celery Task Verification

### 13.1 Verify Tasks Are Registered

```bash
docker compose -f docker-compose.dev.yml exec celery-worker \
  celery -A _django inspect registered | head -30
# Expected: lists all tasks including:
#   content.tasks.transcode_video
#   content.tasks.process_audio
#   subscriptions.distribute_pool
#   subscriptions.aggregate_attention
#   payments.calculate_crf_subsidies
#   integrations.tasks.cross_publish_to_platform
#   integrations.tasks.fetch_external_metrics
```

### 13.2 Verify Worker Is Processing

```bash
docker compose -f docker-compose.dev.yml exec celery-worker \
  celery -A _django inspect active
# Expected: shows active tasks or empty list (no errors)
```

### 13.3 Verify Beat Schedule

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python manage.py shell -c "
from django.conf import settings
for name, task in settings.CELERY_BEAT_SCHEDULE.items():
    print(f'{name}: {task[\"task\"]} every {task[\"schedule\"]}s')
"
# Expected:
#   fetch-external-metrics-every-6h: integrations.tasks.fetch_external_metrics every 21600s
#   distribute-pool-daily: subscriptions.tasks.distribute_pool every 86400s
#   calculate-crf-subsidies-monthly: payments.tasks.calculate_crf_subsidies every 86400s
```

### 13.4 Test Task Execution Manually

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python manage.py shell -c "
from subscriptions.tasks import distribute_pool
result = distribute_pool.delay()
print(f'Task submitted: {result.id}')
print(f'Result: {result.get(timeout=10)}')
"
```

---

## Quick Reference: All API Endpoints

### Accounts (`/api/v1/accounts/`)
```
POST   /register/
POST   /login/
POST   /logout/
GET    /me/
PATCH  /me/
GET    /me/following/
GET    /me/feed/
GET    /creators/
GET    /users/<username>/
POST   /users/<username>/follow/
POST   /users/<username>/unfollow/
GET    /atproto/client-metadata.json
POST   /atproto/auth/
POST   /atproto/callback/
POST   /atproto/unlink/
```

### Content (`/api/v1/content/`)
```
GET    /projects/                            ?sort=&media_type=&search=&tag=&creator=&mine=
POST   /projects/
GET    /projects/<slug>/
PATCH  /projects/<slug>/
DELETE /projects/<slug>/
POST   /projects/<slug>/assets/
DELETE /projects/<slug>/assets/<id>/
POST   /projects/<slug>/assets/<id>/download/
POST   /projects/<slug>/screenshots/
DELETE /projects/<slug>/screenshots/<id>/
GET    /projects/<slug>/comments/
POST   /projects/<slug>/comments/
GET    /projects/<slug>/ratings/
POST   /projects/<slug>/ratings/
GET    /posts/
POST   /posts/
GET    /posts/<id>/
PATCH  /posts/<id>/
DELETE /posts/<id>/
GET    /posts/<id>/comments/
POST   /posts/<id>/comments/
GET    /posts/<id>/transcoding/
POST   /media-upload/url/
POST   /media-upload/direct/
POST   /inline-images/
```

### Payments (`/api/v1/payments/`)
```
GET    /stripe/onboard/
POST   /stripe/onboard/
POST   /checkout/<slug>/
GET    /owns/<slug>/
GET    /purchases/
POST   /stripe/webhook/
GET    /crf/status/
```

### Subscriptions (`/api/v1/subscriptions/`)
```
GET    /tiers/
GET    /me/
POST   /subscribe/
POST   /cancel/
POST   /resume/
GET    /billing-portal/
POST   /attention/
GET    /attention/summary/
GET    /distributions/
GET    /earnings/
GET    /boosts/
POST   /boosts/
GET    /gates/
POST   /gates/
PATCH  /gates/<id>/
DELETE /gates/<id>/
POST   /access/<post_id>/
POST   /webhook/
```

### Integrations (`/api/v1/integrations/`)
```
GET    /analytics/overview/                  ?period=30
GET    /analytics/content/                   ?period=30&type=all
GET    /analytics/timeseries/                ?period=30
GET    /analytics/comparison/                ?period=30
GET    /platforms/
POST   /platforms/connect/
DELETE /platforms/<platform>/disconnect/
POST   /platforms/youtube/auth/
GET    /platforms/youtube/callback/
GET    /cross-publish/
POST   /cross-publish/initiate/
GET    /import/itchio/preview/               ?username=X
POST   /import/itchio/detail/
POST   /import/itchio/
```

### Jams (`/api/v1/jams/`)
```
GET    /                                     ?status=upcoming|active|voting|ended
POST   /
GET    /<slug>/
PATCH  /<slug>/
DELETE /<slug>/
GET    /<slug>/entries/
POST   /<slug>/entries/
POST   /<slug>/entries/<id>/vote/
GET    /<slug>/results/
```
