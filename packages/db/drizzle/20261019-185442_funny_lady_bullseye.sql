ALTER TABLE "library_items" ADD COLUMN "post_id" integer;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_library_post" ON "library_items" USING btree ("user_id","post_id") WHERE "library_items"."post_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_library_post" ON "library_items" USING btree ("post_id");--> statement-breakpoint
-- A keep is a keep even in a rename: every bookmark becomes a Library entry before the
-- bookmark store goes. Order is inherited, so a shelf that was sorted stays sorted.
INSERT INTO "library_items" ("user_id", "post_id", "sort_order", "saved_at")
SELECT "user_id", "post_id", "sort_order", "created_at" FROM "bookmarks" WHERE "post_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "bookmarks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "bookmarks" CASCADE;--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "show_on_timeline";
