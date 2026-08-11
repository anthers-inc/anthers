# ─── Anthers Makefile ───

.PHONY: help install dev dev-api dev-worker dev-web down \
        db-ready db-up db-down db-generate db-migrate db-push db-studio db-seed db-reset \
        gauntlet-reset gauntlet-clean stripe-webhooks \
        verify typecheck test lint lint-fix format \
        e2e-install screenshots test-e2e test-e2e-ui test-gauntlet free-preview-port \
        desktop-dev desktop-check desktop-build desktop-build-linux desktop-build-windows \
        desktop-build-macos desktop-notarize desktop-version desktop-release

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

dev: db-ready ## Start API + worker + web dev servers
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

storage-check: ## Inspect the live Spaces bucket's ACL/policy/CORS posture (WRITE_PROBE=1 to round-trip a test object)
	bun run apps/api/scripts/storage-posture.ts $(if $(WRITE_PROBE),--write-probe,)

# Deliberately NOT part of `verify`: it needs doctl authenticated against DigitalOcean,
# which CI has no token for and a fresh clone has no reason to. Run it when you touch
# .do/app.yaml, and after any deploy that was supposed to change configuration — those
# are the moments the two specs part company. See 42.05 Deployment Runbook.
spec-diff: ## Compare .do/*.yaml against the LIVE App Platform specs (DOCTL_CONTEXT=anthers for the Anthers account)
	bun run scripts/spec-diff.ts

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
# The desktop shell wraps the SAME apps/studio-web build the browser Studio serves.
# Its package scripts are deliberately not named dev/build, so the root's
# `--filter '*'` globs can't launch a window during `make dev` or force a Rust
# build on every web build — drive them from here instead.
#
# Debug builds point at the local dev API (http://localhost:8000), so `make dev`
# in another terminal is the expected companion. Override for other hosts with
# ANTHERS_API_BASE.

desktop-dev: ## Run the desktop Studio against the local dev API (needs `make dev`)
	cd apps/studio-desktop && bun run tauri:dev

desktop-check: ## Typecheck the Rust shell without building installers
	cd apps/studio-desktop/src-tauri && cargo check


# ─── Desktop packaging ───
# There is NO cross-compilation here: each platform's installers must be built on
# that platform. Distribution is GitHub Releases — no app stores — so the flow is
# build on each machine, collect the bundles, then `make desktop-release`.
#
# `desktop-build` picks the right target for whatever you're on; the per-platform
# targets exist so a wrong-OS invocation fails with a sentence instead of a
# confusing toolchain error. Follows the ~/Lily pattern.

DESKTOP_DIR := apps/studio-desktop
DESKTOP_BUNDLE := $(DESKTOP_DIR)/src-tauri/target/release/bundle

desktop-build: ## Build desktop installers for THIS platform
ifeq ($(DETECTED_OS),linux)
	@$(MAKE) desktop-build-linux
else ifeq ($(DETECTED_OS),macos)
	@$(MAKE) desktop-build-macos
else
	@$(MAKE) desktop-build-windows
endif

ifeq ($(DETECTED_OS),linux)
desktop-build-linux: ## Build Linux installers (.deb, .rpm, AppImage)
	@echo "Building Linux installers — fetches the ffmpeg sidecar on first run..."
	cd $(DESKTOP_DIR) && bun run tauri:build
	@echo ""
	@echo "Outputs in $(DESKTOP_BUNDLE)/: deb/ rpm/ appimage/"
else
desktop-build-linux:
	@echo "ERROR: Linux installers must be built on Linux."; exit 1
endif

ifeq ($(DETECTED_OS),windows)
desktop-build-windows: ## Build Windows installers (.msi, .exe)
	@echo "Building Windows installers..."
	cd $(DESKTOP_DIR); bun run tauri:build
	@echo ""
	@echo "Outputs in $(DESKTOP_BUNDLE)/: msi/ nsis/"
else
desktop-build-windows:
	@echo "ERROR: Windows installers must be built on Windows."; exit 1
endif

