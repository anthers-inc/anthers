-- Retire Jams entirely (Parker, 2026-08-13). Not deprioritised — removed, because it is
-- not how Anthers will frame contests and calls for content, and leaving it standing
-- teaches a shape the platform is going to contradict.
--
-- 🚨 The TABLES go too, deliberately: "we're going to want to build that relatively fresh
-- when we get back to it, both in structure/design and nomenclature, so we might as well
-- give ourselves a clean start." Leaving them standing-but-unused would preserve a schema
-- and a vocabulary the replacement is expected to reject.
--
-- Both databases were backed up first per the vault's database rule, and both held ZERO
-- rows across all three tables — so this destroys no content. The backups are
-- `data/backups/anthers-20260814-002818-pre-jams-drop.sql` (dev) and
-- `data/backups/prod-anthers-pre-jams-drop-20260814-002819.sql` (prod).
--
-- What replaces this is the educational content call (31.04) — explicitly not being built
-- now; the marketing explanation is its own task.

DROP TABLE "game_jams" CASCADE;--> statement-breakpoint
DROP TABLE "jam_entries" CASCADE;--> statement-breakpoint
DROP TABLE "jam_votes" CASCADE;