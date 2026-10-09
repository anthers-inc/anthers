CREATE TABLE "merch_fulfillments" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer,
	"printful_order_id" integer,
	"printful_status" text,
	"placed_at" timestamp with time zone,
	"placement_error" text,
	"placement_attempts" integer DEFAULT 0 NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tracking_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merch_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"size" text NOT NULL,
	"catalog_variant_id" integer NOT NULL,
	"catalog_variant_name" text NOT NULL,
	"catalog_price" numeric NOT NULL,
	"list_price" numeric NOT NULL,
	"print_file_url" text NOT NULL,
	"synced" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_name" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_address_line1" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_address_line2" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_city" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_state" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_postal_code" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_country" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "printful_costs" jsonb;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "merch_size" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "merch_discount_badge" text;--> statement-breakpoint
ALTER TABLE "merch_fulfillments" ADD CONSTRAINT "merch_fulfillments_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_variants" ADD CONSTRAINT "merch_variants_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_merch_fulfillments_purchase" ON "merch_fulfillments" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "idx_merch_fulfillments_order" ON "merch_fulfillments" USING btree ("printful_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_merch_variants_work_size" ON "merch_variants" USING btree ("work_id","size");--> statement-breakpoint
CREATE INDEX "idx_merch_variants_work" ON "merch_variants" USING btree ("work_id");