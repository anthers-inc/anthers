CREATE TABLE "rate_limits" (
	"id" serial PRIMARY KEY NOT NULL,
	"door" text NOT NULL,
	"ip" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rate_limits_door_ip" ON "rate_limits" USING btree ("door","ip");--> statement-breakpoint
CREATE INDEX "idx_rate_limits_reset" ON "rate_limits" USING btree ("reset_at");