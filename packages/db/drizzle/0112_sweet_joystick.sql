-- Badge-model seeding constraint (Parker, 2026-10-02): one rung per threshold per issuer.
--
-- A Badge IS its threshold to the machinery — billing resolves a subscription item to
-- "the issuer's badge at this price" (`applyDirectedSupportFromSub` find-or-creates on
-- this key), the ladder seed (`ensureAnthersBadges`) is idempotent on it, and a viewer
-- holding two of an issuer's badges at one price would be two spellings of the same
-- purchase. Without a unique constraint those reads are ambiguous rather than merely
-- redundant; the dev session's first seed run is what surfaced it, as an `ON CONFLICT`
-- with no matching constraint.
CREATE UNIQUE INDEX "uq_badges_creator_threshold" ON "badges" USING btree ("creator_id","threshold");