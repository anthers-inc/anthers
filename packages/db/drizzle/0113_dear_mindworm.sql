-- The accounts split (Parker, 2026-10-03 — the billing half of the Badge-model pass).
-- `accounts` becomes `billing_accounts` (the Stripe machinery only) and
-- `user_preferences` (the user's own settings), riding the dead-column sweep:
-- `bandwidth_used_gib` everywhere, `purchases.crf_fee`/`delivery_fee`, the pre-`0035`
-- bookmark targets, and `reviews.work_id` made NOT NULL.
--
-- ⚠️ The `accounts` statements below are hand-written on purpose, replacing drizzle-kit's
-- create-plus-drop output: a plain drop would have destroyed every dev database's
-- gauntlet data (the lazy billing rows carry the adult/display preferences, and dev
-- sessions hold real fixture state). The snapshot this journal entry carries is
-- drizzle-kit's own — the end state is identical either way — but the SQL is the
-- data-carrying transform, in the order the transform requires (copy BEFORE drop).
--
-- Order matters: rename first, create the preferences table second, copy the settings
-- across third (JOINing `users` for the two columns that move off it), and only then
-- drop the columns that died. The copy drives from `users` LEFT JOINed to the billing
-- rows so a user who set a theme but never paid keeps it — `users.theme_preference` was
-- on every user row, while the preferences columns only exist on billing rows.
ALTER TABLE "accounts" RENAME TO "billing_accounts";--> statement-breakpoint
-- Postgres keeps the old constraint/index/sequence names through a table rename, and
-- the snapshot records the new ones — rename them too so the next `db:generate` does
-- not see a phantom diff (the way migration `0111` did for `badges`).
ALTER TABLE "billing_accounts" RENAME CONSTRAINT "accounts_pkey" TO "billing_accounts_pkey";--> statement-breakpoint
ALTER TABLE "billing_accounts" RENAME CONSTRAINT "accounts_user_id_unique" TO "billing_accounts_user_id_unique";--> statement-breakpoint
ALTER TABLE "billing_accounts" RENAME CONSTRAINT "accounts_user_id_users_id_fk" TO "billing_accounts_user_id_users_id_fk";--> statement-breakpoint
ALTER SEQUENCE "accounts_id_seq" RENAME TO "billing_accounts_id_seq";--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"listed_as_supporter" boolean DEFAULT true NOT NULL,
	"adult_opt_in" boolean DEFAULT false NOT NULL,
	"adult_verified_at" timestamp with time zone,
	"adult_verified_method" text,
	"mature_display" text,
	"adult_display" text,
	"note_display" jsonb,
	"theme_preference" text,
	"notify_activity_email" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every user gets a preferences row, eagerly — that is the new table's contract, and it
-- is what lets the two `users` columns move off the identity row without stranding a
-- user who set a theme but never paid (no billing row exists for them). Rows with no
-- billing history take the column defaults for the settings that were never set;
-- `created_at`/`updated_at` fall back to the user row's own timestamps.
INSERT INTO "user_preferences" ("user_id", "listed_as_supporter", "adult_opt_in", "adult_verified_at", "adult_verified_method", "mature_display", "adult_display", "note_display", "theme_preference", "notify_activity_email", "created_at", "updated_at")
SELECT
	u."id",
	COALESCE(ba."listed_as_supporter", true),
	COALESCE(ba."adult_opt_in", false),
	ba."adult_verified_at",
	ba."adult_verified_method",
	ba."mature_display",
	ba."adult_display",
	ba."note_display",
	u."theme_preference",
	u."notify_activity_email",
	COALESCE(ba."created_at", u."created_at"),
	COALESCE(ba."updated_at", u."created_at")
FROM "users" u
LEFT JOIN "billing_accounts" ba ON ba."user_id" = u."id";--> statement-breakpoint
-- The directed balance rides the subscription machinery now (see the schema column's
-- note: a Phase B read target the webhook will write); default it on the renamed rows.
ALTER TABLE "billing_accounts" ADD COLUMN "directed_budget" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
-- The amounts die: under the Badge model they are `user_badges` holdings (the Anthers
-- Badge's threshold IS the amount; the creator total is the sum of held thresholds).
-- `bandwidth_used_gib` has been dead since 2026-08-12.
ALTER TABLE "billing_accounts" DROP COLUMN "anthers_support";--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP COLUMN "creator_support_total";--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP COLUMN "bandwidth_used_gib";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "theme_preference";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "notify_activity_email";--> statement-breakpoint
-- Dead-column sweep, while the migration is open.
ALTER TABLE "account_cycles" DROP COLUMN "bandwidth_used_gib";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "delivery_fee";--> statement-breakpoint
ALTER TABLE "purchases" DROP COLUMN "crf_fee";--> statement-breakpoint
ALTER TABLE "bookmarks" DROP CONSTRAINT "bookmarks_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "bookmarks" DROP CONSTRAINT "bookmarks_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "bookmarks" DROP CONSTRAINT "bookmarks_creator_id_users_id_fk";--> statement-breakpoint
DROP INDEX "idx_bookmarks_work";--> statement-breakpoint
DROP INDEX "idx_bookmarks_project";--> statement-breakpoint
DROP INDEX "idx_bookmarks_creator";--> statement-breakpoint
ALTER TABLE "bookmarks" DROP COLUMN "work_id";--> statement-breakpoint
ALTER TABLE "bookmarks" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "bookmarks" DROP COLUMN "creator_id";--> statement-breakpoint
-- A review's Work was nullable only to carry migration `0012`'s orphaned rows, which
-- pre-launch cannot exist. If a dev database somehow holds one, the row is deleted
-- rather than held against the constraint — pre-launch, sanctioned by the task brief
-- (schema-naming evaluation, "Drop the dead columns" table).
DELETE FROM "reviews" WHERE "work_id" IS NULL;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "work_id" SET NOT NULL;