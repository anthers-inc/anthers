-- Unfinished signups written before handles were reserved may ask for the same name. Keep the
-- newest request for each name and clear the rest, so the unique index can be built.
UPDATE "pending_signups" AS p SET "hosted_handle" = NULL
WHERE p."hosted_handle" IS NOT NULL AND EXISTS (
	SELECT 1 FROM "pending_signups" AS q
	WHERE q."hosted_handle" = p."hosted_handle"
		AND (q."created_at" > p."created_at" OR (q."created_at" = p."created_at" AND q."token" > p."token"))
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_signups_hosted_handle" ON "pending_signups" USING btree ("hosted_handle");
