#!/usr/bin/env bash
set -euo pipefail

# Grant schema-level permissions to the app user
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Ensure app user can create tables in public schema
    GRANT ALL ON SCHEMA public TO ${DJANGO_DB_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DJANGO_DB_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DJANGO_DB_USER};

    -- Dev user gets the same
    GRANT ALL ON SCHEMA public TO ${DEV_DB_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DEV_DB_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DEV_DB_USER};
EOSQL

echo "Bluebell database initialized with user permissions."
