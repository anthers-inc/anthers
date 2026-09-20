# ─── Anthers Makefile ───

.PHONY: help install dev dev-api dev-worker dev-web down \
        db-generate db-migrate db-push db-studio db-seed sessions-clean \
        gauntlet-reset gauntlet-clean stripe-webhooks \
        verify verify-docs typecheck test lint lint-fix format \
        e2e-install e2e-preflight screenshots test-e2e test-e2e-ui test-gauntlet \
        spec-diff spec-apply deploy-status webhook-check stripe-walk dev-local \
        worktree worktrees worktree-remove \

# ─── OS detection ───
# Only the desktop-packaging targets care: installers cannot be cross-compiled, so
# each per-platform target must be able to refuse politely when run on the wrong OS.
# Windows has no `uname`, so check its env var first.
ifdef OS
    ifeq ($(OS),Windows_NT)
        UNAME_S := Windows
    else
        UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
    endif
else
    UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
endif
ifneq (,$(findstring MINGW,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring MSYS,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring CYGWIN,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring Windows,$(UNAME_S)))
    DETECTED_OS := windows
else ifeq ($(UNAME_S),Linux)
    DETECTED_OS := linux
else ifeq ($(UNAME_S),Darwin)
    DETECTED_OS := macos
else
    DETECTED_OS := linux
endif

# BSD sed (macOS) needs an explicit empty suffix for -i; GNU sed must not have one.
ifeq ($(DETECTED_OS),macos)
    SED_INPLACE := sed -i ''
else
    SED_INPLACE := sed -i
endif

API_PORT ?= 8000

# ─── Playwright browsers ───
# 🚨 **Browsers live with Anthers, not the machine-wide cache** — locally, and shared by every
# worktree. Playwright keys them by BUILD number and prunes builds its own version does not
# reference, so installing browsers for another project deletes the one pinned here. That
# happened on 2026-09-04 and presented as 162 tests failing in two milliseconds each.
#
# The shared `~/.cache/ms-playwright-anthers` keeps that property — another project's install
# still cannot reach it — while every worktree of this repository shares one copy instead of
# downloading its own into node_modules, which `make worktree` would otherwise cost ~646 MB a
# piece. The path names Anthers so a stale pruning script from elsewhere has no reason to look.
#
# ⚠️ **Not in CI, deliberately.** A runner is ephemeral and has no other project to collide
# with, and `ci.yml` caches `~/.cache/ms-playwright` keyed on the lockfile — pointing that cache
# at a second directory would defeat it for no benefit.
ifndef CI
export PLAYWRIGHT_BROWSERS_PATH := $(HOME)/.cache/ms-playwright-anthers
endif

WEB_PORT ?= 3000
STUDIO_PORT ?= 3001

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Application ───

install: ## Install all dependencies
	bun install
	@$(MAKE) --no-print-directory hooks

# Git only runs hooks it finds in .git/hooks, which isn't tracked — so a hook
# committed to the repo does nothing until each clone is pointed at it. This is
# that step, folded into `make install` so a fresh clone is covered without
# anyone remembering. Undo with: git config --unset core.hooksPath
hooks: ## Point git at the repo's tracked hooks (.githooks/)
	@git config core.hooksPath .githooks
	@echo "git hooks → .githooks (pre-push runs 'make verify', or 'make verify-docs' when only markdown changed; bypass with git push --no-verify)"

# Secrets come from the "Anthers Dev" Bitwarden project, not from `.env`. `bws run` sets
# REAL environment variables, and those beat Bun's `.env` loading, so a stale line left in
# `.env` cannot shadow the vault.
#
# The fallback is warned rather than silent, and it is safe to have here for a reason worth
# stating: getting it wrong costs you a dev server with a sealed site gate, which is loud
# and local. That is the opposite of `spec-apply`, where a wrong source reaches production —
# which is why that one refuses instead of falling back.
dev: ## Start dev with secrets from the "Anthers Dev" Bitwarden project
	@if command -v bws >/dev/null 2>&1 && [ -s "$$HOME/.config/bws/anthers-dev-token" ]; then \
		PID=$$(bun run scripts/bws-project-id.ts dev) || exit 1; \
		BWS_ACCESS_TOKEN=$${BWS_ACCESS_TOKEN:-$$(cat $$HOME/.config/bws/anthers-dev-token)} \
			bws run --project-id $$PID -- '$(MAKE) dev-local'; \
	else \
		echo "  -> bws unavailable; secrets must come from .env, which no longer holds them"; \
		echo "     by default. Expect a sealed site gate unless you filled these in yourself:"; \
		echo "       SITE_PASSWORD  SITE_ACCESS_KEYS  STRIPE_SECRET_KEY"; \
		echo "       STRIPE_WEBHOOK_SECRET  RESEND_API_KEY   (use DEV values, never prod's)"; \
		$(MAKE) dev-local; \
	fi

