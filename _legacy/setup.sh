#!/usr/bin/env bash
set -euo pipefail

echo "── Bluebell Host Setup ──"

# Check Docker
if command -v docker &>/dev/null; then
    echo "✓ Docker $(docker --version | awk '{print $3}' | tr -d ',')"
else
    echo "✗ Docker not found. Install from https://docs.docker.com/get-docker/"
    exit 1
fi

# Check Docker Compose
if docker compose version &>/dev/null; then
    echo "✓ Docker Compose $(docker compose version --short)"
else
    echo "✗ Docker Compose not found. Install Docker Desktop or the compose plugin."
    exit 1
fi

# Check Bun (optional for local dev outside Docker)
if command -v bun &>/dev/null; then
    echo "✓ Bun $(bun --version)"
else
    echo "⚠ Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    echo "✓ Bun installed. Restart your shell or run: source ~/.bashrc"
fi

# Check Python (optional for local dev outside Docker)
if command -v python3 &>/dev/null; then
    echo "✓ Python $(python3 --version | awk '{print $2}')"
else
    echo "⚠ Python 3 not found. Install from https://www.python.org/downloads/"
fi

# Create .env if missing
if [ ! -f .env ]; then
    echo ""
    echo "Creating .env from .env.example..."
    cp .env.example .env
    # Generate a random Django secret key
    RANDOM_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))" 2>/dev/null || openssl rand -base64 50 | tr -d '\n')
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/change-me-to-a-random-secret/$RANDOM_KEY/" .env
    else
        sed -i "s/change-me-to-a-random-secret/$RANDOM_KEY/" .env
    fi
    echo "✓ .env created — review and update passwords before running"
else
    echo "✓ .env already exists"
fi

echo ""
echo "Setup complete. Next steps:"
echo "  1. Review .env and set secure passwords"
echo "  2. make build && make up"
echo "  3. make migrate"
echo "  4. make createsuperuser"
