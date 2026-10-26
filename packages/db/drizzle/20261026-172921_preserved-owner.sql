-- ⭐ The preservation flag means *somebody other than the creator* kept the Work.
-- `preserveCurrentVersion` now carries the keeper and refuses a creator's own save, but the
-- 20261025-205051 backfill marked every Work on any Library shelf, and a creator's own draft
-- has a shelf entry too. A draft left flagged would be undeletable: both disposal doors now
-- ask this flag, and a flagged Work is withdrawn rather than destroyed.
--
-- ⚠️ **Private Works are the provable case, so they are the only ones cleared.** A Work that
-- was ever released may have been kept by a reader whose Library row has since cascaded away
-- with their account, and the program's write is one-way — a released Work that nobody's
-- surviving row names keeps its flag, which fails toward keeping bytes rather than destroying
-- them. A private Work with no other keeper and no sale can only have been flagged by its own
-- creator.
UPDATE "works" SET "preserved" = false
WHERE "visibility" = 'private'
  AND "preserved" = true
  AND NOT EXISTS (
    SELECT 1 FROM "library_items"
    WHERE "library_items"."work_id" = "works"."id"
      AND "library_items"."user_id" IS DISTINCT FROM "works"."creator_id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "purchases"
    WHERE "purchases"."work_id" = "works"."id"
      AND "purchases"."status" = 'completed'
  );--> statement-breakpoint

-- The archived versions follow the Works that left the program: 20261025-221950 copied the
-- Work's flag onto every version of it, and a version of a draft nobody else kept is not kept
-- either.
UPDATE "work_media_versions" SET "preserved" = false
WHERE "preserved" = true
  AND NOT EXISTS (
    SELECT 1 FROM "library_items"
    WHERE "library_items"."work_id" = "work_media_versions"."work_id"
      AND "library_items"."user_id" IS DISTINCT FROM (
        SELECT "creator_id" FROM "works" WHERE "works"."id" = "work_media_versions"."work_id"
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "purchases"
    WHERE "purchases"."work_id" = "work_media_versions"."work_id"
      AND "purchases"."status" = 'completed'
  )
  AND EXISTS (
    SELECT 1 FROM "works"
    WHERE "works"."id" = "work_media_versions"."work_id"
      AND "works"."visibility" = 'private'
  );