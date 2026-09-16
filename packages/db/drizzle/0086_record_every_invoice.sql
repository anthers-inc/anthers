CREATE TABLE "creator_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer,
	"subscriber_id" integer,
	"billing_cycle" text NOT NULL,
	"kind" text NOT NULL,
	"funded_by" text NOT NULL,
	"amount" numeric NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"creator_id" integer,
	"amount" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"stripe_invoice_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"billing_cycle" text NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"subtotal" numeric NOT NULL,
	"discount" numeric DEFAULT '0.00' NOT NULL,
	"tax" numeric DEFAULT '0.00' NOT NULL,
	"total" numeric NOT NULL,
	"processing_fee" numeric DEFAULT '0.00' NOT NULL,
	"settled_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "month_settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"billing_cycle" text NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_settlements_billing_cycle_unique" UNIQUE("billing_cycle")
);
--> statement-breakpoint
ALTER TABLE "pool_distributions" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_credits" ADD CONSTRAINT "creator_credits_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_credits" ADD CONSTRAINT "creator_credits_subscriber_id_users_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_creator_credits_creator_settled" ON "creator_credits" USING btree ("creator_id","settled_at");--> statement-breakpoint
CREATE INDEX "idx_creator_credits_subscriber_cycle" ON "creator_credits" USING btree ("subscriber_id","billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_invoice_lines_invoice" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_cycle_settled" ON "invoices" USING btree ("billing_cycle","settled_at");--> statement-breakpoint
CREATE INDEX "idx_invoices_user" ON "invoices" USING btree ("user_id");