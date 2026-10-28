ALTER TABLE "badges" ADD COLUMN "perks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Fold each rung's perk rows into its own array before the table goes, in the creator's
-- saved order. The row id and timestamps nothing read do not travel.
UPDATE "badges" SET "perks" = COALESCE((
	SELECT jsonb_agg(jsonb_build_object('kind', p."kind", 'label', p."label") ORDER BY p."sort_order")
	FROM "badge_perks" p
	WHERE p."badge_id" = "badges"."id"
), '[]'::jsonb);--> statement-breakpoint
DROP TABLE "badge_perks" CASCADE;
