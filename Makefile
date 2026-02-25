# ─── Bluebell Makefile ───
# Dev + deploy commands following Poppy pattern

COMPOSE_DEV = docker compose -f docker-compose.dev.yml
COMPOSE_CADDY = docker compose -f docker-compose.caddy.yml
COMPOSE_DATA = docker compose -f docker-compose.data.yml

.PHONY: help up down rebuild logs ps bash shell migrate makemigrations createsuperuser \
        deploy deploy-status deploy-rollback caddy-up caddy-down caddy-logs \
        data-up data-down data-logs setup clean build

# ─── Development ───

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

up: ## Start dev services
	$(COMPOSE_DEV) up -d

down: ## Stop dev services
	$(COMPOSE_DEV) down

build: ## Build dev containers
	$(COMPOSE_DEV) build

rebuild: ## Rebuild and restart dev services
	$(COMPOSE_DEV) down
	$(COMPOSE_DEV) build
	$(COMPOSE_DEV) up -d

logs: ## Follow all dev logs
	$(COMPOSE_DEV) logs -f

ps: ## Show running containers
	$(COMPOSE_DEV) ps

bash: ## Shell into backend container
	$(COMPOSE_DEV) exec backend bash

shell: ## Django Python shell
	$(COMPOSE_DEV) exec backend python manage.py shell

migrate: ## Run Django migrations
	$(COMPOSE_DEV) exec backend python manage.py migrate

makemigrations: ## Create Django migrations
	$(COMPOSE_DEV) exec backend python manage.py makemigrations

createsuperuser: ## Create Django admin superuser
	$(COMPOSE_DEV) exec backend python manage.py createsuperuser

# ─── Deployment ───

deploy: ## Run blue-green deployment
	./deploy-blue-green.sh

deploy-status: ## Show active deployment slot
	./deploy-blue-green.sh --status

deploy-rollback: ## Rollback to previous deployment
	./deploy-blue-green.sh --rollback

# ─── Data Services (production) ───

data-up: ## Start data services (db, redis)
	$(COMPOSE_DATA) up -d

data-down: ## Stop data services
	$(COMPOSE_DATA) down

data-logs: ## Follow data service logs
	$(COMPOSE_DATA) logs -f

# ─── Caddy ───

caddy-up: ## Start Caddy reverse proxy
	$(COMPOSE_CADDY) up -d

caddy-down: ## Stop Caddy
	$(COMPOSE_CADDY) down

caddy-logs: ## Follow Caddy logs
	$(COMPOSE_CADDY) logs -f

# ─── Setup ───

setup: ## Install host dependencies
	./setup.sh

clean: ## Stop all services and remove images
	$(COMPOSE_DEV) down --rmi local
	$(COMPOSE_CADDY) down --rmi local 2>/dev/null || true
