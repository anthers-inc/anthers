DROP TABLE "wallet_ledger" CASCADE;--> statement-breakpoint
ALTER TABLE "account_cycles" ADD COLUMN "anthers_seeds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_cycles" ADD COLUMN "anthers_spend" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_cycles" ADD COLUMN "creator_seed_total" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_cycles" ADD COLUMN "foundation" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "anthers_seeds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "creator_seed_total" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_cycles" DROP COLUMN "badge";--> statement-breakpoint
ALTER TABLE "account_cycles" DROP COLUMN "plan_price";--> statement-breakpoint
ALTER TABLE "account_cycles" DROP COLUMN "seed_total";--> statement-breakpoint
ALTER TABLE "account_cycles" DROP COLUMN "community_share";--> statement-breakpoint
ALTER TABLE "account_cycles" DROP COLUMN "wallet_spend";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "badge";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "wallet_balance";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "seed_total";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "auto_topup_enabled";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "auto_topup_amount";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "auto_topup_threshold";