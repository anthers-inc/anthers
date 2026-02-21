# Frontend Scaffold Plan

Build out the Bluebell frontend — a creator platform where developers and artists publish games, videos, music, writing, and other digital work; build an audience; and earn transparently. Think itch.io's project hosting + Patreon's creator-audience relationship, with games as the first vertical.

The current backend has basic CRUD for Projects, Assets, and Posts. The frontend is a placeholder homepage. This plan covers what to build next, including backend additions the frontend needs.

---

## Progress

### Stage 1: Foundation — COMPLETE

- [x] **1.1 Auth endpoints** — `register/`, `login/`, `logout/` views using Django's built-in `authenticate()`/`login()`/`logout()`. CSRF/session settings for SPA (`CSRF_COOKIE_HTTPONLY=False`, `CORS_ALLOW_CREDENTIALS=True`, trusted origins).
- [x] **1.2 Extend Project model** — Added `pricing_type`, `price`, `min_price`, `suggested_price`, `cover_image`, `embed_url`, `short_description`, `website_url`, `source_url`. Migration applied.
- [x] **1.3 Screenshot model** — Separate `Screenshot` model with FK to Project (not JSONField). Fields: `image`, `caption`, `sort_order`. Inline admin editing. Migration applied.
- [x] **1.4 Extend User + Follow** — Added `header_image`, `website_url`, `location` to User. New `Follow` model with `unique_together`. Migration applied.
- [x] **1.5 Comment + Rating** — New `Comment` model (FK to project or post). New `Rating` model with `unique_together(user, project)` and 1-5 validation. Serializers and nested endpoints. Ratings support upsert.
- [x] **1.6 Query filters** — Projects: `?creator=`, `?media_type=`, `?tag=`, `?search=`, `?mine=true`. Posts: `?creator=`, `?project=`, `?mine=true`.
- [x] **1.7 Public profile + follow** — `GET /users/<username>/` with annotated follower/project counts + `is_following`. Follow/unfollow endpoints. Following list. Feed (posts from followed creators).
- [x] **1.8 Frontend `api.ts`** — Fetch wrapper with CSRF token from cookie, `credentials: "include"`, typed responses, `ApiError` class. Methods: `get`, `post`, `put`, `patch`, `delete`, `upload`.
- [x] **1.9 Frontend `auth.tsx`** — AuthProvider context wrapping the app. Restores session on mount via `GET /me/`. Exposes `user`, `isLoading`, `isAuthenticated`, `login()`, `register()`, `logout()`, `refreshUser()`.

### Stage 2: Core Pages — COMPLETE

- [x] **2.1 UI primitives** — `LoadingSpinner`, `EmptyState`, `FormField`, `Pagination`, `MediaTypeBadge`, `PricingBadge`, `StarRating`, `ProtectedRoute`.
- [x] **2.2 Cards** — `ProjectCard` (cover, title, creator, badges, rating), `PostCard` (avatar, title, excerpt, project link), `CreatorCard` (avatar, bio, counts, follow button).
- [x] **2.3 Layout update** — Auth-aware navbar with mobile menu. Logged out: Log in + Sign up buttons. Logged in: Feed link, avatar dropdown (Dashboard, Profile, Settings, Log out).
- [x] **2.4 Auth pages** — `LoginPage` (with redirect-back via location state), `RegisterPage` (with field-level error display).
- [x] **2.5 ExplorePage** — Search bar, media type tabs, responsive project grid, pagination.
- [x] **2.6 ProjectPage** — Full project detail: hero with cover/badges/rating, screenshots grid, description, downloads table (platform-grouped for games), devlog posts, interactive rating, comments with add form, sidebar with creator card/follow/tags/links/more projects.
- [x] **2.7 CreatorsPage + CreatorProfilePage** — Creator grid with follow buttons. Patreon-like profile with header banner, avatar, bio, website/location, follow button, tabbed content (Projects/Posts/About).
- [x] **2.8 PostFeedPage + PostPage** — Public post feed with pagination. Full post view with creator info, project link, comments.

### Stages 3-5: Not started

See Implementation Order below.

---

## Current State

