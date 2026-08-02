--==========================================================================
-- 0010 — Catalog / Posts separation
--
-- Hand-written, and deliberately NOT what `drizzle-kit generate` emitted. The
-- generator saw a dropped `content_items` and a new `works` and proposed
-- DROP TABLE + CREATE TABLE, which is correct about the end state and would
-- destroy every row getting there. The end state below matches the generated
-- snapshot exactly; the path preserves data.
--
-- Access, delivery, dates and gates move from the Post onto the Work. See
-- `40.08 Catalog and Posts` in the vault for the model and its reasoning.
--==========================================================================

-- ── 1. content_items becomes works ────────────────────────────────────────
ALTER TABLE "content_items" RENAME TO "works";--> statement-breakpoint
ALTER TABLE "works" RENAME CONSTRAINT "content_items_pkey" TO "works_pkey";--> statement-breakpoint
ALTER TABLE "works" RENAME CONSTRAINT "content_items_creator_id_users_id_fk" TO "works_creator_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "idx_content_items_creator" RENAME TO "idx_works_creator";--> statement-breakpoint
ALTER INDEX "idx_content_items_type" RENAME TO "idx_works_type";--> statement-breakpoint
ALTER SEQUENCE "content_items_id_seq" RENAME TO "works_id_seq";--> statement-breakpoint

-- ── 2. the columns that make a Work stand on its own ──────────────────────
ALTER TABLE "works" ADD COLUMN "public_id" bigint;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "body" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "body_html" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "estimated_read_minutes" integer;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "authored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "authored_precision" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "stream_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "download_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "anthers_access" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "seed_access" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "website_url" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "source_url" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "view_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "download_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "atproto_uri" text;--> statement-breakpoint

-- ── 3. public identity: a random non-sequential public_id, and a slug ─────
-- Matches how posts mint theirs (9 digits, 100_000_000–999_999_999). The loop
-- re-rolls only rows that are still null or collide, so it terminates fast.
DO $$
BEGIN
	LOOP
		UPDATE "works" w
		SET "public_id" = 100000000 + (floor(random() * 900000000))::bigint
		WHERE w."public_id" IS NULL
			OR EXISTS (SELECT 1 FROM "works" o WHERE o."public_id" = w."public_id" AND o."id" < w."id");
		EXIT WHEN NOT FOUND;
	END LOOP;
END $$;--> statement-breakpoint

-- Slug from the title, falling back to the type; a numeric suffix only where
-- two works would otherwise collide, so the common case stays clean.
WITH base AS (
	SELECT "id",
		COALESCE(
			NULLIF(trim(both '-' from regexp_replace(lower(COALESCE(NULLIF("title", ''), "type")), '[^a-z0-9]+', '-', 'g')), ''),
			'work'
		) AS b
	FROM "works"
), numbered AS (
	SELECT "id", b, row_number() OVER (PARTITION BY b ORDER BY "id") AS rn FROM base
)
UPDATE "works" w
SET "slug" = CASE WHEN n.rn = 1 THEN n.b ELSE n.b || '-' || n.rn END
FROM numbered n WHERE w."id" = n."id";--> statement-breakpoint

