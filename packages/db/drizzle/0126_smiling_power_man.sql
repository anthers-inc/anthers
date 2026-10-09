ALTER TABLE "receipt_sends" ADD COLUMN "delivery_event" text;--> statement-breakpoint
ALTER TABLE "receipt_sends" ADD COLUMN "delivery_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "email_intended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "email_message_id" text;--> statement-breakpoint
CREATE INDEX "idx_receipt_sends_message" ON "receipt_sends" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_email_message" ON "notifications" USING btree ("email_message_id");