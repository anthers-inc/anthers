ALTER TABLE "user_preferences" ADD COLUMN "creator_email_delivery" jsonb;--> statement-breakpoint
INSERT INTO "user_preferences" ("user_id", "creator_email_delivery")
SELECT "user_id", '{"sale":"none","refund":"none","payout":"none"}'::jsonb
FROM "stripe_accounts"
WHERE "creator_receipt_emails" = false
ON CONFLICT ("user_id") DO UPDATE
SET "creator_email_delivery" = EXCLUDED."creator_email_delivery";--> statement-breakpoint
ALTER TABLE "stripe_accounts" DROP COLUMN "creator_receipt_emails";