-- The goods-works normalization (Parker, 2026-10-09 — the goods-works rule: the Public
-- Access model binds only streamable Works). A physical Work delivers by being bought;
-- the stream/download flags mean nothing on it, but the two shirt Works the store launch
-- created carried the digital default (`stream_enabled: true`, seeded before the goods
-- kinds had a rule of their own), and a store page carrying a streamable flag would read
-- back as a player that never plays.
--
-- Physical only: service carries the digital flags (and the release walk's expectations)
-- until its own purchase rail lands, and normalizes on that day's migration.
--
-- Data-only: the schema carries no change — the statement converges every environment
-- (dev fixtures included) on the state creation seeds from now on.
UPDATE "works" SET "stream_enabled" = false, "download_enabled" = false
WHERE "type" = 'physical' AND ("stream_enabled" OR "download_enabled");
