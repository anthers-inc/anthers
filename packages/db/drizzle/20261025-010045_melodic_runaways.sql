ALTER TABLE "work_media_versions" ADD COLUMN "version_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "version_label" text DEFAULT '' NOT NULL;