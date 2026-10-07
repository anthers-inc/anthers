CREATE TABLE "badge_perks" (
	"id" serial PRIMARY KEY NOT NULL,
	"badge_id" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '',
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "stripe_product_id" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "stripe_product_tax_code" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "badge_perks" ADD CONSTRAINT "badge_perks_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_badge_perks_badge" ON "badge_perks" USING btree ("badge_id","sort_order");