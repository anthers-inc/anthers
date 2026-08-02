--==========================================================================
-- 0011 — time (attention) events attach to a Work, not a post
--
-- 40.05 already said only content entities earn Time Pool minutes, and that
-- post bodies, project pages, profiles and comments earn nothing. That was a
-- policy the endpoint enforced against a schema which could not express it:
-- the column said `post_id`, so the rule lived entirely in a filter a future
-- reader could quietly drop. Now the column says what the model says.
--
-- Hand-written to preserve history: the generated version drops `post_id`
-- before anything reads it, discarding every existing event's attribution.
--==========================================================================

ALTER TABLE "attention_events" ADD COLUMN "work_id" integer;--> statement-breakpoint

-- Re-attribute existing events to the Work their post carried. Where a post
-- linked several, take the first by position — the same choice `0010` made for
-- purchases, and for the same reason: one row cannot be split across many.
-- Events whose post linked nothing were credited to connective tissue under the
-- old rules and are left null, which is what they should have been all along.
UPDATE "attention_events" ae
SET "work_id" = src."work_id"
FROM (
	SELECT DISTINCT ON (r."post_id") r."post_id", r."work_id"
	FROM "post_work_refs" r ORDER BY r."post_id", r."position", r."id"
) src
WHERE ae."post_id" = src."post_id";--> statement-breakpoint

ALTER TABLE "attention_events" DROP CONSTRAINT "attention_events_post_id_posts_id_fk";--> statement-breakpoint
ALTER TABLE "attention_events" ADD CONSTRAINT "attention_events_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_events" DROP COLUMN "post_id";
