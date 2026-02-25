# Phase 8: Migration Tools & Growth — STATUS

**Last updated:** 2026-02-25
**Branch:** `main`

---

## COMPLETED — All Sub-Phases

### Sub-Phase 8A: Sort/Trending + View/Download Tracking ✅

- Added `view_count` and `download_count` fields to Project model with DB indexes
- ProjectDetailView increments view_count on each GET (using F() for atomicity)
- New `AssetDownloadView` endpoint increments download_count on asset download
- Sorting query parameter `?sort=newest|popular|top_rated|trending|downloads`:
  - `newest`: default, by `-created_at`
  - `popular`: by `-view_count`
  - `top_rated`: by rating average (with Coalesce for nulls)
  - `trending`: by attention events in last 7 days
  - `downloads`: by `-download_count`
- Frontend ExplorePage updated with sort dropdown
- ProjectSidebar shows view/download counts
- ProjectDownloads component tracks downloads via API before redirecting

### Sub-Phase 8B: itch.io Import Tool ✅

- `itchio_importer.py` module scrapes public itch.io pages:
  - `fetch_user_games()`: List games from a user's profile
  - `fetch_game_details()`: Scrape title, description, cover, tags, screenshots, embed URL
  - `import_game_as_project()`: Create draft Project with downloaded images
- Three API endpoints under `/api/v1/integrations/import/itchio/`:
  - `GET preview/?username=X` — list user's games
  - `POST detail/` — fetch single game details
  - `POST /` — batch import selected games as draft projects
- Frontend ImportPage at `/dashboard/import`:
  - Username search
  - Game selection with checkboxes (select all / individual)
  - Batch import with progress
  - Results with "Edit Draft" links
- Import link added to Dashboard header
- Added `beautifulsoup4` dependency

### Sub-Phase 8C: CRF Subsidy Logic ✅

- `CRFSubsidy` model tracking monthly subsidies per creator:
  - `estimated_hosting_cost`: Calculated from storage, projects, media posts
  - `creator_earnings`: Sum of pool distributions + marketplace sales
  - `subsidy_amount`: CRF pays the gap (up to $25/mo cap)
- Cost model:
  - Base: $0.50/creator
  - Storage: $0.05/GB
  - Per project: $0.10
  - Per media post (video/audio): $0.15
- Celery task `payments.calculate_crf_subsidies`:
  - Runs daily (idempotent per billing cycle)
  - Calculates hosting costs and earnings for each creator
  - Subsidizes creators below the threshold from CRF fund
  - Records negative CRF ledger entries for subsidy outflows
- API: `GET /api/v1/payments/crf/status/` — creator's subsidy history + CRF balance
- Frontend: CRF Hosting Subsidy section in Analytics Dashboard
- Admin: CRFSubsidy registered with list display and filters

---

## API Endpoints (New)

```
# Phase 8A
GET    /api/v1/content/projects/?sort=newest|popular|top_rated|trending|downloads
POST   /api/v1/content/projects/<slug>/assets/<pk>/download/

# Phase 8B
GET    /api/v1/integrations/import/itchio/preview/?username=X
POST   /api/v1/integrations/import/itchio/detail/
POST   /api/v1/integrations/import/itchio/

# Phase 8C
GET    /api/v1/payments/crf/status/
```
