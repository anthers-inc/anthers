DROP INDEX "idx_works_catalog";--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "originally_released" timestamp with time zone;--> statement-breakpoint
UPDATE "works" SET "originally_released" = "authored_at";--> statement-breakpoint
CREATE INDEX "idx_works_catalog" ON "works" USING btree ("creator_id","visibility","originally_released");--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN "authored_at";--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN "authored_precision";