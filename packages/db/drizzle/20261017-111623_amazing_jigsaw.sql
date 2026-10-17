DROP TABLE "post_work_refs" CASCADE;--> statement-breakpoint
ALTER TABLE "transcoding_jobs" ADD COLUMN "playable_at" timestamp with time zone;