**Backend API:**
- `GET/PATCH /api/v1/accounts/me/` — current user (auth required)
- `GET /api/v1/accounts/creators/` — list creators (public)
- `GET/POST /api/v1/content/projects/` — list/create projects
- `GET/PUT/PATCH/DELETE /api/v1/content/projects/<slug>/` — project CRUD
- `GET/POST /api/v1/content/posts/` — list/create posts
- `GET/PUT/PATCH/DELETE /api/v1/content/posts/<pk>/` — post CRUD
- No auth endpoints (register/login/logout)
- No filtering (by creator, by project, by media type)
- Session auth configured, CSRF not yet set up for SPA

**Backend models:**
- `User` — username, display_name, bio, is_creator, avatar
- `Project` — title, slug, description, media_type, tags, is_published
- `Asset` — file, filename, file_size, mime_type, platform, version, is_primary
- `Post` — title, body, project (nullable FK), is_published

**Frontend:** React 19, React Router 7, TailwindCSS 4, DaisyUI 5, Heroicons. One layout, one placeholder homepage. No API calls, no auth, no additional pages.

---

## Design Goals

From `first-foothold-itch-io-replacement.md` and the broader platform vision:

1. **Creator pages are the heart of the platform.** Each creator gets a profile page that is their home on Bluebell — all their projects, posts, and media in one place. This is their Patreon + itch.io page combined. Users follow *creators*, not individual projects.
2. **Projects span media types.** Games are the launch vertical, but the Project model already has `media_type` (game/video/audio/text). The UI must treat all types as first-class from day one — same cards, same browse page, same creator dashboard. A game dev who also writes devlogs and posts music should feel at home.
3. **Rich project pages.** Each project (game or otherwise) gets a full page: description, screenshots/media, downloads, web embed (for HTML5 games), devlog posts, comments, ratings.
4. **Posts are first-class content**, not just project addenda. Creators can publish standalone posts (updates, essays, announcements) alongside project-linked devlogs. Posts have their own feed. Think of them as the Patreon post stream.
5. **Zero friction for visitors.** Browse, download free content, play web games — no account required. Account is prompted after meaningful engagement.
6. **Transparent pricing.** Free / Pay What You Want / Fixed Price. Transparent fee receipt at checkout (creator gets 100%, user sees itemized infra + CRF + processing).
7. **Game jams.** Host jams with submission periods, themes, voting, results. Critical community feature and growth engine.
8. **Creator dashboard with analytics.** Views, downloads, purchases, earnings — data itch.io doesn't provide.
9. **Build management.** Multi-platform uploads, version labeling (stable/beta/prerelease).
10. **Community features.** Comments, ratings, devlog posts, follows.

---

## Backend Model Additions

The current models are too thin for a creator platform. These fields and models need to be added before the frontend can use them.

### Extend `Project`

```python
# Pricing
pricing_type = CharField(choices=["free", "pwyw", "paid"], default="free")
price = DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)      # fixed price
min_price = DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)   # PWYW minimum
suggested_price = DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)  # PWYW suggested

# Display
cover_image = ImageField(upload_to="covers/", blank=True)
# screenshots — implemented as separate Screenshot model (see below)
embed_url = URLField(blank=True)                     # web game embed URL (HTML5/WebGL)
short_description = CharField(max_length=300, blank=True)  # for cards/listings

# Metadata
website_url = URLField(blank=True)
source_url = URLField(blank=True)     # e.g. GitHub link
```

### Extend `User`

```python
# Creator profile (Patreon-like)
header_image = ImageField(upload_to="headers/", blank=True)  # banner image for creator page
website_url = URLField(blank=True)
location = CharField(max_length=100, blank=True)
```

### New model: `Follow`

```python
class Follow(Model):
    follower = FK(User, related_name="following")
    creator = FK(User, related_name="followers")
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("follower", "creator")
```

### New model: `Screenshot` (implemented instead of JSONField)

```python
class Screenshot(Model):
    project = FK(Project, related_name="screenshots")
    image = ImageField(upload_to="screenshots/")
    caption = CharField(max_length=255, blank=True)
    sort_order = PositiveIntegerField(default=0)
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["sort_order", "created_at"]
```

Decision: Separate model chosen over JSONField for proper file lifecycle management, per-screenshot metadata (captions, ordering), admin inline editing, and consistency with the existing Asset pattern.

### New model: `Comment`

```python
class Comment(Model):
    user = FK(User)
    project = FK(Project, null=True, blank=True)
    post = FK(Post, null=True, blank=True)
    body = TextField()
    created_at = DateTimeField(auto_now_add=True)
```

### New model: `Rating`

