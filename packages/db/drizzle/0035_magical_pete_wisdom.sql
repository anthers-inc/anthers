CREATE TABLE "library_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"work_id" integer,
	"project_id" integer,
	"hidden" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_library_user" ON "library_items" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_library_work" ON "library_items" USING btree ("user_id","work_id") WHERE "library_items"."work_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_library_project" ON "library_items" USING btree ("user_id","project_id") WHERE "library_items"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_library_work" ON "library_items" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "idx_library_project" ON "library_items" USING btree ("project_id");--> statement-breakpoint
-- ── Backfill: everything that was already "yours" becomes a shelf entry ──────────
--
-- Every completed Work purchase. `DISTINCT ON` because a Work can legitimately be
-- bought twice (buy, refund, buy again) and the shelf holds it once; the earliest
-- purchase date is kept, since that is when it first became yours.
--
-- Note `library_items` records no "this was purchased" flag: permanence is derived by
-- joining `purchases`, so a later refund releases the row with no sweep and nothing to
-- keep in step. See the table's doc comment.
INSERT INTO "library_items" ("user_id", "work_id", "saved_at")
SELECT DISTINCT ON (p."buyer_id", p."work_id")
	p."buyer_id", p."work_id", p."created_at"
FROM "purchases" p
WHERE p."work_id" IS NOT NULL
	-- `buyer_id` is nullable and goes NULL when an account is deleted: a purchase
	-- outlives its buyer, deliberately, so the financial record survives. A shelf
	-- belonging to nobody is meaningless, so those rows are skipped rather than
	-- forced. The NOT NULL constraint caught this on the first run.
	AND p."buyer_id" IS NOT NULL
	AND p."status" = 'completed'
	AND p."type" <> 'seeds'
ORDER BY p."buyer_id", p."work_id", p."created_at" ASC
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Work bookmarks MOVE to the Library — the same intent, now with a home that matches it.
INSERT INTO "library_items" ("user_id", "work_id", "sort_order", "saved_at")
SELECT b."user_id", b."work_id", b."sort_order", b."created_at"
FROM "bookmarks" b
WHERE b."work_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "library_items" ("user_id", "project_id", "sort_order", "saved_at")
SELECT b."user_id", b."project_id", b."sort_order", b."created_at"
FROM "bookmarks" b
WHERE b."project_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- A MOVE, not a deletion: the rows above are already in place before this runs.
--
-- ⚠️ Creator bookmarks are deliberately LEFT ALONE. "Follow" is the verb for a creator
-- now, but converting a private bookmark into a follow would change a public-facing
-- relationship — it moves a creator's follower count — on behalf of a user who never
-- asked. Retiring those is a product decision with a person on the other end of it, not
-- a data migration.
DELETE FROM "bookmarks" WHERE "work_id" IS NOT NULL OR "project_id" IS NOT NULL;
