-- Retire the Seed as a financial unit: every stored amount and threshold becomes dollars.
--
-- Hand-written rather than generated, because three of the four steps are DATA migrations
-- that drizzle-kit cannot infer — and one of them rewrites inside a jsonb column.
--
-- The conversion is a clean × 3 everywhere: a Seed was an indivisible $3, so a threshold
-- of `n` Seeds is exactly `$3n`. Nothing is newly gated and nothing is newly opened; every
-- viewer who cleared a gate before clears the same gate after.

--> statement-breakpoint
-- 1. accounts: a Seed COUNT becomes monthly dollars.
ALTER TABLE "accounts" ADD COLUMN "anthers_support" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
UPDATE "accounts" SET "anthers_support" = ("anthers_seeds" * 3)::numeric;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "anthers_seeds";--> statement-breakpoint
ALTER TABLE "accounts" RENAME COLUMN "creator_seed_total" TO "creator_support_total";--> statement-breakpoint

-- 2. account_cycles: TWO columns collapse into one.
--
-- 🚨 The backfill reads `anthers_spend`, NOT `anthers_seeds * 3`, and the difference is
-- the point. They agree today by construction, but `anthers_spend` is what was actually
-- charged and the count is a description of it — so if a historical row ever disagreed,
-- the money is the fact and the count is the error. Carrying both is exactly the defect
-- this whole change is about: two descriptions of one thing, free to drift.
ALTER TABLE "account_cycles" ADD COLUMN "anthers_support" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
UPDATE "account_cycles" SET "anthers_support" = "anthers_spend";--> statement-breakpoint
ALTER TABLE "account_cycles" DROP COLUMN "anthers_seeds";--> statement-breakpoint
ALTER TABLE "account_cycles" DROP COLUMN "anthers_spend";--> statement-breakpoint
ALTER TABLE "account_cycles" RENAME COLUMN "creator_seed_total" TO "creator_support_total";--> statement-breakpoint

-- 3. creator_gates: named rungs, whole Seeds -> dollars.
UPDATE "creator_gates" SET "threshold" = "threshold" * 3;--> statement-breakpoint

-- 4. works.seed_access: the access table itself, inside jsonb.
--
-- `WITH ORDINALITY` + `ORDER BY` keeps the rows in their original order. Access resolution
-- picks the cheapest qualifying row and so does not depend on order, but a silently
-- reshuffled array is the kind of thing that makes a later diff unreadable.
--
-- Guarded on `jsonb_array_length(...) > 0` because `jsonb_agg` over an empty set returns
-- NULL, which would turn every ungated Work's empty table into a null one — and a null
-- access table is not the same object as an empty one to the code that reads it.
UPDATE "works"
SET "seed_access" = (
	SELECT jsonb_agg(
		jsonb_set(elem, '{threshold}', to_jsonb(((elem->>'threshold')::numeric) * 3))
		ORDER BY ord
	)
	FROM jsonb_array_elements("works"."seed_access") WITH ORDINALITY AS t(elem, ord)
)
WHERE "seed_access" IS NOT NULL AND jsonb_array_length("seed_access") > 0;

--> statement-breakpoint
-- 5. A Stripe Product per destination, so an invoice line can name who it is for.
--
-- The subscription carried ONE item at a shared $3 Seed price with `quantity` = the total,
-- and the Anthers/creator split rode in metadata. Arbitrary amounts end that: the
-- subscription now carries one item per destination, each priced with inline `price_data`.
-- `price_data` takes a Product **id**, not a name, so each creator needs a durable Product
-- for their line to read "Support for @handle" rather than repeating one shared label.
--
-- Nullable and lazily filled: a creator who has never been supported needs no Product, and
-- creating one eagerly for every account would make signup depend on Stripe being up.
ALTER TABLE "accounts" ADD COLUMN "stripe_product_id" text DEFAULT '';
