ALTER TABLE "users" RENAME COLUMN "header_image" TO "banner_image";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "header_image_source" TO "banner_image_source";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "header_image_crop" TO "banner_image_crop";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "cover_image" TO "thumbnail";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "cover_source" TO "thumbnail_source";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "cover_crop" TO "thumbnail_crop";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "cover_work_id" TO "thumbnail_work_id";--> statement-breakpoint
ALTER TABLE "projects" RENAME CONSTRAINT "projects_cover_work_id_works_id_fk" TO "projects_thumbnail_work_id_works_id_fk";
