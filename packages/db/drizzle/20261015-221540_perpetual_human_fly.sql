CREATE TABLE "badge_charges" (
	"id" serial PRIMARY KEY NOT NULL,
	"buyer_id" integer,
	"badge_id" integer,
	"creator_id" integer,
	"badge_label" text,
	"threshold" numeric NOT NULL,
	"charged_amount" numeric NOT NULL,
	"processing_fee" numeric NOT NULL,
	"sales_tax" numeric DEFAULT '0.00' NOT NULL,
	"billing_cycle" text NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_basket_items_user_work";--> statement-breakpoint
ALTER TABLE "basket_items" ALTER COLUMN "work_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "basket_items" ADD COLUMN "badge_id" integer;--> statement-breakpoint
ALTER TABLE "badge_charges" ADD CONSTRAINT "badge_charges_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_charges" ADD CONSTRAINT "badge_charges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_charges" ADD CONSTRAINT "badge_charges_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_badge_charges_buyer" ON "badge_charges" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "idx_badge_charges_cycle" ON "badge_charges" USING btree ("billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_badge_charges_intent" ON "badge_charges" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
ALTER TABLE "basket_items" ADD CONSTRAINT "basket_items_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_basket_items_user_badge" ON "basket_items" USING btree ("user_id","badge_id") WHERE "basket_items"."badge_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_basket_items_badge" ON "basket_items" USING btree ("badge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_basket_items_user_work" ON "basket_items" USING btree ("user_id","work_id") WHERE "basket_items"."work_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "basket_items" ADD CONSTRAINT "basket_items_exactly_one_kind" CHECK (("basket_items"."work_id" IS NOT NULL) <> ("basket_items"."badge_id" IS NOT NULL));