ALTER TABLE "works" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_slug_unique" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_atproto_uri_unique" UNIQUE("atproto_uri");--> statement-breakpoint
CREATE INDEX "idx_works_catalog" ON "works" USING btree ("creator_id","visibility","authored_at");--> statement-breakpoint
CREATE INDEX "idx_works_released" ON "works" USING btree ("visibility","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_works_public_id" ON "works" USING btree ("public_id");--> statement-breakpoint

-- ── 4. the media tables now hang off a Work ───────────────────────────────
-- The FKs follow the renamed table automatically; only names need tidying.
ALTER TABLE "assets" RENAME COLUMN "content_item_id" TO "work_id";--> statement-breakpoint
ALTER TABLE "assets" RENAME CONSTRAINT "assets_content_item_id_content_items_id_fk" TO "assets_work_id_works_id_fk";--> statement-breakpoint
ALTER INDEX "idx_assets_content_item" RENAME TO "idx_assets_work";--> statement-breakpoint
ALTER TABLE "transcoding_jobs" RENAME COLUMN "content_item_id" TO "work_id";--> statement-breakpoint
ALTER TABLE "transcoding_jobs" RENAME CONSTRAINT "transcoding_jobs_content_item_id_content_items_id_fk" TO "transcoding_jobs_work_id_works_id_fk";--> statement-breakpoint
ALTER INDEX "idx_transcoding_content_item" RENAME TO "idx_transcoding_work";--> statement-breakpoint

-- ── 5. post_work_refs — the inert reference that replaces post_contents ────
CREATE TABLE "post_work_refs" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"work_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "post_work_refs" ADD CONSTRAINT "post_work_refs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_work_refs" ADD CONSTRAINT "post_work_refs_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- DISTINCT ON collapses the case where one post referenced the same work twice
-- (legal under post_contents, forbidden by uq_post_work_refs).
INSERT INTO "post_work_refs" ("post_id", "work_id", "position", "created_at")
SELECT DISTINCT ON (pc."post_id", pc."content_item_id")
	pc."post_id", pc."content_item_id", pc."position", pc."created_at"
FROM "post_contents" pc
WHERE pc."kind" = 'content' AND pc."content_item_id" IS NOT NULL
ORDER BY pc."post_id", pc."content_item_id", pc."position";--> statement-breakpoint

CREATE UNIQUE INDEX "uq_post_work_refs" ON "post_work_refs" USING btree ("post_id","work_id");--> statement-breakpoint
CREATE INDEX "idx_post_work_refs_post" ON "post_work_refs" USING btree ("post_id","position");--> statement-breakpoint
CREATE INDEX "idx_post_work_refs_work" ON "post_work_refs" USING btree ("work_id","created_at");--> statement-breakpoint

-- ── 6. visibility: a Work is released iff a published Post already showed it ──
-- This preserves exactly what is visible today. Everything else stays private,
-- which is also the correct resting state for drafts and unreferenced uploads.
UPDATE "works" w
SET "visibility" = 'released',
	"released_at" = src."first_published"
FROM (
	SELECT r."work_id", MIN(p."created_at") AS "first_published"
	FROM "post_work_refs" r
	JOIN "posts" p ON p."id" = r."post_id"
	WHERE p."is_published"
	GROUP BY r."work_id"
) src
WHERE w."id" = src."work_id";--> statement-breakpoint

-- ── 7. access and delivery move from the Post to the Work ─────────────────
-- The incoherence this model exists to remove is visible right here: a Work
-- referenced from two Posts carried BOTH their gates, so the same bytes were
-- free via one and gated via the other. Collapsing to one gate per Work has to
-- pick. Where every referencing Post agrees, adopt it. Where they disagree we
-- FAIL CLOSED to "free but fully locked" and flag the row, because a Work
-- wrongly locked is recoverable by its creator and a Work wrongly opened is a
-- disclosure that is not. Flagged rows carry metadata.accessMigrationConflict
-- so they can be listed and reviewed.
UPDATE "works" w
SET "anthers_access" = src."anthers_access",
	"seed_access" = src."seed_access",
	"stream_enabled" = src."stream_enabled",
	"download_enabled" = src."download_enabled"
FROM (
	SELECT r."work_id",
		(array_agg(p."anthers_access" ORDER BY p."id"))[1] AS "anthers_access",
		(array_agg(p."seed_access" ORDER BY p."id"))[1] AS "seed_access",
		bool_or(p."stream_enabled") AS "stream_enabled",
		bool_or(p."download_enabled") AS "download_enabled"
	FROM "post_work_refs" r
	JOIN "posts" p ON p."id" = r."post_id"
	GROUP BY r."work_id"
	HAVING COUNT(DISTINCT p."anthers_access"::text || '|' || p."seed_access"::text) = 1
) src
WHERE w."id" = src."work_id";--> statement-breakpoint

UPDATE "works" w
SET "anthers_access" = '[{"threshold":0,"allow":false,"price":"0"},{"threshold":1,"allow":false,"price":"0"},{"threshold":2,"allow":false,"price":"0"},{"threshold":3,"allow":false,"price":"0"},{"threshold":4,"allow":false,"price":"0"}]'::jsonb,
	"seed_access" = '[{"threshold":0,"allow":false,"price":"0"}]'::jsonb,
	"metadata" = COALESCE(w."metadata", '{}'::jsonb) || '{"accessMigrationConflict":true}'::jsonb
WHERE w."id" IN (
	SELECT r."work_id"
	FROM "post_work_refs" r
	JOIN "posts" p ON p."id" = r."post_id"
	GROUP BY r."work_id"
	HAVING COUNT(DISTINCT p."anthers_access"::text || '|' || p."seed_access"::text) > 1
);--> statement-breakpoint

-- Never referenced by any post => never had a gate to inherit. Locked default.
UPDATE "works" w
SET "anthers_access" = '[{"threshold":0,"allow":false,"price":"0"},{"threshold":1,"allow":false,"price":"0"},{"threshold":2,"allow":false,"price":"0"},{"threshold":3,"allow":false,"price":"0"},{"threshold":4,"allow":false,"price":"0"}]'::jsonb,
	"seed_access" = '[{"threshold":0,"allow":false,"price":"0"}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM "post_work_refs" r WHERE r."work_id" = w."id");--> statement-breakpoint

-- ── 8. inline text blocks fold into the post body ─────────────────────────
-- Posts are body-embedded only now. Prose that should EARN belongs in the
-- Catalog as a Work of type 'text'; these blocks were part of a post's own
-- prose, which never earned, so appending them to the body loses nothing.
WITH t AS (
	SELECT "post_id", string_agg(COALESCE("body_html", ''), '' ORDER BY "position") AS html
	FROM "post_contents"
	WHERE "kind" = 'text' AND COALESCE("body_html", '') <> ''
	GROUP BY "post_id"
)
UPDATE "posts" p
SET "body_html" = COALESCE(p."body_html", '') || t.html
FROM t WHERE p."id" = t."post_id";--> statement-breakpoint

-- ── 9. posts gain a real publication timestamp ────────────────────────────
-- Latent bug, independent of this revamp: every feed sorted by created_at, the
-- time the DRAFT ROW was written, and publish-scheduled recorded nothing at all.
ALTER TABLE "posts" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
UPDATE "posts" SET "published_at" = "created_at" WHERE "is_published";--> statement-breakpoint
DROP INDEX "idx_posts_content_type";--> statement-breakpoint
CREATE INDEX "idx_posts_published" ON "posts" USING btree ("is_published","published_at");--> statement-breakpoint

-- ── 10. a purchase unlocks a Work, not a Post ─────────────────────────────
-- Access lives on the Work, so a permanent unlock has to name one. Where a post
-- carried several works a single purchase cannot be split; it maps to the first
-- by position, and a NULL means the charge was never a content purchase (a Seed
-- buy) or the post had no work to unlock.
ALTER TABLE "purchases" ADD COLUMN "work_id" integer;--> statement-breakpoint
UPDATE "purchases" pu
SET "work_id" = src."work_id"
FROM (
	SELECT DISTINCT ON (r."post_id") r."post_id", r."work_id"
	FROM "post_work_refs" r ORDER BY r."post_id", r."position", r."id"
) src
WHERE pu."post_id" = src."post_id";--> statement-breakpoint
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_post_id_posts_id_fk";--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "post_id";--> statement-breakpoint

-- ── 11. bookmarks can point at a Work ─────────────────────────────────────
ALTER TABLE "bookmarks" ADD COLUMN "work_id" integer;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── 12. the Post sheds everything that was never really its own ───────────
DROP TABLE "post_contents" CASCADE;--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "content_type";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "thumbnail";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "stream_enabled";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "download_enabled";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "anthers_access";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "seed_access";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "website_url";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "source_url";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "estimated_read_minutes";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "download_count";
