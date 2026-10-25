ALTER TABLE "works" ADD COLUMN "preserved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "kept_at";--> statement-breakpoint
-- ⭐ Backfill: every Work already on somebody's shelf, and every Work already sold,
-- enters the preservation program. The column defaults to false, and without this a
-- Work a buyer already owns would be the one thing the sweep could still purge —
-- exactly the promise this program exists to make instead.
UPDATE "works" SET "preserved" = true
WHERE EXISTS (SELECT 1 FROM "library_items" WHERE "library_items"."work_id" = "works"."id")
   OR EXISTS (SELECT 1 FROM "purchases" WHERE "purchases"."work_id" = "works"."id" AND "purchases"."status" = 'completed');
