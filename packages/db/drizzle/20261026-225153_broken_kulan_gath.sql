CREATE TABLE "shipment_complaints" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer,
	"buyer_id" integer,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipment_complaints" ADD CONSTRAINT "shipment_complaints_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_complaints" ADD CONSTRAINT "shipment_complaints_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shipment_complaints_open" ON "shipment_complaints" USING btree ("purchase_id") WHERE "shipment_complaints"."status" = 'open';--> statement-breakpoint
CREATE INDEX "idx_shipment_complaints_purchase" ON "shipment_complaints" USING btree ("purchase_id");