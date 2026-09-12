-- Renames rather than drop-and-create. The generator's first draft was
-- `DROP TABLE "ratings" CASCADE` beside a fresh `CREATE TABLE "reviews"`, which reaches the
-- same schema and destroys every row on the way. This preserves them.
--
-- `work_rating_appeals` is deliberately untouched: it is an appeal against a Work's MATURITY
-- rating, which is a different concept that happens to share a word.

ALTER TABLE "ratings" RENAME TO "reviews";--> statement-breakpoint
ALTER TABLE "reviews" RENAME CONSTRAINT "ratings_pkey" TO "reviews_pkey";--> statement-breakpoint
ALTER TABLE "reviews" RENAME CONSTRAINT "ratings_atproto_uri_unique" TO "reviews_atproto_uri_unique";--> statement-breakpoint
ALTER TABLE "reviews" RENAME CONSTRAINT "ratings_user_id_users_id_fk" TO "reviews_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "reviews" RENAME CONSTRAINT "ratings_work_id_works_id_fk" TO "reviews_work_id_works_id_fk";--> statement-breakpoint
ALTER INDEX "uq_ratings_user_work" RENAME TO "uq_reviews_user_work";--> statement-breakpoint
ALTER INDEX "idx_ratings_work_visible" RENAME TO "idx_reviews_work_visible";--> statement-breakpoint
ALTER SEQUENCE "ratings_id_seq" RENAME TO "reviews_id_seq";--> statement-breakpoint

ALTER TABLE "reactions" RENAME TO "votes";--> statement-breakpoint
ALTER TABLE "votes" RENAME CONSTRAINT "reactions_pkey" TO "votes_pkey";--> statement-breakpoint
ALTER TABLE "votes" RENAME CONSTRAINT "reactions_user_id_users_id_fk" TO "votes_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "uq_reactions_user_subject" RENAME TO "uq_votes_user_subject";--> statement-breakpoint
ALTER INDEX "idx_reactions_subject" RENAME TO "idx_votes_subject";--> statement-breakpoint
ALTER SEQUENCE "reactions_id_seq" RENAME TO "votes_id_seq";--> statement-breakpoint

-- The column carried +1/-1 and now carries the direction the record publishes. Converted in
-- place with an explicit mapping rather than dropped and re-added, so any existing vote
-- survives with its meaning intact. Anything that is neither becomes NULL and then fails the
-- NOT NULL, which is the right way for an unexpected value to surface.
ALTER TABLE "votes" RENAME COLUMN "value" TO "direction";--> statement-breakpoint
ALTER TABLE "votes" ALTER COLUMN "direction" SET DATA TYPE text USING (
	CASE "direction" WHEN 1 THEN 'up' WHEN -1 THEN 'down' END
);--> statement-breakpoint

-- A report names what it is about, and one of those names changed with the table.
UPDATE "moderation_reports" SET "subject_type" = 'review' WHERE "subject_type" = 'rating';
