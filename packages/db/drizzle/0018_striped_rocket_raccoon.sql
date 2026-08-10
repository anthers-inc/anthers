ALTER TABLE "purchases" ADD COLUMN "downloaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "refund_initiator" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "refund_reason" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "stripe_refund_id" text;