ALTER TABLE "moderation_reports" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "redacted_at" timestamp with time zone;