ALTER TABLE "work_media_versions" ADD COLUMN "preserved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- ⭐ Preservation marks a version. The Works already in the program have their current
-- version flagged on `works`; their archived versions were the served media at some point
-- in that same Works's life, so they inherit the flag rather than reporting as the
-- creator's own storage after the fact.
UPDATE "work_media_versions" SET "preserved" = true
WHERE EXISTS (SELECT 1 FROM "works" WHERE "works"."id" = "work_media_versions"."work_id" AND "works"."preserved" = true);
