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
```

The calculators are the first covered flow: they're pure client-side, so the
tests need no Postgres/API — just the static SPA. CI runs the suite on push/PR
via `.github/workflows/e2e.yml`.
