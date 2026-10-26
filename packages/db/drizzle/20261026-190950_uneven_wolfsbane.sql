CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer,
	"carrier" text,
	"carrier_name" text,
	"tracking_number" text,
	"tracking_url" text,
	"handling_business_days" integer NOT NULL,
	"ship_by_at" timestamp with time zone NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivery_source" text,
	"complaint_window_ends_at" timestamp with time zone,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shipments_purchase" ON "shipments" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "idx_shipments_pending_delivery" ON "shipments" USING btree ("delivered_at","shipped_at");