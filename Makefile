# ─── Anthers Makefile ───

.PHONY: help install dev dev-api dev-worker dev-web down \
        db-ready db-up db-down db-generate db-migrate db-push db-studio db-seed db-reset \
        gauntlet-reset gauntlet-clean stripe-webhooks \
        verify typecheck test lint lint-fix format \
        e2e-install screenshots test-e2e test-e2e-ui test-gauntlet free-preview-port \
        spec-diff spec-apply deploy-status webhook-check dev-local \

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
	@echo "git hooks → .githooks (pre-push runs 'make verify'; bypass with git push --no-verify)"

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

dev-local: db-ready ## Start dev reading secrets from .env (offline, or no vault access)
	@mkdir -p data
	@bun run db:dev-account
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
	@setsid bun run dev & DEV_PID=$$!; \
	echo $$DEV_PID > .dev.pid; \
	trap "kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; rm -f .dev.pid" EXIT; \
	wait $$DEV_PID 2>/dev/null; \
	rm -f .dev.pid

dev-api: db-ready ## Start API dev server only
	@mkdir -p data
	@EXISTING_PID=$$(lsof -ti :$(API_PORT) 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> WARNING: Port $(API_PORT) in use (pid $$EXISTING_PID) — killing to free port"; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@setsid bun run dev:api & DEV_PID=$$!; \
	echo $$DEV_PID > .dev-api.pid; \
	trap "kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; rm -f .dev-api.pid" EXIT; \
	wait $$DEV_PID 2>/dev/null; \
	rm -f .dev-api.pid

dev-worker: db-ready ## Start background job worker only
	@mkdir -p data
	@setsid bun run dev:worker & DEV_PID=$$!; \
	echo $$DEV_PID > .dev-worker.pid; \
	trap "kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; rm -f .dev-worker.pid" EXIT; \
	wait $$DEV_PID 2>/dev/null; \
	rm -f .dev-worker.pid

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

# ─── Database (Postgres via compose.yaml) ───
# Dev runs on a local containerized Postgres (the hub left SQLite). `make dev`
# brings it up and migrates automatically via `db-ready`; the targets below are
# for running those steps by hand. Prod uses DO Managed Postgres.

db-ready: ## Ensure the dev Postgres is up, accepting connections, and migrated
	@if ! docker info >/dev/null 2>&1; then \
		echo "  -> ERROR: Docker isn't running. Start Docker Desktop/daemon, then retry."; \
		exit 1; \
	fi
	@docker compose up -d
	@echo "  -> waiting for Postgres to accept connections..."
	@until docker compose exec -T postgres pg_isready -U anthers -d anthers >/dev/null 2>&1; do sleep 1; done
	@bun run db:migrate

db-up: ## Start the local dev Postgres (detached)
	docker compose up -d

db-down: ## Stop the local dev Postgres (keeps data)
	docker compose down

db-generate: ## Generate Drizzle migration from schema changes
	bun run db:generate

db-migrate: ## Apply pending migrations
	bun run db:migrate

db-push: ## Push schema directly (dev only, no migration files)
	bun run db:push

db-studio: ## Open Drizzle Studio (database GUI)
	bun run db:studio

db-seed: ## Seed dev database with fake creators/projects/posts
	bun run db:seed

gauntlet-reset: db-ready ## Reset the User Gauntlet fixture and put the dev account back on the floor
	bun run db:gauntlet
	bun run db:gauntlet:media

gauntlet-clean: db-ready ## Remove the User Gauntlet fixture entirely
	bun run db:gauntlet:clean

stripe-webhooks: ## Forward Stripe test webhooks to the local API (run alongside `make dev`; needs the Stripe CLI)
	@command -v stripe >/dev/null 2>&1 || { echo "  Stripe CLI not found — install it (and optionally run 'stripe login')."; exit 1; }
	@KEY=$$(grep -E '^STRIPE_SECRET_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"); \
	if [ -n "$$KEY" ]; then export STRIPE_API_KEY="$$KEY"; fi; \
	echo "  Forwarding Stripe webhooks -> localhost:$(API_PORT)/api/payments/stripe/webhook"; \
	stripe listen --forward-to localhost:$(API_PORT)/api/payments/stripe/webhook

db-reset: ## Recreate the dev Postgres from scratch and reapply migrations (wipes data)
	docker compose down -v
	docker compose up -d
	@echo "  -> waiting for Postgres to accept connections..."
	@until docker compose exec -T postgres pg_isready -U anthers -d anthers >/dev/null 2>&1; do sleep 1; done
	$(MAKE) db-migrate

# ─── Quality ───

# What CI runs, in CI's order, as one command. `bun test` alone is the unit suites only,
# and `--project=gauntlet` skips the `chromium` project the marketing-page specs live in —
# so running a subset and believing you're covered is the easy mistake, and it is the one
# that has actually broken CI here. If this passes, ci.yml should too; if you skip it, you
# are guessing. (The `images` job isn't mirrored — it needs Docker and exists to catch a
# workspace-manifest failure mode that only appears in an image build.)
verify: ## Run everything CI runs: typecheck, lint, migrate, unit tests, full Playwright
	bun run typecheck
	bun run lint
	bun run econ:figures --check
	bun run lex:check
	bun run db:snapshots
	$(MAKE) db-ready
	bun test
	$(MAKE) free-preview-port
	cd apps/web && bunx playwright test

# The SPA preview server is never reused (see playwright.config.ts), so Playwright now
# refuses to start when something already holds the port — loudly, which is the point.
# The blessed targets clear it for you so that strictness isn't just an obstacle; running
# `bunx playwright test` by hand still gets the error, which is the right default.
free-preview-port:
	@fuser -k 4173/tcp >/dev/null 2>&1 && echo "  freed a stale preview server on :4173" || true

typecheck: ## Run TypeScript type checking
	bun run typecheck

test: ## Run all tests
	bun run test

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

screenshots: ## Screenshot routes and flag JS errors (ROUTES="/a /b" to override)
	cd apps/web && bun run build.ts && bun run scripts/screenshot.ts $(ROUTES)

test-e2e: free-preview-port ## Run the Playwright e2e suite (builds + serves automatically)
	cd apps/web && bunx playwright test

test-e2e-ui: free-preview-port ## Run the Playwright e2e suite in UI mode
	cd apps/web && bunx playwright test --ui

test-gauntlet: free-preview-port ## Run the User Gauntlet spec pass (fixture reset + staircase walk)
	cd apps/web && bunx playwright test --project=gauntlet


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
