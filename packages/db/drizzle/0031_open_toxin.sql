-- pool_distributions: cascade → SET NULL on both user references.
--
-- This row is a PAYMENT record, not a viewing one. 51.05 names it as the single thing
-- that survives account deletion — "a per-month total of how much time you spent with
-- each creator you supported" — and a cascade on both sides destroyed it.
--
-- The creator side was the worse half. A creator closing their account erased the payout
-- records of everyone who had funded them: third parties' financial records, deleted by
-- someone else's action, with nothing in the deletion flow mentioning it.
--
-- SET NULL matches purchases.buyer_id, settled 2026-08-10 on the same reasoning: the
-- person comes off the record and the record stays. Erasure runs to personal data and is
-- satisfied by severing the identity link rather than destroying the artifact.
--
-- Safe on the unique index uq_pool_dist_sub_creator_cycle (subscriber, creator, cycle):
-- Postgres treats NULLs as distinct, so nulled rows cannot collide with each other, and a
-- deleted account generates no further distributions to conflict with.
--
-- ⚠️ Readers must LEFT join users on either side now. An inner join silently drops the
-- surviving row, which would make "the record survives" true in the database and false to
-- the person reading their own history.

ALTER TABLE "pool_distributions" DROP CONSTRAINT "pool_distributions_subscriber_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "pool_distributions" DROP CONSTRAINT "pool_distributions_creator_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "pool_distributions" ALTER COLUMN "subscriber_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pool_distributions" ALTER COLUMN "creator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pool_distributions" ADD CONSTRAINT "pool_distributions_subscriber_id_users_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_distributions" ADD CONSTRAINT "pool_distributions_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;