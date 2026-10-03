CREATE TABLE "disputes" (
	"id" serial PRIMARY KEY NOT NULL,
	"stripe_dispute_id" text NOT NULL,
	"stripe_charge_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"amount" numeric NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"purchase_id" integer,
	"invoice_id" integer,
	"user_id" integer,
	"evidence_due_by" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_stripe_dispute_id_unique" UNIQUE("stripe_dispute_id")
);
--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_disputes_purchase" ON "disputes" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "idx_disputes_invoice" ON "disputes" USING btree ("invoice_id");