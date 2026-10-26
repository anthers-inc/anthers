ALTER TABLE "users" ADD COLUMN "avatar_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "header_image_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_crop" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "header_image_crop" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cover_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cover_crop" jsonb;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "thumbnail_source" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "thumbnail_crop" jsonb;