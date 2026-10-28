ALTER TABLE "work_pages" ADD COLUMN "panels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Fold each page's proposal rows into its own array before the table goes. Panel number is
-- the reading order; `auto` carries through so a detected proposal is still a proposal.
UPDATE "work_pages" SET "panels" = COALESCE((
	SELECT jsonb_agg(jsonb_build_object(
		'panelNumber', p."panel_number",
		'x', p."x",
		'y', p."y",
		'width', p."width",
		'height', p."height",
		'auto', p."auto"
	) ORDER BY p."panel_number")
	FROM "work_panels" p
	WHERE p."page_id" = "work_pages"."id"
), '[]'::jsonb);--> statement-breakpoint
DROP TABLE "work_panels" CASCADE;
