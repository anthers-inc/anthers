ALTER TABLE "attention_events" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "tab_visible" boolean;--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "element_visible" boolean;--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "playing" boolean;--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "device" text;--> statement-breakpoint
CREATE INDEX "idx_attention_user_started" ON "attention_events" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attention_user_client" ON "attention_events" USING btree ("user_id","client_id") WHERE "attention_events"."client_id" IS NOT NULL;--> statement-breakpoint
-- Pre-launch backfill so every existing duration-based row carries a readable range:
-- the interval ended at the previously-recorded created_at and ran for duration_seconds.
UPDATE "attention_events" SET "started_at" = "created_at" - make_interval(secs => "duration_seconds"), "ended_at" = "created_at" WHERE "started_at" IS NULL;