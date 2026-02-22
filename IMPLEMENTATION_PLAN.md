# Bluebell Implementation Plan

## Context

The transient docs describe a full platform vision: federated game marketplace → creator audience-building tools (devlogs, vlogs, blogs) → subscriptions/pools → ATProto portability → cross-publishing → multi-media expansion. Stages 1-2 of the FRONTEND_PLAN are complete (auth, project/post viewing, marketing pages, UI primitives). The remaining work spans 8 phases.

**Strategic priority**: The Patreon/YouTube Membership-like experience — where creators build audiences through native content (devlogs, vlogs, blogs, podcasts) alongside their games — is more important than game jams. Multi-media support and subscriptions are prioritized accordingly.

---

## Phase 1: Game Marketplace MVP (Current Sprint)

Completes FRONTEND_PLAN Stages 3-5. After this, creators can publish games end-to-end and users can discover/play/download/rate them.

### 1A — Backend: Screenshot Upload API

**Modify** `backend/content/views.py` — add `ScreenshotUploadView` (POST) and `ScreenshotDeleteView` (DELETE), both checking project ownership.

**Modify** `backend/content/urls.py` — add:
- `projects/<slug>/screenshots/` → upload
- `projects/<slug>/screenshots/<pk>/` → delete

No new models needed — `Screenshot` model and `ScreenshotSerializer` already exist.

### 1B — Frontend: Protected Pages (7 new pages)

| Page | Route | Key behavior |
|---|---|---|
| `FeedPage` | `/feed` | Posts from followed creators via `/api/v1/accounts/me/feed/`, `EmptyState` if no follows |
| `DashboardPage` | `/dashboard` | Lists own projects (`?mine=true`) + own posts, links to create/edit forms, summary stats |
| `ProjectFormPage` | `/dashboard/projects/new` and `…/:slug/edit` | Full project create/edit: title, slug (auto-gen), description, media_type, tags, pricing fields, cover image upload, screenshot management, embed_url, publish toggle |
| `BuildsPage` | `/dashboard/projects/:slug/builds` | Asset upload (file + platform + version), existing builds table with delete |
| `PostFormPage` | `/dashboard/posts/new` and `…/:id/edit` | Title, body (textarea), optional project link, publish toggle |
| `SettingsPage` | `/settings` | Profile editing (display_name, bio, avatar, header_image, website_url, location), "Become a creator" toggle (`is_creator`) |

All wrapped in `ProtectedRoute`. Routes added to `App.tsx`.

**Modify** `frontend/src/lib/api.ts` — add `uploadPatch` for multipart PATCH.

### 1C — Frontend: Rich Media Components (5 new components)

| Component | Path | Purpose |
|---|---|---|
| `FileUpload` | `components/ui/FileUpload.tsx` | Drag-and-drop file upload, reused across all forms |
| `ProjectEmbed` | `components/project/ProjectEmbed.tsx` | Sandboxed iframe for HTML5/WebGL games, "Play in Browser" toggle |
| `ProjectScreenshots` | `components/project/ProjectScreenshots.tsx` | Click-to-lightbox gallery with navigation |
| `TransparentReceipt` | `components/ui/TransparentReceipt.tsx` | Display-only itemized fee breakdown |
| `ProjectPricing` | `components/project/ProjectPricing.tsx` | Pricing display for paid/PWYW projects with receipt preview, "payments coming soon" for now |

**Modify** `pages/ProjectPage.tsx` — integrate `ProjectEmbed`, `ProjectScreenshots`, `ProjectPricing`.

### 1D — Markdown Rendering

Add `react-markdown` + `remark-gfm` dependency. Render markdown in `ProjectPage` (description), `PostPage` (body), and form previews.

### 1E — HomePage Enhancement

**Modify** `pages/HomePage.tsx` — add featured projects grid, recent posts, and featured creators below the hero (fetched from existing API endpoints).

### 1F — Marketing Page Updates

**Modify** `pages/ForCreatorsPage.tsx` and `pages/ForUsersPage.tsx`:
- Ensure subscription tier table (Window/Base/Supporter/Advocate/Champion) is showcased
- Ensure ATProto data portability and "Sign in with Bluesky" are highlighted
- Ensure cross-publishing and unified analytics are featured
- Highlight the audience-building tools: native devlogs, vlogs, blogs alongside game hosting
- Remove any "coming soon" language around features that are now live (dashboard, project creation)

### Phase 1 Implementation Order

