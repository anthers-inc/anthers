ALTER TABLE "works" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill the fulfillment details from the metadata bag before the bag goes. `note` was
-- the only live key in it; `clientVariants` was the retired client-transcode transport's
-- storage keys, and production holds no Work carrying one.
UPDATE "works" SET "note" = "metadata"->>'note' WHERE "metadata"->>'note' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN "metadata";
