# ─── Anthers Makefile ───

COMPOSE_DEV = docker compose -f docker-compose.dev.yml

.PHONY: help up down logs ps dev dev-api dev-worker dev-web install \
        db-generate db-migrate db-push db-studio \
        typecheck test lint format

# ─── Dev Infrastructure ───

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

up: ## Start dev database (PostgreSQL)
	$(COMPOSE_DEV) up -d

down: ## Stop dev databases
	$(COMPOSE_DEV) down

logs: ## Follow database logs
	$(COMPOSE_DEV) logs -f

ps: ## Show running containers
	$(COMPOSE_DEV) ps

# ─── Application ───

install: ## Install all dependencies
	bun install

dev: ## Start API and web dev servers
	bun run dev

dev-api: ## Start API dev server only
	bun run dev:api

dev-worker: ## Start background job worker only
	bun run dev:worker

dev-web: ## Start web dev server only
	bun run dev:web

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
