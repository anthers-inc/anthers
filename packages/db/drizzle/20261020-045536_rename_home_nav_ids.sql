-- The three user tabs are Library, Network and Discovery (Parker, 2026-10-19). The
-- saved sidebar order still carries the retired ids `feed` and `discover`; a stored
-- order that keeps them names rows the nav no longer has, so the read must be
-- migrated rather than normalized per client. No schema change.
UPDATE "user_preferences"
SET "home_nav_order" = (
	SELECT jsonb_agg(
		CASE element
			WHEN '"feed"'::jsonb THEN '"network"'::jsonb
			WHEN '"discover"'::jsonb THEN '"discovery"'::jsonb
			ELSE element
		END
		ORDER BY ordinality
	)
	FROM jsonb_array_elements("home_nav_order") WITH ORDINALITY AS rows(element, ordinality)
)
WHERE "home_nav_order" IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text("home_nav_order") AS ids(id)
		WHERE ids.id IN ('feed', 'discover')
	);
