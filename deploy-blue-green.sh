#!/usr/bin/env bash
set -euo pipefail

# ─── Bluebell Blue-Green Deployment ───
# Adapted from Poppy pattern

STATE_FILE=".deployment-state"
HEALTH_TIMEOUT=30
HEALTH_INTERVAL=2

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

health_check() {
    local container=$1
    local port=$2
    local elapsed=0

    echo -e "${YELLOW}Waiting for $container to become healthy...${NC}"
    while [ $elapsed -lt $HEALTH_TIMEOUT ]; do
        if curl -sf "http://localhost:$port/" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ $container is healthy${NC}"
            return 0
        fi
        sleep $HEALTH_INTERVAL
        elapsed=$((elapsed + HEALTH_INTERVAL))
    done

    echo -e "${RED}✗ $container failed health check after ${HEALTH_TIMEOUT}s${NC}"
    return 1
}

show_status() {
    local active
    active=$(get_active_slot)
    echo -e "${BLUE}── Bluebell Deployment Status ──${NC}"
    echo -e "Active slot: ${GREEN}${active}${NC}"

    if docker ps --format '{{.Names}}' | grep -q bluebell-frontend-blue; then
        echo -e "Blue:  ${GREEN}running${NC}"
    else
        echo -e "Blue:  ${RED}stopped${NC}"
    fi

    if docker ps --format '{{.Names}}' | grep -q bluebell-frontend-green; then
        echo -e "Green: ${GREEN}running${NC}"
    else
        echo -e "Green: ${RED}stopped${NC}"
    fi
}

deploy() {
    local active
    active=$(get_active_slot)

    local new_slot new_compose new_container new_port old_compose
    if [ "$active" = "blue" ]; then
        new_slot="green"
        new_compose="docker-compose.green.yml"
        new_container="bluebell-frontend-green"
        new_port="3001"
        old_compose="docker-compose.blue.yml"
    else
        new_slot="blue"
        new_compose="docker-compose.blue.yml"
        new_container="bluebell-frontend-blue"
        new_port="3000"
        old_compose="docker-compose.green.yml"
    fi

    echo -e "${BLUE}── Deploying to ${new_slot} ──${NC}"
    echo -e "Active: ${active:-none} → New: ${new_slot}"

    # Build and start the new slot
    echo -e "${YELLOW}Building ${new_slot}...${NC}"
    docker compose -f "$new_compose" build
    docker compose -f "$new_compose" up -d

    # Health check the new slot
    if ! health_check "$new_container" "$new_port"; then
        echo -e "${RED}Deployment failed. Rolling back...${NC}"
        docker compose -f "$new_compose" down
        exit 1
    fi

    # Reload Caddy to pick up the new healthy backend
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
