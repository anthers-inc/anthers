# ─── Anthers Makefile ───

.PHONY: help install dev dev-api dev-worker dev-web dev-down \
        db-generate db-migrate db-push db-studio db-seed db-reset \
        typecheck test lint format

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Application ───

install: ## Install all dependencies
	bun install

dev: ## Start API + worker + web dev servers
	@mkdir -p data
	@KILLED=0; \
	for PORT in 8000 3000; do \
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
	@EXISTING_PID=$$(lsof -ti :8000 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> WARNING: Port 8000 in use (pid $$EXISTING_PID) — killing to free port"; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@setsid bun run dev:api & DEV_PID=$$!; \
	echo $$DEV_PID > .dev.pid; \
	trap "kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; rm -f .dev.pid" EXIT; \
	wait $$DEV_PID 2>/dev/null; \
	rm -f .dev.pid

dev-worker: ## Start background job worker only
	@mkdir -p data
	@setsid bun run dev:worker & DEV_PID=$$!; \
	echo $$DEV_PID > .dev.pid; \
	trap "kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; rm -f .dev.pid" EXIT; \
	wait $$DEV_PID 2>/dev/null; \
	rm -f .dev.pid

dev-web: ## Start web dev server only
	@EXISTING_PID=$$(lsof -ti :3000 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> WARNING: Port 3000 in use (pid $$EXISTING_PID) — killing to free port"; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@setsid bun run dev:web & DEV_PID=$$!; \
	echo $$DEV_PID > .dev.pid; \
	trap "kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; rm -f .dev.pid" EXIT; \
	wait $$DEV_PID 2>/dev/null; \
	rm -f .dev.pid

dev-down: ## Stop dev servers
	@echo "Stopping dev servers..."
	@DEV_PID=$$(cat .dev.pid 2>/dev/null); \
	if [ -n "$$DEV_PID" ]; then \
		kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; \
		rm -f .dev.pid; \
		echo "  -> Killed dev server process group (pid $$DEV_PID)"; \
	else \
		echo "  -> No .dev.pid found, checking ports..."; \
		FOUND=0; \
		for PORT in 8000 3000; do \
			PORT_PID=$$(lsof -ti :$$PORT 2>/dev/null); \
			if [ -n "$$PORT_PID" ]; then \
				kill $$PORT_PID 2>/dev/null || true; \
				echo "  -> Killed process on port $$PORT (pid $$PORT_PID)"; \
				FOUND=1; \
			fi; \
		done; \
		if [ "$$FOUND" = "0" ]; then \
			echo "  -> No dev servers running"; \
		fi; \
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

db-reset: ## Drop the dev SQLite files (forces recreate on next start)
	rm -f data/anthers.sqlite data/anthers.sqlite-wal data/anthers.sqlite-shm
	rm -f data/anthers-queue.sqlite data/anthers-queue.sqlite-wal data/anthers-queue.sqlite-shm

# ─── Quality ───

typecheck: ## Run TypeScript type checking
	bun run typecheck

test: ## Run all tests
	bun run test

lint: ## Check linting with Biome
	bun run lint

format: ## Format code with Biome
	bun run format
