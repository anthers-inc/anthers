DROP INDEX "uq_merch_variants_work_size";--> statement-breakpoint
ALTER TABLE "merch_variants" ADD COLUMN "color" text NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_variants" ADD COLUMN "sync_variant_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_merch_variants_work_color_size" ON "merch_variants" USING btree ("work_id","color","size");