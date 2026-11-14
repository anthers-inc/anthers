CREATE TABLE "purchase_splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer NOT NULL,
	"creator_id" integer,
	"amount" numeric NOT NULL,
	"stripe_transfer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_creator_nettings_refund";--> statement-breakpoint
DROP INDEX "uq_creator_nettings_dispute";--> statement-breakpoint
DROP INDEX "uq_creator_credits_purchase";--> statement-breakpoint
ALTER TABLE "purchase_splits" ADD CONSTRAINT "purchase_splits_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_splits" ADD CONSTRAINT "purchase_splits_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_purchase_splits_purchase_creator" ON "purchase_splits" USING btree ("purchase_id","creator_id");--> statement-breakpoint
CREATE INDEX "idx_purchase_splits_creator_transfer" ON "purchase_splits" USING btree ("creator_id","stripe_transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_nettings_refund" ON "creator_nettings" USING btree ("stripe_refund_id","purchase_id","creator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_nettings_dispute" ON "creator_nettings" USING btree ("dispute_id","creator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_credits_purchase" ON "creator_credits" USING btree ("purchase_id","creator_id") WHERE "creator_credits"."purchase_id" IS NOT NULL;