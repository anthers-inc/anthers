ALTER TABLE "transcoding_jobs" ADD COLUMN "queue_eta_seconds" integer;--> statement-breakpoint
ALTER TABLE "transcoding_jobs" ADD COLUMN "timings" jsonb;