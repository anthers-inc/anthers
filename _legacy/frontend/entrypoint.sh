#!/usr/bin/env bash
set -euo pipefail

# Install deps in dev (volume-mounted source); skip in prod (no package.json)
if [ -f package.json ]; then
  bun install
fi

exec "$@"
