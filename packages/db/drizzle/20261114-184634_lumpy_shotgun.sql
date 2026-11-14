DROP INDEX "idx_upload_sessions_resume";--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD COLUMN "work_id" integer;--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_upload_sessions_resume" ON "media_upload_sessions" USING btree ("creator_id","work_id","client_sha256");