# ─── Anthers Makefile ───

COMPOSE_DEV = docker compose -f docker-compose.dev.yml

.PHONY: help up down logs ps dev dev-api dev-worker dev-web dev-down install \
        db-generate db-migrate db-push db-studio \
        typecheck test lint format

# ─── Dev Infrastructure ───

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

up: ## Start dev database (PostgreSQL)
	$(COMPOSE_DEV) up -d

down: ## Stop dev servers + database
	@DEV_PID=$$(cat .dev.pid 2>/dev/null); \
	if [ -n "$$DEV_PID" ]; then \
		echo "  -> Stopping dev servers (pid $$DEV_PID)..."; \
		kill -- -$$DEV_PID 2>/dev/null || kill $$DEV_PID 2>/dev/null || true; \
		rm -f .dev.pid; \
	else \
		for PORT in 8000 3000; do \
			PORT_PID=$$(lsof -ti :$$PORT 2>/dev/null); \
			if [ -n "$$PORT_PID" ]; then \
				echo "  -> Killing process on port $$PORT (pid $$PORT_PID)"; \
				kill $$PORT_PID 2>/dev/null || true; \
			fi; \
		done; \
	fi
	@echo "  -> Stopping dev database..."
	$(COMPOSE_DEV) down

logs: ## Follow database logs
	$(COMPOSE_DEV) logs -f

ps: ## Show running containers
	$(COMPOSE_DEV) ps

# ─── Application ───

install: ## Install all dependencies
	bun install

dev: ## Start dev database (if needed) + API and web dev servers
	@if ! $(COMPOSE_DEV) ps --status running --format '{{.Service}}' 2>/dev/null | grep -q '^db$$'; then \
		echo "  -> Starting dev database..."; \
		$(COMPOSE_DEV) up -d; \
		echo "  -> Waiting for database to be ready..."; \
		until $(COMPOSE_DEV) exec -T db pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done; \
		echo "  -> Database ready"; \
	fi
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
	bun run db:migrate

db-push: ## Push schema directly (dev only, no migration files)
	bun run db:push

db-studio: ## Open Drizzle Studio (database GUI)
	bun run db:studio

# ─── Quality ───

typecheck: ## Run TypeScript type checking
	bun run typecheck

test: ## Run all tests
	bun run test

lint: ## Check linting with Biome
	bun run lint

format: ## Format code with Biome
	bun run format
