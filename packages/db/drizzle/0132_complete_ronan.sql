ALTER TABLE "merch_fulfillments" ALTER COLUMN "printful_order_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "merch_variants" ALTER COLUMN "catalog_variant_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "merch_variants" ALTER COLUMN "sync_variant_id" SET DATA TYPE bigint;