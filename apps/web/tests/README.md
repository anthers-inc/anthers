# Browser testing

Playwright-based browser tooling for the web app, in three layers. All of it
drives Playwright's own bundled Chromium — it does **not** use any browser you
have installed. This environment runs Bun (no Node), so the Playwright CLI is
invoked with `bunx`.

## One-time setup

```
make e2e-install        # downloads the Chromium build Playwright drives
```

## The SiteGate wall (important)

The whole app is wrapped in `SiteGate` (`apps/web/src/components/ui/SiteGate.tsx`),
the pre-launch "Team access" wall. It's authorized purely by a client-side
`localStorage` flag: `anthers_site_access = "true"`. Any browser automation must
seed that flag before the app's JS runs, or every route renders the gate instead
of the real page. Both the screenshot helper and the e2e fixture do this for
you; if the storage key ever changes, update it in:

- `apps/web/scripts/screenshot.ts`
- `apps/web/tests/e2e/fixtures.ts`

## Tier 0 — screenshots / smoke (`scripts/screenshot.ts`)

Fast visual check: builds, serves the preview, seeds the gate, screenshots each
route, and flags real page/console errors (ignoring the expected no-backend API
failures). PNGs land in `apps/web/.screenshots/` (gitignored).

```
make screenshots                          # default: the resource routes
make screenshots ROUTES="/ /for-users"    # any routes you like
```

Exit code is non-zero if any route had a real error, so it doubles as a smoke
test.

## Tier 1 — Playwright MCP (interactive)

`.mcp.json` (repo root) registers the official Playwright MCP server, giving the
agent browser tools (navigate, click, snapshot, screenshot) without writing a
script. It starts headless; drop `--headless` in `.mcp.json` to watch it. Claude
Code picks up `.mcp.json` on session start.

To get past the gate in an MCP session, run once after navigating to the app
origin, then reload:

```
localStorage.setItem("anthers_site_access", "true")
```

## Tier 2 — e2e suite (`tests/e2e/*.e2e.ts`)

Durable regression tests run by the Playwright runner. The config's `webServer`
auto-builds and serves the app, and the shared fixture seeds the gate. Specs are
named `*.e2e.ts` so `bun test` (which claims `*.test`/`*.spec`) never runs them —
only Playwright does.

```
make test-e2e           # headless, builds + serves automatically
make test-e2e-ui        # Playwright UI mode
make test-gauntlet      # just the User Gauntlet walk (fixture reset + staircase)
```

Two kinds of spec live here, split into Playwright projects:

- **`chromium`** — the static suite (calculators): pure client-side, no API/DB.
  Its error tracker deliberately filters `/api/` noise, because there's no
  backend behind the static preview by design.
- **`gauntlet`** — the User Gauntlet walk (`user-gauntlet.e2e.ts`): authenticated,
  serial, and stateful. Its `setup` dependency resets the fixture through
  `db:gauntlet --ensure-viewer` and signs `gauntlet_viewer` in for real,
  persisting the session as `tests/e2e/.auth/` storageState. It asserts every
  cell of the expected-access staircase from `@anthers/db/gauntlet` after every
  transition, with **strict** error tracking (`trackErrorsStrict` — no `/api/`
  filter). Spec: the vault's `70-79 Testing & QA/70 - User Gauntlet.md`.

**The suite now needs the real API + Postgres.** The config's second `webServer`
entry reuses a running `make dev` API on :8000, or brings the dev database up
itself (`make db-ready`, docker) and starts one. Pages served from localhost
resolve their API base to `localhost:8000` (see `web-shared`'s `rpc.ts`), so
there's no proxy — `origins.ts` allowlists the preview origin (:4173) outside
production. In CI, Postgres is a service container (`.github/workflows/ci.yml` —
there is no `e2e.yml`; it was folded into the single workflow long ago).

🚨 **CI runs this suite as TWO jobs, split by system dependency**, and the split
lives in `playwright.config.ts` as `metadata.needsMedia` on each project — not in
the workflow. `browser` runs the hermetic projects on a bare runner; the ones that
need ffmpeg or poppler run in `ghcr.io/anthers-inc/anthers-ci` (built by
`ci-image.yml`), because installing those with `apt` on every run cost 30 seconds
on a good day and blew the job timeout twice in two days on a stalled Ubuntu
mirror. `scripts/e2e-projects.ts` derives both jobs' `--project` arguments from
that flag and **fails on a project that declares none** — Playwright 1.61 has no
`--project` negation, so an undeclared project would otherwise run in neither job
while both stayed green. Nothing changes locally: `make verify` and a bare
`playwright test` still run every project.

**Billing is hybrid in the walk.** The support model made badge and support
billing real Stripe flows (503 unconfigured, webhook-synced when configured), so the
spec UI-walks everything that doesn't bill and hops billing state through the
canonical `db:gauntlet:state` script. The observational pass covers the real
billing UI; a `GAUNTLET_STRIPE` full-fidelity mode is a known follow-up.

**Playwright-under-Bun gotcha:** any `request`/`page.request` call whose
response carries a `Set-Cookie` header crashes in Playwright's cookie parser
(it receives a path where Node hands it a full URL). The gauntlet setup signs
in via plain `fetch` and writes the storageState by hand for exactly this
reason — don't "simplify" it back to `request.post`.
