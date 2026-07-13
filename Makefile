# ─── Anthers Makefile ───

.PHONY: help install dev dev-api dev-worker dev-web down \
        db-ready db-up db-down db-generate db-migrate db-push db-studio db-seed db-reset \
        typecheck test lint lint-fix format \
        e2e-install screenshots test-e2e test-e2e-ui

API_PORT ?= 8000
WEB_PORT ?= 3000
STUDIO_PORT ?= 3001

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Application ───

install: ## Install all dependencies
	bun install

dev: db-ready ## Start API + worker + web dev servers
	@mkdir -p data
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

db-reset: ## Recreate the dev Postgres from scratch and reapply migrations (wipes data)
	docker compose down -v
	docker compose up -d
	@echo "  -> waiting for Postgres to accept connections..."
	@until docker compose exec -T postgres pg_isready -U anthers -d anthers >/dev/null 2>&1; do sleep 1; done
	$(MAKE) db-migrate

# ─── Quality ───

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

e2e-install: ## Install the Chromium build Playwright drives (one-time)
	bunx playwright install chromium

screenshots: ## Screenshot routes and flag JS errors (ROUTES="/a /b" to override)
	cd apps/web && bun run build.ts && bun run scripts/screenshot.ts $(ROUTES)

test-e2e: ## Run the Playwright e2e suite (builds + serves automatically)
	cd apps/web && bunx playwright test

test-e2e-ui: ## Run the Playwright e2e suite in UI mode
	cd apps/web && bunx playwright test --ui

.DEFAULT_GOAL := help