```python
class Rating(Model):
    user = FK(User)
    project = FK(Project)
    score = IntegerField(validators=[MinValue(1), MaxValue(5)])
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("user", "project")
```

### New model: `GameJam`

```python
class GameJam(Model):
    creator = FK(User)
    title = CharField(max_length=255)
    slug = SlugField(unique=True)
    description = TextField()
    theme = CharField(max_length=255, blank=True)        # revealed at start
    start_at = DateTimeField()
    end_at = DateTimeField()                              # submission deadline
    voting_end_at = DateTimeField(null=True, blank=True)  # voting closes
    is_published = BooleanField(default=False)
    created_at = DateTimeField(auto_now_add=True)
```

### New model: `JamEntry`

```python
class JamEntry(Model):
    jam = FK(GameJam, related_name="entries")
    project = FK(Project)
    submitted_at = DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("jam", "project")
```

### New model: `JamVote`

```python
class JamVote(Model):
    user = FK(User)
    entry = FK(JamEntry)
    score = IntegerField(validators=[MinValue(1), MaxValue(5)])

    class Meta:
        unique_together = ("user", "entry")
```

---

## Backend API Additions

### Auth

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/v1/accounts/register/` | POST | No | Create account (username, email, password) → auto-login |
| `/api/v1/accounts/login/` | POST | No | Session login → set cookie |
| `/api/v1/accounts/logout/` | POST | Yes | Clear session |

Use Django's built-in `authenticate()` + `login()` / `logout()`. Add CSRF settings for SPA:
```python
CSRF_COOKIE_HTTPONLY = False     # JS reads CSRF token from cookie
CSRF_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_TRUSTED_ORIGINS = ["http://localhost:3000", "http://localhost:8000"]
```

### Accounts

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/v1/accounts/users/<username>/` | GET | No | Public profile (display_name, bio, avatar, header_image, follower count, project count) |
| `/api/v1/accounts/users/<username>/follow/` | POST | Yes | Follow a creator |
| `/api/v1/accounts/users/<username>/unfollow/` | POST | Yes | Unfollow a creator |
| `/api/v1/accounts/me/following/` | GET | Yes | List creators the user follows |
| `/api/v1/accounts/me/feed/` | GET | Yes | Posts from followed creators (newest first) |

### Content — Filters on existing endpoints

| Endpoint | New query params | Purpose |
|----------|-----------------|---------|
| `GET /api/v1/content/projects/` | `?creator=<username>` | Profile page, dashboard |
| `GET /api/v1/content/projects/` | `?media_type=game` | Explore filtering |
| `GET /api/v1/content/projects/` | `?tag=<tag>` | Tag browsing |
| `GET /api/v1/content/projects/` | `?mine=true` | Dashboard (includes drafts, auth required) |
| `GET /api/v1/content/projects/` | `?search=<query>` | Search by title/description |
| `GET /api/v1/content/posts/` | `?project=<slug>` | Devlog on game page |
| `GET /api/v1/content/posts/` | `?creator=<username>` | Profile page |
| `GET /api/v1/content/posts/` | `?mine=true` | Dashboard (includes drafts) |

### Content — New endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `POST /api/v1/content/projects/<slug>/assets/` | POST | Yes (owner) | Upload a build file |
| `DELETE /api/v1/content/projects/<slug>/assets/<id>/` | DELETE | Yes (owner) | Remove a build |
| `GET /api/v1/content/projects/<slug>/comments/` | GET | No | List comments on a game |
| `POST /api/v1/content/projects/<slug>/comments/` | POST | Yes | Add comment |
| `GET /api/v1/content/projects/<slug>/ratings/` | GET | No | Get aggregate rating |
| `POST /api/v1/content/projects/<slug>/ratings/` | POST | Yes | Rate a game (1–5) |

### Game Jams

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `GET /api/v1/jams/` | GET | No | List published jams |
| `POST /api/v1/jams/` | POST | Yes | Create a jam |
| `GET /api/v1/jams/<slug>/` | GET | No | Jam detail + entries |
| `POST /api/v1/jams/<slug>/entries/` | POST | Yes | Submit a game to a jam |
| `POST /api/v1/jams/<slug>/entries/<id>/vote/` | POST | Yes | Vote on a jam entry |
| `GET /api/v1/jams/<slug>/results/` | GET | No | Jam results (ranked entries) |

---

## Frontend Architecture

### API Client (`src/lib/api.ts`)

