--==========================================================================
-- 0012 — comments go polymorphic; reviews attach to a Work
--
-- Comments take the `(subject_type, subject_id)` shape `moderation_reports`
-- and `moderation_actions` already use, so a Work finally has somewhere for
-- anyone to say anything — under the old model a Work could be released,
-- consumed and paid for with nowhere to discuss it.
--
-- Reviews do NOT become polymorphic, deliberately. A review is "a reader's
-- verdict on a work" (63.01), and 40.06 makes reviews floor-level moderation
-- precisely because "a creator moderating reviews of their own work is the
-- conflict reviews exist to avoid". Both sentences are about works; reviewing
-- an announcement is a category error the schema shouldn't invite.
--
-- Hand-written: the generated version adds the new columns and drops post_id
-- without ever reading it, which silently orphans every existing comment
-- (subject_id would be 0) and every review.
--==========================================================================

-- ── Comments: post_id becomes (subject_type, subject_id) ──────────────────
ALTER TABLE "comments" ADD COLUMN "subject_type" text DEFAULT 'post' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "subject_id" integer;--> statement-breakpoint
UPDATE "comments" SET "subject_type" = 'post', "subject_id" = "post_id";--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "subject_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "comments" DROP CONSTRAINT "comments_post_id_posts_id_fk";--> statement-breakpoint
DROP INDEX "idx_comments_post_visible";--> statement-breakpoint
CREATE INDEX "idx_comments_subject_visible" ON "comments" USING btree ("subject_type","subject_id","moderation_status");--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN "post_id";--> statement-breakpoint

-- ── Reviews: post_id becomes work_id ──────────────────────────────────────
ALTER TABLE "ratings" ADD COLUMN "work_id" integer;--> statement-breakpoint

-- Move each review to the Work its post carried. Where a post linked several,
-- take the first by position — the same choice `0010` made for purchases and
-- `0011` for time events, for the same reason: one row cannot be split.
UPDATE "ratings" r
SET "work_id" = src."work_id"
FROM (
	SELECT DISTINCT ON (w."post_id") w."post_id", w."work_id"
	FROM "post_work_refs" w ORDER BY w."post_id", w."position", w."id"
) src
WHERE r."post_id" = src."post_id";--> statement-breakpoint

-- Reviews left on body-only posts have no Work to move to. They are KEPT with a
-- null work_id rather than deleted: nothing reads them and no new write can
-- produce one, but destroying somebody's written words to fit a schema change is
-- the thing this codebase refuses to do everywhere else. If they are ever to go,
-- that should be a decision someone makes, not a side effect of this file.
--
-- A duplicate pair is possible in principle — one user reviewing two posts that
-- carried the SAME Work — so keep the earliest and null the rest before the
-- unique index goes on, rather than letting the migration fail on real data.
UPDATE "ratings" r
SET "work_id" = NULL
WHERE r."work_id" IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM "ratings" o
		WHERE o."user_id" = r."user_id" AND o."work_id" = r."work_id" AND o."id" < r."id"
	);--> statement-breakpoint

ALTER TABLE "ratings" DROP CONSTRAINT "ratings_post_id_posts_id_fk";--> statement-breakpoint
DROP INDEX "uq_ratings_user_post";--> statement-breakpoint
DROP INDEX "idx_ratings_post_visible";--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ratings_user_work" ON "ratings" USING btree ("user_id","work_id");--> statement-breakpoint
CREATE INDEX "idx_ratings_work_visible" ON "ratings" USING btree ("work_id","moderation_status");--> statement-breakpoint
ALTER TABLE "ratings" DROP COLUMN "post_id";
