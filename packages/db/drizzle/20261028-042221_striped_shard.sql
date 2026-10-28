ALTER TABLE "account_cycles" ADD COLUMN "bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_cycles" ADD COLUMN "purposes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "account_cycles" ADD COLUMN "sampled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "studio_panels" jsonb;--> statement-breakpoint
-- The storage meter's rows fold into the money row of the same account-month. A row is
-- inserted where settlement never wrote one, because the meter runs daily and settlement
-- only after the month closes.
INSERT INTO "account_cycles" ("user_id", "billing_cycle", "bytes", "purposes", "sampled_at")
SELECT "user_id", "billing_cycle", "bytes", "purposes", "sampled_at" FROM "storage_usage"
ON CONFLICT ("user_id", "billing_cycle") DO UPDATE SET
	"bytes" = EXCLUDED."bytes",
	"purposes" = EXCLUDED."purposes",
	"sampled_at" = EXCLUDED."sampled_at";--> statement-breakpoint
-- The Dashboard layout becomes a preference, and a row is created where the account never
-- had one: the two tables were written at different moments by different routes.
INSERT INTO "user_preferences" ("user_id", "studio_panels")
SELECT "user_id", "panels" FROM "studio_preferences"
ON CONFLICT ("user_id") DO UPDATE SET "studio_panels" = EXCLUDED."studio_panels";--> statement-breakpoint
DROP TABLE "studio_preferences" CASCADE;--> statement-breakpoint
DROP TABLE "storage_usage" CASCADE;