Thin `fetch` wrapper:
- Base URL from env or default `http://localhost:8000`
- All requests: `credentials: "include"` (session cookie)
- Mutating requests: `X-CSRFToken` header read from `document.cookie`
- Typed responses, throws on non-2xx
- `api.get()`, `api.post()`, `api.put()`, `api.patch()`, `api.delete()`

### Auth Context (`src/lib/auth.tsx`)

React context wrapping the app:
- Calls `GET /me/` on mount to restore session
- Exposes `{ user, isLoading, isAuthenticated, login(), register(), logout() }`
- 401 from `/me/` = not logged in (not an error)

---

## Pages & Routes

### Public (no account required)

| Route | Page | What it does |
|-------|------|-------------|
| `/` | `HomePage` | Landing page — hero, featured projects, recent posts, active jams, value prop |
| `/explore` | `ExplorePage` | Browse all published projects. Filter by media type (Games/Video/Audio/Text/All), tags, sort (newest/popular/top-rated). Responsive grid of project cards. Pagination. |
| `/explore/:slug` | `ProjectPage` | **The core page.** Cover image, description, screenshots, web embed (HTML5 games), platform downloads, pricing, devlog posts, comments, ratings, creator card sidebar. Layout adapts to media type. |
| `/posts` | `PostFeedPage` | Public feed of all published posts, newest first. Filter by type: all / standalone / devlogs. This is the "what's happening on Bluebell" page — community activity visible to anyone. |
| `/posts/:id` | `PostPage` | Full post view with comments. Links back to project if it's a devlog. |
| `/creators` | `CreatorsPage` | Browse creators. Grid of creator cards showing avatar, name, bio, follower count, project count. |
| `/:username` | `CreatorProfilePage` | **The creator's home page.** Patreon-style layout: header image, avatar, bio, links, follower count, follow button. Tabbed content: Projects / Posts / About. This is where audiences come to see everything a creator does. |
| `/jams` | `JamsPage` | Browse game jams — upcoming, active, past. |
| `/jams/:slug` | `JamPage` | Jam detail — theme, rules, timeline, entries grid, results (if voting ended). |
| `/login` | `LoginPage` | Username + password form. Link to register. |
| `/register` | `RegisterPage` | Username, email, password, confirm. Link to login. |

### Protected (redirect to `/login` if not authenticated)

| Route | Page | What it does |
|-------|------|-------------|
| `/dashboard` | `DashboardPage` | Creator home — project count, post count, follower count, total views/downloads. Lists own projects + posts (including drafts). Quick-create buttons. |
| `/dashboard/projects/new` | `ProjectFormPage` | Create a project: title, slug, short description, full description, media type, cover image, screenshots, pricing type + amounts, tags, web embed URL. |
| `/dashboard/projects/:slug/edit` | `ProjectFormPage` | Edit existing project. Same form, pre-filled. |
| `/dashboard/projects/:slug/builds` | `BuildsPage` | Manage builds/assets for a project. Upload files, set platform/version labels. List existing assets with delete. |
| `/dashboard/posts/new` | `PostFormPage` | Write a post. Title, body (markdown), link to project (optional — standalone or devlog). Publish toggle. |
| `/dashboard/posts/:id/edit` | `PostFormPage` | Edit existing post. |
| `/dashboard/jams/new` | `JamFormPage` | Create a game jam. Title, description, theme (hidden until start), dates. |
| `/feed` | `FeedPage` | Personalized feed of posts from creators the user follows. The "home timeline" when logged in. |
| `/settings` | `SettingsPage` | Edit profile: display name, bio, avatar, header image, website, location. "Become a creator" toggle. |

---

## Component Breakdown

### Layout

**`Layout.tsx`** — update existing:
- Nav: Logo → `/`, "Explore" → `/explore`, "Creators" → `/creators`, "Jams" → `/jams`
- Logged out: "Log in" + "Sign up" buttons
- Logged in: "Feed" → `/feed`, user avatar dropdown → Dashboard, Settings, Log out
- Footer: tagline, links

**`ProtectedRoute.tsx`** — wraps protected routes, redirects to `/login`.

### Project Page Components

The project page (`ProjectPage`) is the most important page. Its layout adapts based on `media_type` — game projects show platform downloads and web embeds; other media types show relevant sections. It's composed of these sections:

