# Phase 7: Game Jams — STATUS

**Last updated:** 2026-02-25
**Branch:** `main`

---

## COMPLETED — Both Sub-Phases

### Sub-Phase 7A: Backend ✅

- New `jams` Django app with 3 models:
  - `GameJam` — title, slug, description, theme, cover image, schedule (start_at, end_at, voting_end_at), settings (max_team_size, allow_late_submissions)
  - `JamEntry` — links project to jam, unique per (jam, project)
  - `JamVote` — 1-5 score, unique per (entry, user), no self-voting
- Status computed from dates: upcoming → active → voting → ended
- Theme hidden until jam starts
- API endpoints:
  - `GET/POST /api/v1/jams/` — list/create (with `?status=` filter)
  - `GET/PUT/DELETE /api/v1/jams/<slug>/` — detail, update, delete (owner only)
  - `GET/POST /api/v1/jams/<slug>/entries/` — list/submit entries
  - `POST /api/v1/jams/<slug>/entries/<pk>/vote/` — vote on entry
  - `GET /api/v1/jams/<slug>/results/` — ranked results (only after voting ends)
- Submission validation: jam must be active, project must be published and owned
- Voting validation: only during voting phase, can't vote on own entry
- Results ranked by average score, tiebroken by vote count
- Django admin with all 3 models

### Sub-Phase 7B: Frontend ✅

- `JamsPage` at `/jams` — status-tabbed jam listing with cards showing dates, entry counts
- `JamPage` at `/jams/:slug` — state-dependent UI:
  - Theme reveal (hidden before start)
  - Submit entry form (during active phase) with project selector
  - Star voting on entries (during voting phase)
  - Ranked results with trophy icons (after voting ends)
- `JamFormPage` at `/dashboard/jams/new` and `/dashboard/jams/:slug/edit` — create/edit form with datetime scheduling, cover image upload, theme input
- "Jams" link added to navbar (both mobile and desktop menus)
- TypeScript types: GameJam, GameJamListItem, JamEntry, JamEntryResult, JamResultsResponse

---

## API Endpoints

```
GET    /api/v1/jams/?status=upcoming|active|voting|ended
POST   /api/v1/jams/
GET    /api/v1/jams/<slug>/
PUT    /api/v1/jams/<slug>/
DELETE /api/v1/jams/<slug>/
GET    /api/v1/jams/<slug>/entries/
POST   /api/v1/jams/<slug>/entries/
POST   /api/v1/jams/<slug>/entries/<pk>/vote/
GET    /api/v1/jams/<slug>/results/
```
