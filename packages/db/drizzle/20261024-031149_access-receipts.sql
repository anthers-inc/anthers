CREATE TABLE "access_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer NOT NULL,
	"kind" text NOT NULL,
	"receipt_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"space_uri" text,
	"last_error" text,
	"written_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_receipts" ADD CONSTRAINT "access_receipts_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_access_receipts_purchase_kind" ON "access_receipts" USING btree ("purchase_id","kind");--> statement-breakpoint
CREATE INDEX "idx_access_receipts_state" ON "access_receipts" USING btree ("state");