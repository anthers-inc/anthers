ALTER TABLE "abuse_reports" ADD COLUMN "escalation_delivery_event" text;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD COLUMN "escalation_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD COLUMN "escalation_delivery_event" text;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD COLUMN "escalation_delivery_at" timestamp with time zone;