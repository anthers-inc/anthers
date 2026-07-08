# data/

Gitignored dev scratch space — only this README is tracked, so the directory exists on
fresh clones.

The app database is no longer a file here: the hub runs on Postgres (local dev uses the
`anthers-pg` container from `compose.yaml`; prod uses DigitalOcean Managed Postgres), and
the job queue is pg-boss inside that same database. What lives here now:

- `backups/` — timestamped `pg_dump` snapshots of the local dev DB
- `anthers*.sqlite*` — dead pre-Postgres artifacts, safe to delete

`make db-reset` recreates the Postgres container from an empty volume and reapplies
migrations; it doesn't touch this directory.