| Component | Purpose |
|-----------|---------|
| `ProjectHero` | Cover image, title, short description, creator link, rating stars, media type badge |
| `ProjectScreenshots` | Lightbox gallery of screenshots/preview images (click to enlarge) |
| `ProjectEmbed` | Sandboxed `<iframe>` for HTML5/WebGL games. "Play in browser" button that expands the embed. Only rendered if `embed_url` is set. (Games only for now; video/audio embeds later.) |
| `ProjectDownloads` | List of downloadable files grouped by platform (Windows/Mac/Linux for games; ungrouped for other media). Shows filename, size, version label. Download button per asset. |
| `ProjectPricing` | For free: just the download/play buttons. For PWYW: amount input with suggested price, "Download" / "Buy" button. For paid: price display + "Buy" button. Always shows transparent fee breakdown on hover/expand. |
| `ProjectDevlog` | List of Post cards linked to this project, newest first. "View all" link if many. |
| `ProjectComments` | Comment list + "Add comment" form (if logged in). |
| `ProjectRating` | Star rating display (aggregate). Logged-in users can click to rate. |
| `ProjectSidebar` | Creator card (with follow button), tags, publish date, links (website, source), "More by this creator" |

### Cards

| Component | Used on | Shows |
|-----------|---------|-------|
| `ProjectCard` | ExplorePage, DashboardPage, CreatorProfilePage, JamPage | Cover image (or placeholder), title, creator name, short description, pricing badge (Free / $X / PWYW), media type badge, rating |
| `PostCard` | PostFeedPage, FeedPage, ProjectPage devlog, DashboardPage, CreatorProfilePage | Title, excerpt (first ~150 chars of body), date, linked project name (if devlog), creator avatar + name |
| `CreatorCard` | CreatorsPage, ProjectSidebar | Avatar, display name, bio excerpt, follower count, project count, follow button |
| `JamCard` | JamsPage, HomePage | Title, dates, entry count, status badge (Upcoming / Active / Voting / Ended) |
| `JamEntryCard` | JamPage entries grid | Project cover, title, creator, vote score (if voting open or ended) |

### UI Primitives

| Component | Purpose |
|-----------|---------|
| `MediaTypeBadge` | Colored badge: Game (purple), Video (red), Audio (green), Text (blue) |
| `PricingBadge` | Free (green), PWYW (yellow), $X.XX (neutral) |
| `JamStatusBadge` | Upcoming (info), Active (success), Voting (warning), Ended (neutral) |
| `StarRating` | 1–5 star display. Interactive (clickable) when rating; static when display-only. |
| `EmptyState` | Icon + message + optional CTA button for empty lists |
| `LoadingSpinner` | DaisyUI `loading loading-spinner` |
| `FormField` | Label + input/textarea/select + error message |
| `FileUpload` | Drag-and-drop or click file input with progress indicator |
| `TransparentReceipt` | Itemized fee breakdown: game price, infra fee, CRF (3%), processing fee, total. Used in purchase flow. |
| `Pagination` | Previous/Next + page info. Wired to DRF's `count`/`next`/`previous`. |

---

## Key Page Details

### `HomePage`

Not just a hero — this is the platform landing. Sections:

1. **Hero:** "Bluebell" tagline, "A home for creators. Share games, videos, music, writing — keep 100% of your earnings." Two CTAs: "Explore" → `/explore`, "Start Creating" → `/register` or `/dashboard`.
2. **Featured Projects:** Most recent published projects across media types. Grid of `ProjectCard`s. Media type badges make it clear this isn't just games.
3. **Active Jams:** If any jams are currently accepting submissions or in voting, show them. `JamCard` list.
4. **Value Prop Section:** Three columns: "100% to Creators" (transparent fees), "One Home for Everything" (games, video, audio, writing — one audience, one identity), "Community" (jams, follows, devlogs). Keep it brief.
5. **Recent Posts:** Latest published posts across all creators — devlogs, announcements, essays. Shows the community is active and diverse.
6. **Featured Creators:** A few creator cards to show the people behind the projects.

### `CreatorProfilePage` (Patreon-like)

