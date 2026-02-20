#!/usr/bin/env bash
set -euo pipefail

# Substitute environment variables into the SQL template and execute
envsubst < /docker-entrypoint-initdb.d/_00-init-users-source.sql.template | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
