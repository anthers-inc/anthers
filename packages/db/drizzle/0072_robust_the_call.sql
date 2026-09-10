ALTER TABLE "hosted_accounts" ADD COLUMN "recovery_key" text;--> statement-breakpoint
ALTER TABLE "hosted_accounts" ADD COLUMN "recovery_key_seated_at" timestamp with time zone;