CREATE TABLE "deadline_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deadline_reminders_dedupe" ON "deadline_reminders" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_deadline_reminders_created" ON "deadline_reminders" USING btree ("created_at");