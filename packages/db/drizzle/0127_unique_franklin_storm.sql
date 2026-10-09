ALTER TABLE "notifications" ADD COLUMN "email_delivery_event" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "email_delivery_event_at" timestamp with time zone;