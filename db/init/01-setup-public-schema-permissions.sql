-- Grant schema permissions for application and dev users
-- This runs after users are created in _00-init-users

-- Grant usage and create on public schema
DO $$
DECLARE
    app_user TEXT;
    dev_user TEXT;
BEGIN
    -- Read from environment-substituted role names
    SELECT current_setting('app.django_db_user', true) INTO app_user;
    SELECT current_setting('app.dev_db_user', true) INTO dev_user;

    -- Fallback to checking existing roles
    IF app_user IS NULL THEN
        FOR app_user IN SELECT rolname FROM pg_roles WHERE rolname LIKE '%_app' LOOP
            EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', app_user);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', app_user);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', app_user);
        END LOOP;
    END IF;
END
$$;

-- Simpler approach: grant to all non-superuser roles that exist
GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC;
