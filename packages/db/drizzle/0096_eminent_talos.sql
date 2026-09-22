ALTER TABLE "media_scans" ADD COLUMN "uploader_id" integer;--> statement-breakpoint
ALTER TABLE "media_scans" ADD COLUMN "object_kind" text;--> statement-breakpoint
ALTER TABLE "media_scans" ADD CONSTRAINT "media_scans_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;