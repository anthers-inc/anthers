CREATE TABLE "error_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"top_frames" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release" text DEFAULT '' NOT NULL,
	"sample_context" jsonb,
	"alert_sent_at" timestamp with time zone,
	CONSTRAINT "error_events_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" serial PRIMARY KEY NOT NULL,
	"door" text NOT NULL,
	"ip" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_error_events_last_seen" ON "error_events" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_error_events_first_seen" ON "error_events" USING btree ("first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rate_limits_door_ip" ON "rate_limits" USING btree ("door","ip");--> statement-breakpoint
CREATE INDEX "idx_rate_limits_reset" ON "rate_limits" USING btree ("reset_at");