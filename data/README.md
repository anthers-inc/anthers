# data/

Local SQLite files live here and are gitignored — only this README is tracked, so the
directory exists on fresh clones.

- `anthers.sqlite` — the app database (created by `make db-migrate` or on first run)
- `anthers-queue.sqlite` — the job queue database (its own file keeps claim transactions
  out of the app DB's lock domain)

`make db-reset` wipes these files and reapplies the schema.
