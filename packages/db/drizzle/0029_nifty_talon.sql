-- Anthers Gates are retired (2026-08-12). A Work is now either gated by its creator —
-- a whole-Seed threshold in `seed_access` — or it is Public Access: ungated, streaming,
-- free to everyone. A Badge opens nothing. Reasoning: 30.01 § 4.1b.
--
-- `anthers_access` is NOT simply dropped, because it carried two different things:
--
--   * rows at threshold > 0  — the retired Badge gates. These genuinely go.
--   * the row at threshold 0 — the BASELINE, "everyone", which is where a Work's
--     free-to-all or buyable-by-all actually lived. Dropping it would strand the
--     catalogue's baseline and hard-gate every Work that used this table for it
--     (which is most of them: `defaultAnthersAccess()` wrote rows at 0,1,2,3,4).
--
-- So every *allowed* Anthers row collapses to threshold 0 at the cheapest price among
-- them, and merges with the existing threshold-0 Seed row, most permissive winning.
-- Disallowed rows contribute nothing — they never opened anything.
--
-- ⚠️ This is deliberately the WIDENING choice: a Work reachable only via a Badge gate
-- becomes reachable by everyone rather than hard-gated. The alternative silently removes
-- content that was reachable, and on such a Work the creator's intent was "a class of
-- supporters, not a sale" — with the class gone, "not gated by me" is the nearer reading.
-- The property worth having is that **no Work is newly locked out by this migration**.

--> statement-breakpoint
WITH anthers_baseline AS (
	-- The cheapest price among a Work's ALLOWED Anthers rows, at any threshold. NULL for
	-- a Work whose Anthers table opened nothing, which is then left entirely alone.
	SELECT
		w.id AS work_id,
		MIN(COALESCE((r->>'price')::numeric, 0)) AS price
	FROM works w
	CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.anthers_access, '[]'::jsonb)) AS r
	WHERE (r->>'allow')::boolean IS TRUE
	GROUP BY w.id
),
merged AS (
	SELECT
		w.id AS work_id,
		-- Most permissive baseline wins: an allowed row beats a locked one, and among
		-- allowed rows the cheaper price beats the dearer.
		jsonb_build_object(
			'threshold', 0,
			'allow', TRUE,
			'price', to_jsonb(
				LEAST(
					ab.price,
					COALESCE((
						SELECT MIN(COALESCE((s->>'price')::numeric, 0))
						FROM jsonb_array_elements(COALESCE(w.seed_access, '[]'::jsonb)) AS s
						WHERE (s->>'threshold')::int = 0 AND (s->>'allow')::boolean IS TRUE
					), ab.price)
				)::text
			)
		) AS baseline,
		-- Every Seed row that is NOT the baseline keeps its own threshold, allow and price.
		COALESCE((
			SELECT jsonb_agg(s)
			FROM jsonb_array_elements(COALESCE(w.seed_access, '[]'::jsonb)) AS s
			WHERE (s->>'threshold')::int <> 0
		), '[]'::jsonb) AS ladder
	FROM works w
	JOIN anthers_baseline ab ON ab.work_id = w.id
)
UPDATE works w
SET seed_access = jsonb_build_array(merged.baseline) || merged.ladder
FROM merged
WHERE merged.work_id = w.id;
--> statement-breakpoint
-- A Work whose Anthers table opened nothing still needs a baseline row to exist, or it
-- has no row at threshold 0 at all and `openToEveryone` has nothing to read.
UPDATE works
SET seed_access = COALESCE(seed_access, '[]'::jsonb) || jsonb_build_array(
	jsonb_build_object('threshold', 0, 'allow', FALSE, 'price', '0')
)
WHERE NOT EXISTS (
	SELECT 1 FROM jsonb_array_elements(COALESCE(seed_access, '[]'::jsonb)) AS s
	WHERE (s->>'threshold')::int = 0
);
--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN "anthers_access";