ifeq ($(DETECTED_OS),macos)
desktop-build-macos: ## Build + sign macOS installers (.app, .dmg)
	@if [ -f .env ]; then \
		echo "  -> Signing config from .env"; \
	else \
		echo "  -> WARNING: no .env — the build will be UNSIGNED and Gatekeeper will refuse it."; \
		echo "     See .env.example for the Apple credentials required."; \
	fi
	@echo "Building macOS app..."
	@# APPLE_ID/PASSWORD/TEAM_ID are unset for the build itself so Tauri's bundler
	@# doesn't try to notarize inline — notarization is `make desktop-notarize`, after
	@# the re-sign below. Leaving them set makes the bundler notarize a binary we are
	@# about to replace.
	@if [ -f .env ]; then \
		. ./.env && \
		( unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID && cd $(DESKTOP_DIR) && bun run tauri:build ); \
	else \
		cd $(DESKTOP_DIR) && bun run tauri:build; \
	fi
	@# Tauri's bundler signs without --timestamp, which notarization rejects. Re-sign
	@# the inner binary, the bundled ffmpeg sidecars, and then the .app — inside-out,
	@# because signing the bundle seals whatever it contains at that moment.
	@if [ -f .env ]; then \
		. ./.env && \
		echo "" && echo "Re-signing with hardened runtime + secure timestamp..." && \
		APP="$(DESKTOP_BUNDLE)/macos/Anthers Studio.app" && \
		for BIN in "$$APP/Contents/MacOS/"*; do \
			codesign --force --options runtime --timestamp \
				--entitlements $(DESKTOP_DIR)/src-tauri/entitlements.plist \
				--sign "$$APPLE_SIGNING_IDENTITY" "$$BIN" || exit 1; \
		done && \
		codesign --force --options runtime --timestamp \
			--entitlements $(DESKTOP_DIR)/src-tauri/entitlements.plist \
			--sign "$$APPLE_SIGNING_IDENTITY" "$$APP" && \
		echo "  -> Re-signed .app (including ffmpeg sidecars)" && \
		echo "" && echo "Rebuilding DMG from the re-signed .app..." && \
		VERSION=$$(grep '^version = ' $(DESKTOP_DIR)/src-tauri/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/') && \
		ARCH=$$(uname -m | sed 's/arm64/aarch64/') && \
		DMG="$(DESKTOP_BUNDLE)/dmg/Anthers Studio_$${VERSION}_$${ARCH}.dmg" && \
		rm -f "$$DMG" && \
		hdiutil create -volname "Anthers Studio" -srcfolder "$$APP" -ov -format UDZO "$$DMG" && \
		codesign --force --timestamp --sign "$$APPLE_SIGNING_IDENTITY" "$$DMG" && \
		echo "  -> DMG rebuilt + signed: $$DMG" && \
		echo "" && codesign --verify --deep --strict "$$APP" && echo "  -> Signature: OK" && \
		echo "" && echo "Next: make desktop-notarize"; \
	fi

desktop-notarize: ## Submit the macOS DMG to Apple, staple, and verify Gatekeeper
	@if [ ! -f .env ]; then echo "ERROR: .env required (see .env.example)"; exit 1; fi
	@. ./.env && \
	VERSION=$$(grep '^version = ' $(DESKTOP_DIR)/src-tauri/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/') && \
	ARCH=$$(uname -m | sed 's/arm64/aarch64/') && \
	DMG="$(DESKTOP_BUNDLE)/dmg/Anthers Studio_$${VERSION}_$${ARCH}.dmg" && \
	if [ ! -f "$$DMG" ]; then echo "ERROR: no DMG at $$DMG — run 'make desktop-build-macos' first"; exit 1; fi && \
	echo "Submitting $$DMG (this waits on Apple, and can take a while)..." && \
	xcrun notarytool submit "$$DMG" --apple-id "$$APPLE_ID" --password "$$APPLE_PASSWORD" \
		--team-id "$$APPLE_TEAM_ID" --wait && \
	echo "" && echo "Stapling the ticket..." && \
	xcrun stapler staple "$$DMG" && \
	echo "" && echo "Verifying Gatekeeper..." && \
	spctl --assess --type open --context context:primary-signature "$$DMG" 2>&1 && \
	echo "  -> Notarized + stapled: $$DMG"
else
desktop-build-macos:
	@echo "ERROR: macOS installers must be built on macOS."; exit 1

desktop-notarize:
	@echo "ERROR: macOS notarization must be run on macOS."; exit 1
endif

desktop-version: ## Show or set the desktop app version (V=X.Y.Z)
ifndef V
	@echo "Desktop version: $$(grep '^version = ' $(DESKTOP_DIR)/src-tauri/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/')"
else
	@$(SED_INPLACE) 's/^version = ".*"/version = "$(V)"/' $(DESKTOP_DIR)/src-tauri/Cargo.toml
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' $(DESKTOP_DIR)/src-tauri/tauri.conf.json
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' $(DESKTOP_DIR)/package.json
	@echo "Desktop version set to $(V) in Cargo.toml, tauri.conf.json, package.json"
	@echo "NOTE: the DMG/notarize targets derive their filename from Cargo.toml, so"
	@echo "      these three must not drift."
endif

desktop-release: ## Publish whatever bundles exist to a GitHub Release (V=X.Y.Z)
ifndef V
	@echo "ERROR: pass the version, e.g. make desktop-release V=0.1.0"; exit 1
else
	@echo "Collecting bundles from $(DESKTOP_BUNDLE)/ ..."
	@FILES=$$(find $(DESKTOP_BUNDLE) -maxdepth 2 -type f \
		\( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \
		   -o -name '*.dmg' -o -name '*.msi' -o -name '*.exe' \) 2>/dev/null); \
	if [ -z "$$FILES" ]; then \
		echo "ERROR: no installers found. Run 'make desktop-build' on each platform first."; \
		exit 1; \
	fi; \
	echo "$$FILES" | sed 's/^/  /'; \
	echo ""; \
	echo "Uploading to release studio-v$(V) (created as a draft if it doesn't exist)..."; \
	gh release view "studio-v$(V)" >/dev/null 2>&1 \
		|| gh release create "studio-v$(V)" --draft --title "Anthers Studio $(V)" \
			--notes "Desktop Creator Studio $(V). Installers are per-platform; each is built on its own OS."; \
	echo "$$FILES" | xargs -I{} gh release upload "studio-v$(V)" "{}" --clobber; \
	echo ""; \
	echo "Done. Review and publish: gh release view studio-v$(V) --web"
endif

.DEFAULT_GOAL := help
