#!/usr/bin/env bash
set -euo pipefail

# Substitute environment variables into the SQL template and execute
# Note: envsubst is not available in the postgres:17 image, so use sed
sed \
  -e "s|\${DJANGO_DB_USER}|${DJANGO_DB_USER}|g" \
  -e "s|\${DJANGO_DB_PASSWORD}|${DJANGO_DB_PASSWORD}|g" \
  -e "s|\${DEV_DB_USER}|${DEV_DB_USER}|g" \
  -e "s|\${DEV_DB_PASSWORD}|${DEV_DB_PASSWORD}|g" \
  -e "s|\${POSTGRES_DB}|${POSTGRES_DB}|g" \
  /docker-entrypoint-initdb.d/_00-init-users-source.sql.template \
  | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
