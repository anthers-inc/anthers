DROP TABLE "merch_fulfillments" CASCADE;--> statement-breakpoint
DROP TABLE "merch_variants" CASCADE;--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "shipping_name";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "shipping_address_line1";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "shipping_address_line2";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "shipping_city";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "shipping_state";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "shipping_postal_code";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "shipping_country";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "printful_costs";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "merch_size";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "merch_discount_badge";