# 🚨 **Every `make dev` starts from nothing and leaves nothing.** `scripts/session.ts` brings up a
# fresh database and a private AT Protocol network, migrates, seeds it (`bun run db:seed`: your dev
# account, the User Gauntlet's creator and viewer, and the media fixture's catalog with its records
# on the network, each a real identity), runs the servers, and removes all of it when they stop —
# including after a crash, which the next session cleans up. Every email the servers send lands in
# the session's mail catcher at http://localhost:8025 rather than in a real inbox. Anything set up by hand during a session is gone when it ends; a file-change restart
# under `bun --watch` is not an end.
# 🚨 Refuse a second dev session BEFORE touching anything. Two parallel sessions landed this:
# `dev-local` used to kill whatever held ports 8000/3000/3001 and only *then* run `session.ts
# dev`, which refuses a second dev — so a second `make dev` took the first's servers down and
# started nothing, the worst of both outcomes. The pid-file probe below runs first, so a live dev
# session makes the command fail loudly and harm nothing. The kill loop stays, but only for ports
# orphaned by an interrupted run — where no live pid file exists to refuse on.
dev-local: ## Start dev reading secrets from .env (offline, or no vault access)
	@for PIDFILE in .dev.pid .dev-api.pid; do \
		DEV_PID=$$(cat $$PIDFILE 2>/dev/null); \
		if [ -n "$$DEV_PID" ] && kill -0 $$DEV_PID 2>/dev/null; then \
			echo "  -> A dev session is already running (pid $$DEV_PID, $$PIDFILE)."; \
			echo "     Refusing to start a second and take its ports. 'make down' stops it first."; \
			exit 1; \
		fi; \
	done
	@KILLED=0; \
	for PORT in $(API_PORT) $(WEB_PORT) $(STUDIO_PORT); do \
		EXISTING_PID=$$(lsof -ti :$$PORT 2>/dev/null); \
		if [ -n "$$EXISTING_PID" ]; then \
			echo "  -> WARNING: Port $$PORT in use (pid $$EXISTING_PID) — killing to free port"; \
			kill $$EXISTING_PID 2>/dev/null || true; \
			KILLED=1; \
		fi; \
	done; \
	[ "$$KILLED" = "1" ] && sleep 1 || true
	@bun run scripts/session.ts dev --pid-file .dev.pid -- \
		sh -c 'bun run db:seed && exec bun run dev'

