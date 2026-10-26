ALTER TABLE "creator_credits" ADD COLUMN "purchase_id" integer;--> statement-breakpoint
ALTER TABLE "creator_credits" ADD CONSTRAINT "creator_credits_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_creator_credits_purchase" ON "creator_credits" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_credits_purchase" ON "creator_credits" USING btree ("purchase_id") WHERE "creator_credits"."purchase_id" IS NOT NULL;