#!/usr/bin/env bash
set -euo pipefail

# ─── Bluebell Blue-Green Deployment ───
# Full-stack blue/green: backend + celery + frontend per slot
# Shared data services (db, redis) managed separately

COMPOSE_DATA="docker-compose.data.yml"
COMPOSE_CADDY="docker-compose.caddy.yml"
STATE_FILE=".deployment-state"
HEALTH_TIMEOUT=90
HEALTH_INTERVAL=3

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

get_active_slot() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
    else
        echo "none"
    fi
}

set_active_slot() {
    echo "$1" > "$STATE_FILE"
}

container_healthy() {
    local status
    status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$1" 2>/dev/null || echo "not_found")
    [ "$status" = "healthy" ]
}

health_check() {
    local container=$1
    local elapsed=0

    echo -e "${YELLOW}Waiting for $container to become healthy...${NC}"
    while [ $elapsed -lt $HEALTH_TIMEOUT ]; do
        if container_healthy "$container"; then
            echo -e "${GREEN}✓ $container is healthy${NC}"
            return 0
        fi
        sleep $HEALTH_INTERVAL
        elapsed=$((elapsed + HEALTH_INTERVAL))
    done

    echo -e "${RED}✗ $container failed health check after ${HEALTH_TIMEOUT}s${NC}"
    docker logs --tail 30 "$container" 2>&1 || true
    return 1
}

ensure_data_services() {
    echo -e "${YELLOW}Ensuring data services are running...${NC}"
    docker volume create bluebell_media_data 2>/dev/null || true
    docker compose -f "$COMPOSE_DATA" up -d

    if ! container_healthy bluebell-db; then
        health_check bluebell-db || exit 1
    fi
    if ! container_healthy bluebell-redis; then
        health_check bluebell-redis || exit 1
    fi
    echo -e "${GREEN}✓ Data services are ready${NC}"
}

ensure_caddy() {
    if docker ps --format '{{.Names}}' | grep -q bluebell-caddy; then
        echo -e "${GREEN}✓ Caddy is already running${NC}"
    else
        echo -e "${YELLOW}Starting Caddy...${NC}"
        docker compose -f "$COMPOSE_CADDY" up -d
        echo -e "${GREEN}✓ Caddy is running${NC}"
    fi
}

show_status() {
    local active
    active=$(get_active_slot)
    echo -e "${BLUE}── Bluebell Deployment Status ──${NC}"
    echo -e "Active slot: ${GREEN}${active}${NC}"

    echo ""
    echo -e "${BLUE}Caddy:${NC}"
    if docker ps --format '{{.Names}}' | grep -q "^bluebell-caddy$"; then
        echo -e "  bluebell-caddy: ${GREEN}running${NC}"
    else
        echo -e "  bluebell-caddy: ${RED}stopped${NC}"
    fi

    echo ""
    echo -e "${BLUE}Data services:${NC}"
    for svc in bluebell-db bluebell-redis; do
        if container_healthy "$svc"; then
            echo -e "  $svc: ${GREEN}healthy${NC}"
        elif docker ps --format '{{.Names}}' | grep -q "^${svc}$"; then
            echo -e "  $svc: ${YELLOW}running (unhealthy)${NC}"
        else
            echo -e "  $svc: ${RED}stopped${NC}"
        fi
    done

    for slot in blue green; do
        echo ""
        echo -e "${BLUE}${slot^} slot:${NC}"
        for svc in "bluebell-backend-${slot}" "bluebell-celery-${slot}" "bluebell-frontend-${slot}"; do
            if container_healthy "$svc" 2>/dev/null; then
                echo -e "  $svc: ${GREEN}healthy${NC}"
            elif docker ps --format '{{.Names}}' | grep -q "^${svc}$"; then
                echo -e "  $svc: ${YELLOW}running${NC}"
            else
                echo -e "  $svc: ${RED}stopped${NC}"
            fi
        done
    done
}

deploy() {
    local active
    active=$(get_active_slot)

    local new_slot new_compose old_compose
    if [ "$active" = "blue" ]; then
        new_slot="green"
        new_compose="docker-compose.green.yml"
        old_compose="docker-compose.blue.yml"
    else
        new_slot="blue"
        new_compose="docker-compose.blue.yml"
        old_compose="docker-compose.green.yml"
    fi

    echo -e "${BLUE}── Deploying to ${new_slot} ──${NC}"
    echo -e "Active: ${active:-none} → New: ${new_slot}"

    # Ensure data services and Caddy are up
    ensure_data_services
    ensure_caddy

    # Build and start the new slot
    echo -e "${YELLOW}Building ${new_slot}...${NC}"
    docker compose -f "$new_compose" build
    docker compose -f "$new_compose" up -d

    # Health check backend and frontend
    if ! health_check "bluebell-backend-${new_slot}"; then
        echo -e "${RED}Deployment failed. Rolling back...${NC}"
        docker compose -f "$new_compose" down
        exit 1
    fi

    if ! health_check "bluebell-frontend-${new_slot}"; then
        echo -e "${RED}Deployment failed. Rolling back...${NC}"
        docker compose -f "$new_compose" down
        exit 1
    fi

    # Reload Caddy to pick up the new healthy backends
    if docker ps --format '{{.Names}}' | grep -q bluebell-caddy; then
        echo -e "${YELLOW}Reloading Caddy...${NC}"
        docker exec bluebell-caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true
    fi

    # Stop the old slot
    if [ "$active" != "none" ]; then
        echo -e "${YELLOW}Stopping ${active}...${NC}"
        docker compose -f "$old_compose" down
    fi

    set_active_slot "$new_slot"
    echo -e "${GREEN}✓ Deployment complete. Active: ${new_slot}${NC}"
}

rollback() {
    local active
    active=$(get_active_slot)

    if [ "$active" = "none" ]; then
        echo -e "${RED}No active deployment to rollback from.${NC}"
        exit 1
    fi

    local prev_slot
    if [ "$active" = "blue" ]; then
        prev_slot="green"
    else
        prev_slot="blue"
    fi

    echo -e "${YELLOW}Rolling back: ${active} → ${prev_slot}${NC}"
    deploy
}

# ─── CLI ───
case "${1:-deploy}" in
    --status)
        show_status
        ;;
    --rollback)
        rollback
        ;;
    deploy|"")
        deploy
        ;;
    *)
        echo "Usage: $0 [--status|--rollback]"
        exit 1
        ;;
esac
