-- A review carries a verdict rather than a score. Converted in place rather than
-- added-and-dropped: the generator's draft was `ADD COLUMN "verdict" text NOT NULL` beside
-- `DROP COLUMN "score"`, which cannot even apply to a non-empty table and would discard
-- every review if it could.
--
-- ⚠️ The midpoint is a judgment and it is only ever applied to pre-launch rows. On a 1–5
-- scale there is no honest answer for a 3, so this reads 4 and 5 as a recommendation and
-- everything below as its absence. Every row in the development database is a 4, so nothing
-- currently depends on where the line falls — and once this has run, no path produces a
-- score again.

ALTER TABLE "reviews" RENAME COLUMN "score" TO "verdict";--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "verdict" SET DATA TYPE text USING (
	CASE WHEN "verdict" >= 4 THEN 'recommended' ELSE 'not-recommended' END
);
