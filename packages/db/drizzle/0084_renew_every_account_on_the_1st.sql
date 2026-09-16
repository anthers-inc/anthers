CREATE TABLE "support_reductions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"billing_cycle" text NOT NULL,
	"destination" text NOT NULL,
	"amount" numeric NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_invoice_id" text,
	"carried_from_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_reductions" ADD CONSTRAINT "support_reductions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_support_reductions_user_cycle" ON "support_reductions" USING btree ("user_id","billing_cycle");