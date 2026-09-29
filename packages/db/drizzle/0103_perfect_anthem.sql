ALTER TABLE "purchases" ADD COLUMN "buyer_country" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "buyer_state" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "buyer_postal_code" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "buyer_address_line1" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "buyer_address_line2" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "buyer_city" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "stripe_product_tax_code" text DEFAULT '';