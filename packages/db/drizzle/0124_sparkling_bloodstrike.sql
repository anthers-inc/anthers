CREATE TABLE "badge_art_provenance" (
	"id" serial PRIMARY KEY NOT NULL,
	"badge_id" integer NOT NULL,
	"noun_icon_id" text NOT NULL,
	"term" text,
	"artist_name" text NOT NULL,
	"artist_permalink" text,
	"license_description" text NOT NULL,
	"attribution" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "noun_blocklist" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	"added_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "noun_spend" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"day" text NOT NULL,
	"icon_calls" integer DEFAULT 0 NOT NULL,
	"service_calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "art_fingerprint" text;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "art_emblem_scale" numeric;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "art_emblem_offset_x" numeric;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "art_emblem_offset_y" numeric;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "stripe_product_id" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "stripe_product_tax_code" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "badge_art_provenance" ADD CONSTRAINT "badge_art_provenance_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_perks" ADD CONSTRAINT "badge_perks_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "noun_spend" ADD CONSTRAINT "noun_spend_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_badge_art_provenance_badge" ON "badge_art_provenance" USING btree ("badge_id");--> statement-breakpoint
CREATE INDEX "idx_badge_perks_badge" ON "badge_perks" USING btree ("badge_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_noun_blocklist_kind_value" ON "noun_blocklist" USING btree ("kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_noun_spend_creator_day" ON "noun_spend" USING btree ("creator_id","day");--> statement-breakpoint
ALTER TABLE "badges" DROP COLUMN "art_emblem";