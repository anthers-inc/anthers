#!/usr/bin/env bash
set -euo pipefail

echo "Installing dependencies..."
bun install

exec "$@"
