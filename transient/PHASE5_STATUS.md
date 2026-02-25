# Phase 5: ATProto Integration — STATUS

**Last updated:** 2026-02-25
**Branch:** `main`

---

## COMPLETED — All 4 Sub-Phases

### Sub-Phase 5A: Identity + OAuth ✅

- Added `atproto_did`, `atproto_handle`, `atproto_pds_url` fields to User model
- Full ATProto OAuth 2.0 implementation with PKCE + DPoP + PAR
- Custom Django auth backend (`ATProtoBackend`) for DID-based authentication
- Handle resolution via public Bluesky API + .well-known fallback
- DID document resolution (did:plc via plc.directory, did:web via .well-known)
- PDS and Authorization Server discovery chain
- DPoP nonce retry handling (both PAR and token exchange)
- Loopback client_id format for development (`http://localhost?redirect_uri=...`)
- Production support via `ATPROTO_CLIENT_ID` / `ATPROTO_REDIRECT_URI` env vars
- Frontend "Sign in with Bluesky" on login page with butterfly logo
- Frontend ATProto callback page with error handling
- Settings page Bluesky section: link/unlink with DID display
- Auto-creates local user on first Bluesky sign-in (username derived from handle)
- Safety: can't unlink Bluesky if it's the only login method (no password set)
- `atproto_did` and `atproto_handle` exposed as read-only fields on User serializers

### Sub-Phase 5B: Lexicons ✅

- 5 ATProto lexicon schemas in `backend/lexicons/`
- `com.bluebell.game` — Game/project record (maps to Project model)
- `com.bluebell.post` — Content post record (maps to Post model)
- `com.bluebell.rating` — User rating (maps to Rating model)
- `com.bluebell.follow` — Follow relationship (maps to Follow model)
- `com.bluebell.boost` — Boost allocation (maps to BoostAllocation model)
- All use Lexicon v1 format with `type: record`, `key: tid`
- Blob types for media (cover images, video, audio, thumbnails)
- Cross-references via `ref` (e.g. rating → game, post → game)
- DID references for social records (follow subject, boost subject)

### Sub-Phase 5C: Write Paths ✅

- `atproto_uri` field added to: Project, Post, Comment, Rating, Follow, BoostAllocation
- `ATProtoSession` model stores OAuth tokens + DPoP key for PDS write access
- Sessions auto-saved during OAuth callback (both login and link flows)
- `atproto_sync.py` module with record write functions:
  - `sync_project_to_atproto()` — creates/updates `com.bluebell.game` records
  - `sync_post_to_atproto()` — creates/updates `com.bluebell.post` records
  - `sync_rating_to_atproto()` — creates/updates `com.bluebell.rating` records
  - `sync_follow_to_atproto()` — creates `com.bluebell.follow` records
  - `sync_boost_to_atproto()` — creates/updates `com.bluebell.boost` records
  - `delete_record_from_atproto()` — deletes records by URI
- Best-effort sync: failures logged but never block the main request
- Integrated into content views: ProjectListCreateView, PostListCreateView, ProjectRatingView
- Integrated into accounts views: FollowView
- Token refresh with DPoP nonce retry built into PDS request handler
- TID (timestamp-based ID) generation for ATProto record keys

### Sub-Phase 5D: Source of Truth ✅

- `atproto_index.py` module — reads ATProto records and rebuilds Django models
- `list_records()` — paginated record listing from user's PDS (public API)
- `get_record()` — fetch single record by collection + rkey
- Index rebuilders for each content type:
  - `index_games_for_user()` — reconstructs Project models from `com.bluebell.game`
  - `index_posts_for_user()` — reconstructs Post models from `com.bluebell.post`
  - `index_follows_for_user()` — reconstructs Follow models from `com.bluebell.follow`
  - `index_all_for_user()` — full rebuild for a single user
- Management command: `python manage.py atproto_reindex --user <username>` or `--all`
- Slug uniqueness handling (appends rkey fragment on collision)
- Cross-references preserved (post → game via atproto_uri)

---

## API Endpoints (Phase 5A)

```
# ATProto OAuth
GET  /api/v1/accounts/atproto/client-metadata.json  — OAuth client metadata
POST /api/v1/accounts/atproto/auth/                  — Initiate OAuth flow
GET  /api/v1/accounts/atproto/callback/              — OAuth callback (redirects to frontend)
POST /api/v1/accounts/atproto/unlink/                — Unlink Bluesky from account
```

---

## Architecture Notes

### OAuth Flow
1. Frontend POSTs handle to `/atproto/auth/`
2. Backend resolves handle → DID → PDS → Authorization Server
3. Backend generates PKCE + DPoP key, pushes PAR request
4. Backend stores OAuth state in Django session
5. Frontend redirects user to Bluesky authorization URL
6. User approves on Bluesky
7. Bluesky redirects to backend callback with auth code
8. Backend exchanges code for tokens (with DPoP proof + nonce retry)
9. Backend creates/updates local user via `ATProtoBackend`
10. Backend redirects to frontend callback page
11. Frontend calls `refreshUser()` and navigates home

### Development vs Production
- **Development**: `client_id = http://localhost?redirect_uri=...&scope=atproto`
  - Loopback client format per ATProto spec
  - redirect_uri uses `http://127.0.0.1:{port}` per RFC 8252
- **Production**: Set `ATPROTO_CLIENT_ID` to public URL serving client metadata
  - `/api/v1/accounts/atproto/client-metadata.json` serves the metadata
  - Set `ATPROTO_REDIRECT_URI` to the production callback URL

### Auth Backend Chain
```python
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",     # username/password
    "accounts.atproto_backend.ATProtoBackend",       # ATProto DID
]
```
