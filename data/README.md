# data/

Gitignored dev scratch space — only this README is tracked, so the directory exists on
fresh clones.

The app database is no longer a file here, and there is no standing dev database at all: each
`make dev` and each test run starts its own Postgres and removes it when it ends
(`scripts/session.ts`), and prod uses DigitalOcean Managed Postgres. What lives here now:

- `backups/` — timestamped `pg_dump` snapshots, including the last of the old persistent dev
  database from before sessions replaced it
- `anthers*.sqlite*` — dead pre-Postgres artifacts, safe to delete