This is the creator's home — the page their audience bookmarks. Layout:
```
┌──────────────────────────────────────────────┐
│  Header Image (full-width banner)            │
│  ┌────────┐                                  │
│  │ Avatar │  Display Name                    │
│  └────────┘  @username · 142 followers       │
│              Bio text here...                │
│              🔗 website.com · 📍 Portland     │
│              [Follow]                        │
├──────────────────────────────────────────────┤
│  [Projects]  [Posts]  [About]    (tabs)      │
├──────────────────────────────────────────────┤
│  Projects tab:                               │
│    Grid of ProjectCards (all media types)     │
│    Media type filter pills                   │
│                                              │
│  Posts tab:                                  │
│    Chronological post feed (devlogs +        │
│    standalone). Like a Patreon activity feed. │
│                                              │
│  About tab:                                  │
│    Extended bio, links, supporter info        │
└──────────────────────────────────────────────┘
```

The creator profile is deliberately media-agnostic. A game dev who also writes essays and publishes soundtracks has all of that on one page under one identity. Followers see everything.

### `ProjectPage` (the critical page)

Layout adapts by media type, but the structure is consistent:
```
┌────────────────────────────────────────────────────┐
│  Cover Image / Hero                                │
│  Title                     Creator Card (sidebar)  │
│  Short Description           [Follow] button       │
│  ★★★★☆ (4.2) · 128 ratings  Tags                  │
│  [Play in Browser]  [Download]   More by creator   │
├────────────────────────────────────────────────────┤
│  Screenshots / Preview Images (gallery)            │
├────────────────────────────────────────────────────┤
│  [Web Game Embed — if HTML5 game]                  │
├────────────────────────────────────────────────────┤
│  Full Description (markdown)                       │
├────────────────────────────────────────────────────┤
│  Downloads / Files                                 │
│  ┌─────────────┬──────────┬─────────┬───────────┐  │
│  │ Platform    │ Filename │ Size    │ Action    │  │
│  │ Windows     │ game.zip │ 245 MB  │ Download  │  │
│  │ Mac         │ game.dmg │ 260 MB  │ Download  │  │
│  │ Linux       │ game.tar │ 240 MB  │ Download  │  │
│  └─────────────┴──────────┴─────────┴───────────┘  │
│  (For paid: pricing + transparent receipt here)     │
├────────────────────────────────────────────────────┤
│  Devlog / Updates                                  │
│  - PostCard                                        │
│  - PostCard                                        │
├────────────────────────────────────────────────────┤
│  Comments                                          │
│  - Comment                                         │
│  - Comment                                         │
│  [Add comment form]                                │
└────────────────────────────────────────────────────┘
```

**Media type adaptations:**
- **Games:** Platform-grouped downloads, web embed, "Play in browser" CTA
- **Video/Audio:** Embed player (future), single download, no platform grouping
- **Text:** No downloads section; the description *is* the content (or link to external)

For **paid projects**, the download section is gated behind purchase. Show price, transparent fee receipt preview, and a "Buy" button. Free downloads are direct links, no account required.

For **PWYW projects**, show an amount input (pre-filled with suggested price, minimum enforced), then download.

### `PostFeedPage` and `PostPage`

Posts get their own browse page — this is where community activity is visible:
- `PostFeedPage` (`/posts`): chronological feed of all published posts. Filter: All / Devlogs (project-linked) / Standalone. Each card shows creator avatar, name, title, excerpt, date, linked project.
- `PostPage` (`/posts/:id`): full post with markdown body, creator info, project link (if devlog), comments.

This is important for the Patreon-like feel: creators publish updates, audiences follow along.

### `FeedPage` (logged in)

Personalized feed — posts from creators the user follows. Same layout as `PostFeedPage` but filtered to followed creators. This is the "home timeline" experience. If the user follows nobody yet, show suggestions + link to `/creators`.

### `ExplorePage`

- Top: search bar + filter controls
- Filters: media type tabs (All / Games / Video / Audio / Text), tag pills, sort dropdown (Newest / Popular / Top Rated)
- Results: responsive grid of `ProjectCard`s
- Bottom: pagination

### `DashboardPage`

- Summary stats: total projects, total posts, followers, total downloads (needs backend analytics endpoint eventually — show placeholder for now)
- "My Projects" section: list/grid of own projects with status badges (Draft/Published), media type badge. Each has Edit and Manage Builds links. "New Project" button.
- "My Posts" section: list of own posts with status. "New Post" button.
- "My Jams" section: jams the user created. "New Jam" button.

### `ProjectFormPage`

Two-column layout:
- Left: form fields (title, slug auto-gen, short description, full description as textarea, media type select, tags input, pricing type radio + conditional price fields, web embed URL, website URL, source URL)
- Right: cover image upload + screenshot uploads
- Bottom: Publish toggle + Save button
- If editing, "Manage Builds" link to the builds page

