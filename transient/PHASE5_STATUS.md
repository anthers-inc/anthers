# Phase 5: ATProto Integration — STATUS

**Last updated:** 2026-02-25
**Branch:** `main`

---

## COMPLETED — Sub-Phase 5A

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

### Sub-Phase 5B: Lexicons — TODO
### Sub-Phase 5C: Write Paths — TODO
### Sub-Phase 5D: Source of Truth — TODO

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