1. Screenshot upload API (unblocks ProjectFormPage)
2. `FileUpload` component (needed by multiple forms)
3. `SettingsPage` (simplest protected page, establishes pattern)
4. `FeedPage` (simple, establishes ProtectedRoute routing)
5. `DashboardPage` (read-only hub)
6. `PostFormPage` (simpler form, establishes create/edit pattern)
7. `ProjectFormPage` (complex form with images + screenshots)
8. `BuildsPage` (asset management)
9. `ProjectEmbed` (sandboxed iframe)
10. `ProjectScreenshots` (lightbox)
11. `TransparentReceipt` + `ProjectPricing` (display-only)
12. Markdown rendering
13. `HomePage` update
14. Marketing page updates

---

## Phase 2: Payments & Marketplace Transactions (Months 1-3)

Real purchases for paid/PWYW games. Transparent fee pass-through with CRF.

### Backend — New `payments` Django app

**Models**: `StripeAccount` (creator's Connect account — stripe_account_id, charges_enabled, payouts_enabled, onboarding_complete), `Purchase` (buyer, project, amount + CRF + infra + processing fees, stripe_payment_intent_id, status), `CRFLedger` (fund accounting entries — amount, source, description)

**API endpoints** at `/api/v1/payments/`:
- `POST/GET stripe/onboard/` — creator Stripe Connect Express onboarding
- `POST stripe/webhook/` — Stripe webhook handler (account.updated, payment_intent.succeeded, etc.)
- `POST checkout/<slug>/` — initiate purchase (calculates fees, creates PaymentIntent with transfer_data, returns client_secret)
- `GET purchases/` — user's purchase history
- `GET owns/<slug>/` — ownership check for download gating

**Dependencies**: `stripe` Python package, `@stripe/stripe-js` + `@stripe/react-stripe-js` frontend packages.

### Frontend

- `ProjectPricing` becomes functional (Stripe.js checkout flow)
- `ProjectDownloads` gated behind ownership check for paid content
- `LibraryPage` (`/library`) — user's purchased games
- Stripe onboarding section in `SettingsPage` for creators

### Complexity flags

- Stripe Connect Express requires identity verification from creators; handle return URLs and webhooks
- Download gating for paid content may require signed URLs or a download proxy endpoint
- Fee calculations must be server-side; frontend shows estimates only
- Webhook handler must be idempotent (use stripe_payment_intent_id as key)

---

## Phase 3: Multi-Media Content & Audience Building (Months 3-6)

**The key differentiator.** Creators host their games AND build audiences through native devlogs, vlogs, blogs, and podcasts — all in one place. This is the Patreon/YouTube Membership experience that makes Bluebell more than an itch.io clone.

### 3A — Enhanced Posts → Content System

The existing `Post` model is a devlog stub. Expand it into a full content system for audience-building:

**Modify** `backend/content/models.py` — extend `Post`:
- `content_type` field: `text` (blog/devlog), `video`, `audio` (choices)
- `video_file` (FileField, for native video uploads)
- `audio_file` (FileField, for podcast/audio uploads)
- `thumbnail` (ImageField)
- `duration_seconds` (IntegerField, computed after upload)
- `is_premium` (BooleanField — for future gate system)
- `visibility` field: `public`, `subscribers_only`, `gated` (choices)

This keeps one unified content model rather than splitting into separate Video/Audio/Writing models. A post can be a text devlog, a video update, an audio podcast episode, or a combination.

### 3B — Video Support

**Backend**:
- Video upload endpoint accepting large files (chunked upload or presigned S3 URLs)
- Transcoding pipeline: Celery task → FFmpeg → adaptive bitrate HLS (1080p, 720p, 480p)
- Store HLS manifests and segments in S3
- `TranscodingJob` model to track status (pending, processing, complete, failed)

**Frontend**:
- `VideoPlayer` component (HLS.js-based, with quality selector)
- Video upload in `PostFormPage` with progress bar and transcoding status
- Video display in `PostPage` and `PostCard`

### 3C — Audio Support

**Backend**:
- Audio upload endpoint
- Transcoding: Celery task → FFmpeg → normalized MP3/AAC
- Optional: waveform generation for visual player

**Frontend**:
- `AudioPlayer` component (native HTML5 audio with custom controls, waveform optional)
- Audio upload in `PostFormPage`
- Persistent mini-player in `Layout` (continues playback across page navigation)

### 3D — Enhanced Writing

- Rich text editor in `PostFormPage` (consider Tiptap or similar — renders to HTML stored in `body`)
- Inline image uploads within post body
- Table of contents generation for long-form posts
- Estimated read time display

### 3E — Creator Content Feed

**Modify** `CreatorProfilePage` — add content type tabs: All / Games / Videos / Audio / Writing. Each tab filters by content_type.

**Modify** `FeedPage` — support mixed content types with appropriate cards (video thumbnail + duration, audio with inline player, text with excerpt).

**New component**: `ContentCard` — unified card that renders differently based on content_type (replaces or extends `PostCard`).

### Marketing updates

- Update `ForCreatorsPage` to prominently feature the multi-media audience-building tools
- Show mockups of the video player, audio player, and writing experience
- Emphasize "one platform for your games AND your audience content"

### Complexity flags

- **Video transcoding** is the heaviest infrastructure addition. Need Celery + FFmpeg workers. Consider cloud transcoding (AWS MediaConvert) if self-hosted FFmpeg is too slow.
- **Large file uploads** need chunked upload or presigned S3 URLs — standard multipart form upload won't work for 1GB+ video files.
- **HLS streaming** requires proper CORS and CDN configuration for segment delivery.
- **Persistent audio player** requires state management that survives React Router navigation (context or global store).

---

## Phase 4: Subscriptions & Pool/Boost System (Months 5-9)

**The core economic engine.** With multi-media content live, subscriptions now have real value — subscribers fund creators proportionally based on what they actually watch/read/listen to.

### Backend — New `subscriptions` Django app

**Models**:
- `Subscription` (user, tier [window/base/supporter/advocate/champion], stripe_subscription_id, billing period, is_active)
- `AttentionEvent` (user, creator, project/post, event_type [page_view/play/watch/read/listen], duration_seconds)
- `BoostAllocation` (user→creator, amount, billing_cycle, is_locked)
- `PoolDistribution` (subscriber→creator monthly ledger: pool_amount + boost_amount)
- `CreatorGate` (creator, threshold [$1/$1.50/$3/$5/$10], label, description)

**Subscription tiers** (from potential-user-subscription-models.md):

| Tier | Price | Creator Pool | Boost Pool | Content Cap | Gate Access |
|---|---|---|---|---|---|
| Window | $0 | — | — | 10 hrs | No |
| Base | $5 | $4.85 | — | 25 hrs | No |
| Supporter | $10 | $4.70 | $5.00 | Unlimited | Yes |
| Advocate | $15 | $4.55 | $10.00 | Unlimited | Yes |
| Champion | $20 | $4.40 | $15.00 | Unlimited | Yes |

**Key subsystems**:
- Attention tracking API (batch event reporting, every 30-60s from frontend)
- Pool distribution engine (background task per billing cycle — proportional attention-time allocation, CRF deduction, Stripe Connect payouts)
- Boost lock-in mechanics (first manual adjustment locks for billing cycle)
- Gate access computation (boost allocation vs threshold)

### Frontend

- `SubscribePage` (`/subscribe`) — tier selection with comparison table + Stripe checkout
- `SubscriptionDashboardPage` (`/subscription`) — monthly overview: CRF contribution, pool distribution per creator, boost sliders with lock status
- `AttentionTracker` component — invisible, reports durations on content pages
- Gate display on content: locked content preview with "Subscribe to unlock" prompts
- Creator earnings section in `DashboardPage`: pool income, boost income, infrastructure deduction, net earnings

**Complexity flags**:
- **This is the largest and most complex phase.** Consider sub-phasing: 4A (tiers + billing), 4B (attention tracking), 4C (pool distribution engine), 4D (boost allocation + gates).
- Pool distribution math (stepping function, minimum thresholds, edge cases) needs careful spec and testing.
- Billing cycle alignment: each user has their own cycle based on subscription start date.
- Attention tracking privacy: must be transparent and minimal.

---

## Phase 5: ATProto Integration (Months 7-12)

Can start identity work in parallel with Phases 3-4.

**5A — Identity**: Add `atproto_did` to User model, implement "Sign in with Bluesky" OAuth (custom Django auth backend resolving DIDs).

**5B — Lexicons**: Define schemas in `backend/lexicons/`:
- `com.bluebell.game` — game page record
- `com.bluebell.devlog` — devlog/post record
- `com.bluebell.rating` — user rating
- `com.bluebell.follow` — follow relationship
- `com.bluebell.boost` — boost allocation

**5C — Write Paths**: Add `atproto_uri` to `Project`, `Post`, `Rating`, `Comment`, `Follow`. Write ATProto record first, then index in Django.

**5D — Source of Truth**: Build sync logic to reconstruct Django index from ATProto records.

**Complexity**: PDS dependency (users need a Personal Data Server), ATProto SDK maturity for Python, back-filling existing content into ATProto records.

---

## Phase 6: Cross-Publishing & Analytics (Months 10-16)

### Backend — New `integrations` Django app

**Platform connections** (OAuth/API key storage per creator): YouTube (Google OAuth 2.0), Steam (publisher key), itch.io (API key + butler CLI).

**Cross-publishing**:
- YouTube: video upload via Data API v3, metadata sync, scheduled publishing
- itch.io: build push via butler CLI, metadata read
- Substack: post creation via internal API (fragile, best-effort — lowest priority)

**Analytics ingestion**: Background tasks polling external APIs (YouTube 6hr, Steam 12hr, itch.io 6hr).

### Frontend — `AnalyticsDashboardPage`

Four layers:
1. Platform overview (aggregated metrics across connected platforms)
2. Per-content comparison (same content side-by-side — the killer comparison: Bluebell $0.049/view vs YouTube $0.0016/view)
3. Audience analytics (geographic, device, overlap estimation)
4. Revenue analytics (unified view across all sources)

**Complexity**: YouTube API quotas (10K units/day, ~6 uploads/day), Substack has no official API and may break, external analytics have 2-3 day latency.

---

## Phase 7: Game Jams (Months 12-18)

Community growth engine — important but not urgent. Many devs find platforms through jams.

### Backend — New `jams` Django app

**Models**: `GameJam` (creator FK, title, slug, description, theme, start_at, end_at, voting_end_at, cover_image), `JamEntry` (jam FK, project FK, unique_together), `JamVote` (user FK, entry FK, 1-5 score, unique_together)

**API endpoints** at `/api/v1/jams/`:
- `GET/POST /` — list/create jams (with `?status=upcoming|active|voting|ended` filter)
- `GET/PUT/DELETE /<slug>/` — jam detail (theme hidden until start_at)
- `POST /<slug>/entries/` — submit project
- `POST /<slug>/entries/<pk>/vote/` — vote on entry
- `GET /<slug>/results/` — ranked results after voting ends

Jam status computed from dates: upcoming → active → voting → ended.

### Frontend

**Components**: `JamCard`, `JamEntryCard`, `JamStatusBadge`

**Pages**: `JamsPage` (`/jams`, tabbed by status), `JamPage` (`/jams/:slug`, state-dependent UI), `JamFormPage` (`/dashboard/jams/new`)

Add "Jams" to navbar and homepage.

---

## Phase 8: Migration Tools & Growth (Months 14-20)

- itch.io import tool (scrape public metadata → draft projects)
- Download/view tracking and trending algorithms
- Sort options on ExplorePage (newest, popular, top-rated)
- Self-hosting documentation and CDN-assisted local storage option
- Managed hosting CRF subsidy logic for small creators

---

## Future / Deferred (No Timeline)

- The Hosting Box (hardware appliance — Raspberry Pi 5 + 4TB HDD)
- WebRTC peer-assisted delivery for viral/premiere events
- Recommendation engine from aggregate allocation signals
- Full ATProto federation and feed generators
- Steam deep integration (SteamPipe CLI, Steamworks partner API)
- Creator bundles and advanced cohort analytics
- Wallet/balance system for micropayment batching

---

## Phase Dependency Graph

```
Phase 1 (MVP) ──┬──→ Phase 2 (Payments) ──┬──→ Phase 3 (Multi-Media) ──→ Phase 4 (Subscriptions)
                │                          │                                      │
                │                          └──→ Phase 8 (Migration)               ├──→ Phase 6 (Cross-Pub)
                │                                                                 └──→ Phase 7 (Jams)
                └──→ Phase 5 (ATProto) — can start in parallel with Phases 2-3
```

Phases 2→3→4 form the critical path: marketplace transactions → multi-media content → subscription monetization.

---

## Verification (Phase 1)

After Phase 1 implementation:
1. `make build && make up` — verify containers start
2. Register a user, enable creator mode in Settings
3. Create a project with cover image, screenshots, embed URL, tags, pricing
4. Upload build assets, verify download links
5. Create a devlog post linked to the project
6. Browse as anonymous user: Explore page, project page with embed/lightbox/pricing display
7. Follow a creator, check Feed page
8. Rate and comment on a project
9. Verify marketing pages render correctly with subscription/ATProto/multi-media showcases
10. `cd frontend && bun run typecheck` — no type errors
