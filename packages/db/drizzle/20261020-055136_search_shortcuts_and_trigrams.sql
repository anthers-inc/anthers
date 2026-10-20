-- The topbar search: the account's two shortcuts, and the trigram indexes both passes use.
--
-- `pg_trgm` is an extension, not a Drizzle schema object, so the index half is
-- hand-written and travels in this generated migration rather than in a second file with
-- no snapshot. The schema half is the column Drizzle saw.
--
-- The two passes search different columns, so the indexes are per column rather than one
-- over a concatenation: a predicate restricted to a title must be able to use the title's
-- index, and a concatenated expression index would not serve it. `gin_trgm_ops` supports
-- `ILIKE '%term%'` directly, which is exactly the containment match the route builds.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "search_shortcuts" jsonb;--> statement-breakpoint
CREATE INDEX "idx_users_display_name_trgm" ON "users" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_users_handle_trgm" ON "users" USING gin ("atproto_handle" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_users_bio_trgm" ON "users" USING gin ("bio" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_works_title_trgm" ON "works" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_works_description_trgm" ON "works" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_projects_title_trgm" ON "projects" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_projects_description_trgm" ON "projects" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_posts_title_trgm" ON "posts" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_posts_body_trgm" ON "posts" USING gin ("body" gin_trgm_ops);
