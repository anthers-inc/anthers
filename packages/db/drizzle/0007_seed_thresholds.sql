-- Badge/gate thresholds become WHOLE SEEDS everywhere.
--
-- Pure data migration: no DDL. The two access tables are jsonb, so Postgres never
-- enforced their row shape and drizzle-kit generates nothing for a change of shape
-- *inside* the document. This file is the change.
--
-- Three conversions, all lossless:
--
--   1. posts.anthers_access[].tier (a NAME) -> .threshold (whole Anthers-Seeds).
--      free 0 / root 1 / sprout 2 / petal 3 / blossom 4. A name conflated the Badge
--      with the level it sits at; they are different things, and a gate may sit at a
--      level no Badge occupies.
--   2. posts.seed_access[].threshold: DOLLARS -> whole Seeds (/ 3).
--   3. creator_gates.threshold for gate_type='seed': DOLLARS -> whole Seeds (/ 3).
--      anthers_badge rungs already counted Seeds and are left alone.
--
-- Seeds have been indivisible $3 units since #123, so every stored dollar threshold is
-- a multiple of 3 and / 3 is exact. Any legacy row that is NOT a multiple of 3 is
-- rounded UP (ceil), never down: rounding down would quietly grant access at a level
-- the creator did not open. A stricter gate is a visible bug; a looser one is a silent one.
--
-- Unrecognised tier names collapse to threshold 0 rather than erroring the deploy. That
-- is the safe direction only because these rows carry `allow` independently — a row that
-- was locked stays locked, so a bad name cannot open anything by itself.

-- 1. Anthers access table: tier name -> whole-Seed threshold.
UPDATE "posts"
SET "anthers_access" = (
	SELECT jsonb_agg(
		jsonb_build_object(
			'threshold', CASE row->>'tier'
				WHEN 'free' THEN 0
				WHEN 'root' THEN 1
				WHEN 'sprout' THEN 2
				WHEN 'petal' THEN 3
				WHEN 'blossom' THEN 4
				ELSE 0
			END,
			'allow', COALESCE((row->>'allow')::boolean, false),
			'price', COALESCE(row->>'price', '0')
		)
		ORDER BY ordinality
	)
	FROM jsonb_array_elements("anthers_access") WITH ORDINALITY AS t(row, ordinality)
)
WHERE "anthers_access" IS NOT NULL
	AND jsonb_typeof("anthers_access") = 'array'
	AND jsonb_array_length("anthers_access") > 0
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements("anthers_access") AS e
		WHERE e ? 'tier'
	);
--> statement-breakpoint

-- 2. Seed access table: dollars -> whole Seeds.
UPDATE "posts"
SET "seed_access" = (
	SELECT jsonb_agg(
		jsonb_build_object(
			'threshold', CEIL(COALESCE((row->>'threshold')::numeric, 0) / 3)::int,
			'allow', COALESCE((row->>'allow')::boolean, false),
			'price', COALESCE(row->>'price', '0')
		)
		ORDER BY ordinality
	)
	FROM jsonb_array_elements("seed_access") WITH ORDINALITY AS t(row, ordinality)
)
WHERE "seed_access" IS NOT NULL
	AND jsonb_typeof("seed_access") = 'array'
	AND jsonb_array_length("seed_access") > 0;
--> statement-breakpoint

-- 3. Creator gate ladder: the seed rungs' dollars -> whole Seeds.
UPDATE "creator_gates"
SET "threshold" = CEIL("threshold"::numeric / 3)::int
WHERE "gate_type" = 'seed';
