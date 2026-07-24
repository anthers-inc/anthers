CREATE TABLE "post_edits" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_edits" ADD CONSTRAINT "post_edits_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_post_edits_post" ON "post_edits" USING btree ("post_id","edited_at");