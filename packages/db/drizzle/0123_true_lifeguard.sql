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
ALTER TABLE "badges" ADD COLUMN "art_fingerprint" text;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "art_emblem_scale" numeric;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "art_emblem_offset_x" numeric;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "art_emblem_offset_y" numeric;--> statement-breakpoint
ALTER TABLE "badge_art_provenance" ADD CONSTRAINT "badge_art_provenance_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_badge_art_provenance_badge" ON "badge_art_provenance" USING btree ("badge_id");