### `BuildsPage`

For a specific project. Two sections:
- **Upload:** `FileUpload` component + platform select (Windows/Mac/Linux/Web/Other) + version input + stable/beta/prerelease radio
- **Existing Builds:** Table of current assets with platform, filename, size, version, label, upload date, delete button

### `JamPage`

- Header: title, dates, status badge, created by
- Before start: description, rules. Theme hidden ("Theme will be revealed when the jam starts").
- During submissions: theme revealed, "Submit a Game" button (select from user's games or create new), entries grid
- During voting: entries grid with vote interface (star rating per entry)
- After voting: results ranked by average score

---

## File Tree (new/changed files)

```
frontend/src/
├── lib/
│   ├── api.ts                              # Fetch wrapper
│   └── auth.tsx                            # AuthProvider context
├── components/
│   ├── layout/
│   │   └── Layout.tsx                      # Updated: auth-aware nav, follow-centric
│   ├── project/
│   │   ├── ProjectHero.tsx
│   │   ├── ProjectScreenshots.tsx
│   │   ├── ProjectEmbed.tsx
│   │   ├── ProjectDownloads.tsx
│   │   ├── ProjectPricing.tsx
│   │   ├── ProjectDevlog.tsx
│   │   ├── ProjectComments.tsx
│   │   ├── ProjectRating.tsx
│   │   └── ProjectSidebar.tsx
│   ├── cards/
│   │   ├── ProjectCard.tsx
│   │   ├── PostCard.tsx
│   │   ├── CreatorCard.tsx
│   │   ├── JamCard.tsx
│   │   └── JamEntryCard.tsx
│   └── ui/
│       ├── MediaTypeBadge.tsx
│       ├── PricingBadge.tsx
│       ├── JamStatusBadge.tsx
│       ├── StarRating.tsx
│       ├── EmptyState.tsx
│       ├── LoadingSpinner.tsx
│       ├── FormField.tsx
│       ├── FileUpload.tsx
│       ├── TransparentReceipt.tsx
│       ├── Pagination.tsx
│       └── ProtectedRoute.tsx
├── pages/
│   ├── HomePage.tsx                        # Updated: platform landing
│   ├── ExplorePage.tsx                     # Browse/search/filter all projects
│   ├── ProjectPage.tsx                     # Project detail (the core page)
│   ├── PostFeedPage.tsx                    # Public post feed (all creators)
│   ├── PostPage.tsx                        # Full post view
│   ├── CreatorsPage.tsx                    # Browse creators
│   ├── CreatorProfilePage.tsx              # Creator's home (Patreon-like)
│   ├── JamsPage.tsx                        # Browse jams
│   ├── JamPage.tsx                         # Jam detail + entries + voting
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   ├── FeedPage.tsx                        # Personalized feed (followed creators)
│   ├── DashboardPage.tsx                   # Creator dashboard
│   ├── ProjectFormPage.tsx                 # Create/edit project
│   ├── BuildsPage.tsx                      # Manage project builds/assets
│   ├── PostFormPage.tsx                    # Create/edit post
│   ├── JamFormPage.tsx                     # Create jam
│   └── SettingsPage.tsx                    # Profile settings
└── App.tsx                                 # Updated: all routes

backend/
├── accounts/
│   ├── models.py         # Add: header_image, website_url, location to User; Follow model
│   ├── views.py          # Add: register, login, logout, public profile, follow/unfollow, feed
│   ├── serializers.py    # Add: registration, login, public profile, follow serializers
│   └── urls.py           # Add: new endpoints
├── content/
│   ├── models.py         # Add: pricing fields, cover_image, screenshots, embed_url, short_description, Comment, Rating
│   ├── views.py          # Add: query filters, comment/rating endpoints, asset upload
│   ├── serializers.py    # Add: comment, rating serializers
│   └── urls.py           # Add: nested endpoints
├── jams/                 # New app
│   ├── models.py         # GameJam, JamEntry, JamVote
│   ├── views.py
│   ├── serializers.py
│   ├── urls.py
│   └── admin.py
└── _django/
    ├── settings.py       # CSRF/session settings, add jams to INSTALLED_APPS
    └── urls.py           # Add jams URL include
```

---

## Implementation Order

### Stage 1: Foundation (backend + frontend plumbing)

1. **Backend: auth endpoints** — register, login, logout views + CSRF/session settings
2. **Backend: extend Project model** — pricing fields, cover_image, screenshots, embed_url, short_description. Migration.
3. **Backend: extend User model + Follow** — header_image, website_url, location; Follow model. Migration.
4. **Backend: Comment + Rating models** — new models, serializers, nested endpoints under projects
5. **Backend: query filters** — `?creator=`, `?media_type=`, `?tag=`, `?search=`, `?mine=`, `?project=` on list views
6. **Backend: public user profile + follow/unfollow** — `GET /api/v1/accounts/users/<username>/`, follow endpoints, feed endpoint
7. **Frontend: `api.ts`** — fetch wrapper with CSRF
8. **Frontend: `auth.tsx`** — auth context + provider

### Stage 2: Core pages (the creator platform)

9. **UI primitives** — LoadingSpinner, EmptyState, FormField, Pagination, MediaTypeBadge, PricingBadge, StarRating
10. **Cards** — ProjectCard, PostCard, CreatorCard
11. **Layout update** — auth-aware navbar: Explore, Creators, Jams, Feed (logged in), user dropdown
12. **Auth pages** — LoginPage, RegisterPage
13. **ExplorePage** — project grid with media type filters and search
14. **ProjectPage** — the big one: hero, screenshots, downloads, description, devlog, comments, ratings, sidebar with follow
15. **CreatorsPage + CreatorProfilePage** — browse creators; Patreon-like profile with Projects/Posts/About tabs
16. **PostFeedPage + PostPage** — public post feed + full post view with comments

### Stage 3: Creator tools + audience building

17. **ProtectedRoute** — auth guard wrapper
18. **FeedPage** — personalized feed from followed creators (the "home timeline")
19. **DashboardPage** — creator's project/post list with drafts, follower count
20. **ProjectFormPage** — create/edit project with all fields (media type, pricing, cover, screenshots)
21. **BuildsPage** — upload and manage project assets/builds
22. **PostFormPage** — create/edit posts (standalone or project-linked devlogs)
23. **SettingsPage** — profile editing: display name, bio, avatar, header image, website, location, become-a-creator toggle
24. **HomePage update** — featured projects (mixed media types), recent posts, active jams, value prop, featured creators

### Stage 4: Game jams

25. **Backend: jams app** — GameJam, JamEntry, JamVote models + full API
26. **JamCard + JamEntryCard + JamStatusBadge** — jam-specific components
27. **JamsPage** — browse upcoming/active/past jams
28. **JamPage** — jam detail with entries, submission, voting, results
29. **JamFormPage** — create a jam

### Stage 5: Rich media + polish

30. **ProjectEmbed** — sandboxed iframe for HTML5/WebGL games (video/audio embeds later)
31. **ProjectScreenshots** — lightbox gallery
32. **ProjectPricing + TransparentReceipt** — purchase flow with itemized fees
33. **FileUpload** — drag-and-drop with progress

---

## Notes

- **No payment processing yet.** The pricing UI and transparent receipt are display-only in this scaffold. Stripe Connect integration is a separate effort. Paid downloads will initially show "Coming soon" or work on the honor system.
- **No ATProto yet.** Identity is standard Django sessions. ATProto DID integration and "Sign in with Bluesky" come later.
- **No subscription/pool model yet.** Per the design doc, subscriptions launch at ~500 projects / 6–12 months. The scaffold is marketplace-only. The Creator Pool and Boost Pool are future features that build on the follow/audience infrastructure being laid here.
- **Games first, everything second.** The UI is multi-media-ready from day one (media type badges, type-adaptive project pages), but the first real content will be games. Video/audio embed players and text-specific layouts are Stage 5+ work. The important thing is that the data model and routing don't assume games-only.
- **Markdown rendering.** Project descriptions and posts will need markdown support. Add a lightweight renderer (e.g. `marked` or `react-markdown`) when building ProjectPage.
- **Image uploads.** Cover images and screenshots need the FileUpload component and backend handling. The Asset model already handles files; screenshots on Project can use JSONField initially (list of URLs) with a proper gallery model later.
- **Creator profiles are the audience relationship layer.** The `/:username` route with follow + tabbed content is what makes Bluebell more than a storefront. It's where the Patreon-like "subscribe to a creator, see everything they do" experience lives. Getting this right is as important as getting the project page right.
