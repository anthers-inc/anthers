# ─── Anthers Makefile ───

.PHONY: help install dev dev-api dev-worker dev-web down \
        db-generate db-migrate db-push db-studio db-seed db-reset \
        typecheck test lint lint-fix format

API_PORT ?= 8000
WEB_PORT ?= 3000

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Application ───

install: ## Install all dependencies
	bun install

dev: ## Start API + worker + web dev servers
	@mkdir -p data
	@KILLED=0; \
	for PORT in $(API_PORT) $(WEB_PORT); do \
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

dev-api: ## Start API dev server only
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

dev-worker: ## Start background job worker only
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
		for PORT in $(API_PORT) $(WEB_PORT); do \
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

# ─── Database ───

db-generate: ## Generate Drizzle migration from schema changes
	bun run db:generate

db-migrate: ## Apply pending migrations
	@mkdir -p data
	bun run db:migrate

db-push: ## Push schema directly (dev only, no migration files)
	@mkdir -p data
	bun run db:push

db-studio: ## Open Drizzle Studio (database GUI)
	bun run db:studio

db-seed: ## Seed dev database with fake creators/projects/posts
	@mkdir -p data
	bun run db:seed

db-reset: ## Wipe the dev SQLite files and reapply the schema
	@rm -f data/anthers.sqlite data/anthers.sqlite-wal data/anthers.sqlite-shm
	@rm -f data/anthers-queue.sqlite data/anthers-queue.sqlite-wal data/anthers-queue.sqlite-shm
	@mkdir -p data
	$(MAKE) db-push

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

.DEFAULT_GOAL := help
