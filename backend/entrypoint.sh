#!/usr/bin/env bash
set -euo pipefail

echo "Running migrations..."
python manage.py migrate --noinput

echo "Collecting static files..."
python manage.py collectstatic --noinput 2>/dev/null || true

exec "$@"
