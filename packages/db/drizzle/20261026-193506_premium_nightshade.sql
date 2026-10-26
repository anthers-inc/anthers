-- The rename half is hand-written: `db:generate` proposed dropping the old columns and adding
-- the new ones, which would destroy live Projects and accounts. These are the same columns
-- under the words the product now uses, so the data moves with them.
ALTER TABLE "users" RENAME COLUMN "header_image" TO "banner_image";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banner_image_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_crop" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banner_image_crop" jsonb;--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "cover_image" TO "thumbnail";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "thumbnail_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "thumbnail_crop" jsonb;--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "cover_work_id" TO "thumbnail_work_id";--> statement-breakpoint
ALTER TABLE "projects" RENAME CONSTRAINT "projects_cover_work_id_works_id_fk" TO "projects_thumbnail_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "thumbnail_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "thumbnail_crop" jsonb;
