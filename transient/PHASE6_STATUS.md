# Phase 6: Cross-Publishing & Analytics — STATUS

**Last updated:** 2026-02-25
**Branch:** `main`

---

## COMPLETED — All 4 Sub-Phases

### Sub-Phase 6A: Integrations App + Native Analytics ✅

- New `integrations` Django app with models:
  - `PlatformConnection` — OAuth tokens/API keys per creator per platform (YouTube, Steam, itch.io, Substack)
  - `CrossPublishResult` — tracks cross-published content status, external IDs, URLs
  - `ExternalMetricSnapshot` — daily snapshots of external platform metrics (views, likes, comments, watch time, revenue)
- Analytics endpoints aggregating native `AttentionEvent` data:
  - `GET /api/v1/integrations/analytics/overview/` — total views, duration, unique viewers, event breakdown
  - `GET /api/v1/integrations/analytics/content/` — per-project and per-post metrics
  - `GET /api/v1/integrations/analytics/timeseries/` — daily time-series with all event types
  - `GET /api/v1/integrations/analytics/comparison/` — cross-platform comparison (Bluebell vs external)
- Frontend `AnalyticsDashboardPage` at `/dashboard/analytics`:
  - Overview stat cards (views, watch time, unique viewers, total events)
  - Engagement breakdown bar with color-coded event types
  - Daily trends sparkline charts (events, viewers, duration)
  - Content performance table with per-item metrics
  - Dashboard page links to analytics

### Sub-Phase 6B: Platform Connections ✅

- YouTube OAuth 2.0 flow:
  - `youtube_oauth.py` module with Google authorization code exchange, PKCE, token refresh
  - Channel info fetching via YouTube Data API v3
  - `POST /api/v1/integrations/platforms/youtube/auth/` — initiate OAuth
  - `GET /api/v1/integrations/platforms/youtube/callback/` — handle callback, save tokens
- API key connection for Steam, itch.io, Substack:
  - `POST /api/v1/integrations/platforms/connect/` — connect with API key
  - `DELETE /api/v1/integrations/platforms/<platform>/disconnect/` — disconnect
  - `GET /api/v1/integrations/platforms/` — list connections
- Frontend: Platform Connections section in Settings page
  - Shows all 4 platforms with connect/disconnect buttons
  - OAuth redirect for YouTube, inline API key input for others
  - Connected status display with platform username
- Google OAuth settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`

### Sub-Phase 6C: Cross-Publishing Engine ✅

- Platform-specific publishers in `publishers.py`:
  - YouTube: Resumable video upload via Data API v3, automatic token refresh
  - itch.io: API-based game lookup (full creation requires butler CLI)
  - Substack: Placeholder (no official API)
- Celery tasks in `tasks.py`:
  - `cross_publish_to_platform` — dispatches to platform publisher, retries 2x on failure
  - `fetch_external_metrics` — periodic metrics collection from YouTube/itch.io APIs
- Cross-publish initiation endpoint:
  - `POST /api/v1/integrations/cross-publish/initiate/` — creates job, dispatches Celery task
  - Verifies content ownership and platform connection
  - Prevents duplicate publishes (checks existing pending/published results)
- Cross-publish history on analytics dashboard with status badges and external links

### Sub-Phase 6D: External Analytics Ingestion ✅

- Celery Beat schedule:
  - `fetch_external_metrics` every 6 hours
  - `distribute_pool` daily
- Management command: `python manage.py fetch_metrics [--platform <name>] [--user <username>]`
- Revenue analytics section on analytics dashboard (pool/boost income, supporter count)

---

## API Endpoints

```
# Analytics (authenticated)
GET  /api/v1/integrations/analytics/overview/?period=30
GET  /api/v1/integrations/analytics/content/?period=30&type=all|projects|posts
GET  /api/v1/integrations/analytics/timeseries/?period=30
GET  /api/v1/integrations/analytics/comparison/?period=30

# Platform Connections (authenticated)
GET  /api/v1/integrations/platforms/
POST /api/v1/integrations/platforms/connect/          (api_key platforms)
DEL  /api/v1/integrations/platforms/<platform>/disconnect/

# YouTube OAuth (authenticated)
POST /api/v1/integrations/platforms/youtube/auth/
GET  /api/v1/integrations/platforms/youtube/callback/

# Cross-Publishing (authenticated)
GET  /api/v1/integrations/cross-publish/
POST /api/v1/integrations/cross-publish/initiate/
```

---

## Architecture Notes

### Analytics Pipeline
1. `AttentionEvent` records created by subscription attention tracker (existing Phase 4 system)
2. Analytics views aggregate events with Django ORM (`Count`, `Sum`, `TruncDate`)
3. External metrics fetched periodically via Celery Beat → `ExternalMetricSnapshot` table
4. Cross-platform comparison merges native + external data in single response

### Cross-Publishing Flow
1. Creator initiates cross-publish via API (specifies platform + content)
2. `CrossPublishResult` created with `PENDING` status
3. Celery task dispatched → platform-specific publisher called
4. On success: status → `PUBLISHED`, external_id/url saved
5. On failure: status → `FAILED`, error message saved, retry up to 2x

### YouTube OAuth
- Google OAuth 2.0 authorization code flow
- Scopes: `youtube.readonly`, `youtube.upload`, `yt-analytics.readonly`
- Tokens stored in `PlatformConnection` model
- Auto-refresh on expired token during publish or metrics fetch

### Configuration (env vars)
```
GOOGLE_CLIENT_ID=          # Google OAuth client ID
GOOGLE_CLIENT_SECRET=      # Google OAuth client secret
GOOGLE_REDIRECT_URI=       # Override callback URL (optional)
```