# The API alone still needs a database, so it starts the dev session itself — which means it cannot
# run beside `make dev`, and the session refuses rather than letting the two share one.
dev-api: ## Start API dev server only, in its own dev session
	@EXISTING_PID=$$(lsof -ti :$(API_PORT) 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> WARNING: Port $(API_PORT) in use (pid $$EXISTING_PID) — killing to free port"; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@bun run scripts/session.ts dev --pid-file .dev-api.pid -- \
		sh -c 'bun run db:seed && exec bun run dev:api'

# The worker joins the dev session a `make dev-api` started rather than starting its own, since a
# worker with a database of its own would have nothing to work on.
dev-worker: ## Start background job worker only, inside the running dev session
	@bun run scripts/session.ts attach dev -- bun run dev:worker

dev-web: ## Start web dev server only
	@EXISTING_PID=$$(lsof -ti :$(WEB_PORT) 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> WARNING: Port $(WEB_PORT) in use (pid $$EXISTING_PID) — killing to free port"; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@setsid bun run dev:web & DEV_PID=$$!; \
	echo $$DEV_PID > .dev-web.pid; \
	trap "kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; rm -f .dev-web.pid" EXIT; \
	wait $$DEV_PID 2>/dev/null; \
	rm -f .dev-web.pid

down: ## Stop everything
	@echo "Stopping dev servers..."
	@FOUND=0; \
	for PIDFILE in .dev.pid .dev-api.pid .dev-worker.pid .dev-web.pid; do \
		DEV_PID=$$(cat $$PIDFILE 2>/dev/null); \
		if [ -n "$$DEV_PID" ]; then \
			kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; \
			rm -f $$PIDFILE; \
			echo "  -> Killed dev server process group (pid $$DEV_PID, $$PIDFILE)"; \
			FOUND=1; \
		fi; \
	done; \
	if [ "$$FOUND" = "0" ]; then \
		echo "  -> No pid files found, checking ports..."; \
		for PORT in $(API_PORT) $(WEB_PORT) $(STUDIO_PORT); do \
			PORT_PID=$$(lsof -ti :$$PORT 2>/dev/null); \
			if [ -n "$$PORT_PID" ]; then \
				kill $$PORT_PID 2>/dev/null || true; \
				echo "  -> Killed process on port $$PORT (pid $$PORT_PID)"; \
				FOUND=1; \
			fi; \
		done; \
	fi; \
	if [ "$$FOUND" = "0" ]; then \
		echo "  -> No dev servers running"; \
	fi

# ─── Worktrees: one checkout per task (scripts/worktree.ts) ───────────────────
# A parallel working environment as a feature of the repository rather than of any one
# harness — Claude Code, OpenCode and a plain terminal all build the same worktree from the
# same command. `NAME` is a named variable (like APPLY=1 / CHECK=1 above), never a bare word:
# Make reads a bare word as a goal, so `make worktree signup-page` would ask for a target
# called `signup-page` rather than pass the name.
#
# The branch is named exactly for the task and tracks nothing (see scripts/worktree.ts), and
# removal refuses on work it would lose unless FORCE=1.

worktree: ## Create or reopen .worktrees/NAME on branch NAME (FROM=<ref> to change the base)
	@test -n "$(NAME)" || { echo "usage: make worktree NAME=<name> [FROM=<ref>]"; exit 1; }
	bun run scripts/worktree.ts create "$(NAME)" $(if $(FROM),--from $(FROM),)

worktrees: ## List every worktree with its branch
	@bun run scripts/worktree.ts list

worktree-remove: ## Remove .worktrees/NAME, refusing on work that would be lost (FORCE=1 to override)
	@test -n "$(NAME)" || { echo "usage: make worktree-remove NAME=<name> [FORCE=1]"; exit 1; }
	bun run scripts/worktree.ts remove "$(NAME)" $(if $(FORCE),--force,)

# ─── Sessions: the database and the AT Protocol network (scripts/session.ts) ───
# There is no standing dev database. Each `make dev` and each test run brings up its own Postgres
# and its own private AT Protocol network, and removes both when it ends; `bun test` does the same
# on its own (scripts/session-preload.ts). Prod uses DO Managed Postgres.
#
# 🚨 The network is the only place anything may write AT Protocol records. A record on a real
# server is world-readable the moment it lands, and an identity registered with the real
# directory is permanent; the session's network brings its own directory, and `network.mjs`
# refuses to start unless its server is pointed at it.
#
# The targets below act on the RUNNING dev session, so start `make dev` first.

SESSION_DEV := bun run scripts/session.ts attach dev --

db-generate: ## Generate Drizzle migration from schema changes
	bun run db:generate

db-migrate: ## Apply pending migrations to the running dev session (make dev migrates on its own)
	$(SESSION_DEV) bun run db:migrate

db-push: ## Push schema directly to the running dev session (no migration files)
	$(SESSION_DEV) bun run db:push

db-studio: ## Open Drizzle Studio on the running dev session's database
	$(SESSION_DEV) bun run db:studio

db-seed: ## Re-run the session seed in the running dev session (make dev runs it on its own)
	$(SESSION_DEV) bun run db:seed

gauntlet-reset: ## Reset the User Gauntlet fixture in the running dev session
	$(SESSION_DEV) bun run db:gauntlet
	$(SESSION_DEV) bun run db:gauntlet:media

gauntlet-clean: ## Remove the User Gauntlet fixture from the running dev session
	$(SESSION_DEV) bun run db:gauntlet:clean

# A session removes its own containers when it ends, and the next session removes any a crash left
# behind — so this is only for reclaiming them without starting anything.
sessions-clean: ## Remove every session container and directory whose run has ended
	@bun -e 'import { clearAbandonedSessions } from "./scripts/session.ts"; await clearAbandonedSessions()'

stripe-webhooks: ## Forward Stripe test webhooks to the local API (run alongside `make dev`; needs the Stripe CLI)
	@command -v stripe >/dev/null 2>&1 || { echo "  Stripe CLI not found — install it (and optionally run 'stripe login')."; exit 1; }
	@KEY=$$(grep -E '^STRIPE_SECRET_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"); \
	if [ -n "$$KEY" ]; then export STRIPE_API_KEY="$$KEY"; fi; \
	echo "  Forwarding Stripe webhooks -> localhost:$(API_PORT)/api/payments/stripe/webhook"; \
	stripe listen --forward-to localhost:$(API_PORT)/api/payments/stripe/webhook

# ─── Quality ───

# What CI runs, in CI's order, as one command. `bun test` alone is the unit suites only,
# and `--project=gauntlet` skips the `chromium` project the marketing-page specs live in —
# so running a subset and believing you're covered is the easy mistake, and it is the one
# that has actually broken CI here. If this passes, ci.yml should too; if you skip it, you
# are guessing. (The `images` job isn't mirrored — it needs Docker and exists to catch a
# workspace-manifest failure mode that only appears in an image build.)
#
# Each half runs in a session of its own — `bun test` starts one itself, and the browser suite runs
# inside `SESSION_BROWSER` — so a verify run shares nothing with a running `make dev` or with
# another verify.
verify: ## Run everything CI runs: typecheck, lint, unit tests, full Playwright
	bun run typecheck
	bun run lint
	bun run econ:figures --check
	bun run lex:check
	bun run db:snapshots
	bun test
	$(MAKE) e2e-preflight
	$(SESSION_BROWSER) bunx playwright test

# The part of `verify` that can see a markdown file, which the pre-push hook runs instead of
# `verify` when every file a push changes is markdown. Biome is here because it is cheap and
# would be the first to notice if it learned to read markdown; the figures check owns the
# README's money block; the two guards scan the repository's own documents. A new check that
# reads markdown belongs here as well, and `scripts/pre-push-hook.test.ts` refuses a guard
# under `scripts/` that names a tracked markdown file or walks `git ls-files` without being listed.
verify-docs: ## Run only the checks that read markdown (the pre-push hook's docs-only path)
	bun run lint
	bun run econ:figures --check
	bun test scripts/american-spelling-guard.test.ts scripts/credential-shape-guard.test.ts

# The browser suite's own session: a database, a network, and free ports for the API and the
# preview server, which is what lets it run beside `make dev` on :8000.
SESSION_BROWSER := cd apps/web && bun run ../../scripts/session.ts browser --

typecheck: ## Run TypeScript type checking
	bun run typecheck

test: ## Run the unit and integration suites, in a session of their own
	bun test

lint: ## Check linting with Biome
	bun run lint

lint-fix: ## Lint + apply safe fixes with Biome
	bun run lint:fix

format: ## Format code with Biome
	bun run format

# ─── Browser testing (Playwright) ───
# Drives Playwright's own bundled Chromium (not your installed browser). See
# apps/web/tests/README.md — notably the SiteGate localStorage bypass.

# CORS_ONLY=1 is the one mode that needs no credentials — a preflight is an unauthenticated
# OPTIONS, and the non-secret STORAGE_* come from .do/app.yaml — which is why deploy-watch
# runs it hourly. The other two modes need the runtime key and stay manual.
storage-check: ## Inspect the live R2 buckets' ACL/policy/CORS posture (WRITE_PROBE=1 round-trips a test object; CORS_ONLY=1 preflights only, no secrets)
	bun run apps/api/scripts/storage-posture.ts $(if $(WRITE_PROBE),--write-probe,) $(if $(CORS_ONLY),--cors-only,)

# Deliberately NOT part of `verify`: it needs doctl authenticated against DigitalOcean,
# which CI has no token for and a fresh clone has no reason to. Run it when you touch
# .do/app.yaml, and after any deploy that was supposed to change configuration — those
# are the moments the two specs part company. See 42.05 Deployment Runbook.
spec-diff: ## Compare .do/*.yaml against the LIVE App Platform specs (DOCTL_CONTEXT=anthers for the Anthers account)
	bun run scripts/spec-diff.ts

# The ONLY safe way to push .do/app.yaml at production. Never run `doctl apps update
# --spec .do/app.yaml` by hand: the committed file declares secrets with no value, and
# App Platform reads that as "set them to empty" — which is exactly how all seven
# app-level secrets were wiped on 2026-08-15. This merges the live secret values (and
# any live-only fields, like `features`) into the committed spec before sending it.
# Dry run by default; APPLY=1 to actually update. See scripts/spec-apply.ts.
spec-apply: ## Apply .do/app.yaml, preserving live secrets (APPLY=1 sends, FROM_BWS=1 pulls from Bitwarden)
	bun run scripts/spec-apply.ts $(if $(APPLY),--apply,) $(if $(ALLOW_REMOVE),--allow-remove,) $(if $(FROM_BWS),--from-bws,)

# Compare the commit App Platform is actually serving against what `release` points
# at. `deploy_on_push` is false on every component, so a push to release that the CI
# `deploy` job never ran on (billing, a failing upstream job) succeeds and deploys
# nothing — and nothing local or phase-only can tell the difference. This asserts the
# live deployment's source_commit_hash against release. DOCTL_CONTEXT=anthers for the
# Anthers account; REF=origin/release to compare against an arbitrary ref.
deploy-status: ## Assert the live deployment's commit matches release (DOCTL_CONTEXT=anthers)
	bun run scripts/deploy-status.ts

# Assert Stripe can actually reach the webhook and that production holds secrets that work.
# Production once ran for weeks with no registered endpoint and a `stripe listen` secret
# copied from a developer's .env, and nothing anywhere noticed. Needs `bws` (vault read) and
# reaches the network, so it is not part of `verify` — same reasoning as spec-diff.
webhook-check: ## Assert Stripe's webhook endpoints and that prod's signing secrets work
	bun run scripts/webhook-check.ts

# Support from signup through settlement against test-mode Stripe, on a test clock. Needs `bws`
# (the Anthers Dev key) and the network, and takes a few minutes, so it is not part of `verify`.
# Run it after changing how invoices are read, discounted, recorded or settled — hand-built
# invoices cannot tell a right reading of Stripe's fields from a wrong one.
stripe-walk: ## Walk support through test-mode Stripe: charge, discount, record, settle
	bun run scripts/stripe-walk.ts

# Deliberately NOT part of `verify`. It needs the Obsidian vault, which only Parker has —
# so CI took the skip path on every run it ever had, and the only thing it reliably did
# was fail on the one machine that does have a vault, whenever the notes were reorganized.
# Same reasoning `spec-diff` and `storage-check` are out: a target that needs something
# outside the repository is a target you run on purpose. Run it before publishing anything
# quoting a wiki table.
wiki-figures: ## Render the wiki's generated money blocks into the vault (CHECK=1 to assert instead)
	bun run econ:figures --wiki $(if $(CHECK),--check,)

e2e-install: ## Install the Chromium build Playwright drives (one-time)
	bunx playwright install chromium

# Refuses, and names the command that fixes it, for the two environment failures that both
# present as every test failing instantly. See scripts/e2e-preflight.ts.
e2e-preflight: ## Assert the browser Playwright drives can launch
	@bun run scripts/e2e-preflight.ts

screenshots: ## Screenshot routes and flag JS errors (ROUTES="/a /b" to override)
	cd apps/web && bun run build.ts && bun run scripts/screenshot.ts $(ROUTES)

test-e2e: e2e-preflight ## Run the Playwright e2e suite in its own session (builds + serves automatically)
	$(SESSION_BROWSER) bunx playwright test

test-e2e-ui: e2e-preflight ## Run the Playwright e2e suite in UI mode, in its own session
	$(SESSION_BROWSER) bunx playwright test --ui

test-gauntlet: e2e-preflight ## Run the User Gauntlet spec pass in its own session
	$(SESSION_BROWSER) bunx playwright test --project=gauntlet


# ─── Desktop Studio (Tauri) ───
# The desktop shell wraps the SAME apps/web build the site serves, opening it at /studio.
# Its package scripts are deliberately not named dev/build, so the root's
# `--filter '*'` globs can't launch a window during `make dev` or force a Rust
# build on every web build — drive them from here instead.
#
# Debug builds point at the local dev API (http://localhost:8000), so `make dev`
# in another terminal is the expected companion. Override for other hosts with
# ANTHERS_API_BASE.

# The desktop app moved to its own repository on 2026-08-14:
#   https://github.com/anthers-inc/anthers-desktop
# It consumes this app's BUILD (apps/web/dist) rather than any package here — clone it
# beside this repo and its `bun run dev` builds the web app from the sibling checkout.
# Its installers, code signing and release flow live there, on their own cadence.

.DEFAULT_GOAL := help
