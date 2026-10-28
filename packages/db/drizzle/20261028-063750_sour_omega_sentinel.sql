-- Nomenclature, part one: the Work and user families (Parker, 2026-10-28).
--
-- Nine tables become family-prefixed so the table list groups when sorted: `assets`,
-- `web_builds`, `web_build_files`, `transcoding_jobs` and `physical_listings` hang off a
-- Work; `sessions`, `library_items`, `reading_positions` and `account_cycles` are one
-- person's own rows. `physical_listings` keeps the Work prefix rather than becoming
-- `work_listings`, which would collide with the ATProto listing a Work already carries.
--
-- ⚠️ Hand-authored as RENAMEs where drizzle-kit generated create-plus-drop, as migrations
-- `0054`, `0111` and `0113` did. The end state is the generated one — this journal
-- entry's snapshot is drizzle-kit's own — but a drop-and-recreate would destroy every
-- session, Library, reading position, cycle snapshot and build row on deploy, and a
-- renamed table carries its data, its sequences and its foreign keys intact.
--
-- Postgres keeps the old constraint, index and sequence names through a table rename
-- while the snapshot records the new ones, so those are renamed too; without it the next
-- `db:generate` sees a phantom diff.
ALTER TABLE "sessions" RENAME TO "user_sessions";--> statement-breakpoint
ALTER TABLE "user_sessions" RENAME CONSTRAINT "sessions_pkey" TO "user_sessions_pkey";--> statement-breakpoint
ALTER TABLE "user_sessions" RENAME CONSTRAINT "sessions_token_unique" TO "user_sessions_token_unique";--> statement-breakpoint
ALTER TABLE "user_sessions" RENAME CONSTRAINT "sessions_user_id_users_id_fk" TO "user_sessions_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "idx_sessions_user" RENAME TO "idx_user_sessions_user";--> statement-breakpoint
ALTER SEQUENCE "sessions_id_seq" RENAME TO "user_sessions_id_seq";--> statement-breakpoint
ALTER TABLE "library_items" RENAME TO "user_library_items";--> statement-breakpoint
ALTER TABLE "user_library_items" RENAME CONSTRAINT "library_items_pkey" TO "user_library_items_pkey";--> statement-breakpoint
ALTER TABLE "user_library_items" RENAME CONSTRAINT "library_items_user_id_users_id_fk" TO "user_library_items_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_library_items" RENAME CONSTRAINT "library_items_work_id_works_id_fk" TO "user_library_items_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "user_library_items" RENAME CONSTRAINT "library_items_project_id_projects_id_fk" TO "user_library_items_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "user_library_items" RENAME CONSTRAINT "library_items_post_id_posts_id_fk" TO "user_library_items_post_id_posts_id_fk";--> statement-breakpoint
ALTER SEQUENCE "library_items_id_seq" RENAME TO "user_library_items_id_seq";--> statement-breakpoint
ALTER TABLE "reading_positions" RENAME TO "user_reading_positions";--> statement-breakpoint
ALTER TABLE "user_reading_positions" RENAME CONSTRAINT "reading_positions_pkey" TO "user_reading_positions_pkey";--> statement-breakpoint
ALTER TABLE "user_reading_positions" RENAME CONSTRAINT "reading_positions_user_id_users_id_fk" TO "user_reading_positions_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_reading_positions" RENAME CONSTRAINT "reading_positions_work_id_works_id_fk" TO "user_reading_positions_work_id_works_id_fk";--> statement-breakpoint
ALTER INDEX "uq_reading_positions_user_work" RENAME TO "uq_user_reading_positions_user_work";--> statement-breakpoint
ALTER INDEX "idx_reading_positions_user_updated" RENAME TO "idx_user_reading_positions_user_updated";--> statement-breakpoint
ALTER SEQUENCE "reading_positions_id_seq" RENAME TO "user_reading_positions_id_seq";--> statement-breakpoint
ALTER TABLE "account_cycles" RENAME TO "user_cycles";--> statement-breakpoint
ALTER TABLE "user_cycles" RENAME CONSTRAINT "account_cycles_pkey" TO "user_cycles_pkey";--> statement-breakpoint
ALTER TABLE "user_cycles" RENAME CONSTRAINT "account_cycles_user_id_users_id_fk" TO "user_cycles_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "uq_account_cycles_user_cycle" RENAME TO "uq_user_cycles_user_cycle";--> statement-breakpoint
ALTER SEQUENCE "account_cycles_id_seq" RENAME TO "user_cycles_id_seq";--> statement-breakpoint
ALTER TABLE "assets" RENAME TO "work_assets";--> statement-breakpoint
ALTER TABLE "work_assets" RENAME CONSTRAINT "assets_pkey" TO "work_assets_pkey";--> statement-breakpoint
ALTER TABLE "work_assets" RENAME CONSTRAINT "assets_work_id_works_id_fk" TO "work_assets_work_id_works_id_fk";--> statement-breakpoint
ALTER INDEX "idx_assets_work" RENAME TO "idx_work_assets_work";--> statement-breakpoint
ALTER SEQUENCE "assets_id_seq" RENAME TO "work_assets_id_seq";--> statement-breakpoint
ALTER TABLE "web_builds" RENAME TO "work_builds";--> statement-breakpoint
ALTER TABLE "work_builds" RENAME CONSTRAINT "web_builds_pkey" TO "work_builds_pkey";--> statement-breakpoint
ALTER TABLE "work_builds" RENAME CONSTRAINT "web_builds_work_id_works_id_fk" TO "work_builds_work_id_works_id_fk";--> statement-breakpoint
ALTER INDEX "idx_web_builds_work" RENAME TO "idx_work_builds_work";--> statement-breakpoint
ALTER SEQUENCE "web_builds_id_seq" RENAME TO "work_builds_id_seq";--> statement-breakpoint
ALTER TABLE "web_build_files" RENAME TO "work_build_files";--> statement-breakpoint
ALTER TABLE "work_build_files" RENAME CONSTRAINT "web_build_files_pkey" TO "work_build_files_pkey";--> statement-breakpoint
ALTER TABLE "work_build_files" RENAME CONSTRAINT "web_build_files_build_id_web_builds_id_fk" TO "work_build_files_build_id_work_builds_id_fk";--> statement-breakpoint
ALTER INDEX "uq_web_build_files" RENAME TO "uq_work_build_files";--> statement-breakpoint
ALTER SEQUENCE "web_build_files_id_seq" RENAME TO "work_build_files_id_seq";--> statement-breakpoint
ALTER TABLE "transcoding_jobs" RENAME TO "work_transcoding_jobs";--> statement-breakpoint
ALTER TABLE "work_transcoding_jobs" RENAME CONSTRAINT "transcoding_jobs_pkey" TO "work_transcoding_jobs_pkey";--> statement-breakpoint
ALTER TABLE "work_transcoding_jobs" RENAME CONSTRAINT "transcoding_jobs_work_id_works_id_fk" TO "work_transcoding_jobs_work_id_works_id_fk";--> statement-breakpoint
ALTER SEQUENCE "transcoding_jobs_id_seq" RENAME TO "work_transcoding_jobs_id_seq";--> statement-breakpoint
ALTER TABLE "physical_listings" RENAME TO "work_physical_listings";--> statement-breakpoint
ALTER TABLE "work_physical_listings" RENAME CONSTRAINT "physical_listings_pkey" TO "work_physical_listings_pkey";--> statement-breakpoint
ALTER TABLE "work_physical_listings" RENAME CONSTRAINT "physical_listings_work_id_unique" TO "work_physical_listings_work_id_unique";--> statement-breakpoint
ALTER TABLE "work_physical_listings" RENAME CONSTRAINT "physical_listings_work_id_works_id_fk" TO "work_physical_listings_work_id_works_id_fk";--> statement-breakpoint
ALTER SEQUENCE "physical_listings_id_seq" RENAME TO "work_physical_listings_id_seq";
