-- Nomenclature, part two: the money families (Parker, 2026-10-28).
--
-- Seven tables take the prefix that says which side of the money they are on. `access_receipts`
-- becomes `purchase_receipts` (the receipt worklist for one purchase, sorting beside
-- `purchases`); `billing_accounts` becomes `stripe_customers` (the payer's Stripe customer
-- relationship, not a billing account in general); `stripe_accounts` becomes
-- `stripe_connect_accounts` (the payout side — neither old name said which side); and
-- `support_reductions` becomes `billing_reductions`, since "support" left the load-bearing
-- vocabulary and the row is a price reduction.
--
-- `month_settlements` becomes `settlement_months` (one row per month, sorting with the
-- settlement family), `crf_ledger` becomes `charitable_ledger` (the fund that named it was
-- retired; the live content is the charitable remainder), and `time_pool_fund_ledger` becomes
-- `pool_fund_ledger` (the `pool_` family exists and the full name repeats it).
--
-- ⚠️ Hand-authored as RENAMEs where drizzle-kit generated create-plus-drop, as `0054`, `0111`,
-- `0113` and this batch's `0206` did. The journal's snapshot is drizzle-kit's own; a
-- drop-and-recreate would destroy every receipt, payer relationship, payout account, price
-- reduction, monthly settlement and pool-fund entry on deploy.
--
-- Postgres keeps the old constraint, index and sequence names through a table rename while the
-- snapshot records the new ones, so those are renamed too.
ALTER TABLE "access_receipts" RENAME TO "purchase_receipts";--> statement-breakpoint
ALTER TABLE "purchase_receipts" RENAME CONSTRAINT "access_receipts_pkey" TO "purchase_receipts_pkey";--> statement-breakpoint
ALTER TABLE "purchase_receipts" RENAME CONSTRAINT "access_receipts_purchase_id_purchases_id_fk" TO "purchase_receipts_purchase_id_purchases_id_fk";--> statement-breakpoint
ALTER INDEX "uq_access_receipts_purchase_kind" RENAME TO "uq_purchase_receipts_purchase_kind";--> statement-breakpoint
ALTER INDEX "idx_access_receipts_state" RENAME TO "idx_purchase_receipts_state";--> statement-breakpoint
ALTER SEQUENCE "access_receipts_id_seq" RENAME TO "purchase_receipts_id_seq";--> statement-breakpoint
ALTER TABLE "billing_accounts" RENAME TO "stripe_customers";--> statement-breakpoint
ALTER TABLE "stripe_customers" RENAME CONSTRAINT "billing_accounts_pkey" TO "stripe_customers_pkey";--> statement-breakpoint
ALTER TABLE "stripe_customers" RENAME CONSTRAINT "billing_accounts_user_id_unique" TO "stripe_customers_user_id_unique";--> statement-breakpoint
ALTER TABLE "stripe_customers" RENAME CONSTRAINT "billing_accounts_user_id_users_id_fk" TO "stripe_customers_user_id_users_id_fk";--> statement-breakpoint
ALTER SEQUENCE "billing_accounts_id_seq" RENAME TO "stripe_customers_id_seq";--> statement-breakpoint
ALTER TABLE "stripe_accounts" RENAME TO "stripe_connect_accounts";--> statement-breakpoint
ALTER TABLE "stripe_connect_accounts" RENAME CONSTRAINT "stripe_accounts_pkey" TO "stripe_connect_accounts_pkey";--> statement-breakpoint
ALTER TABLE "stripe_connect_accounts" RENAME CONSTRAINT "stripe_accounts_user_id_unique" TO "stripe_connect_accounts_user_id_unique";--> statement-breakpoint
ALTER TABLE "stripe_connect_accounts" RENAME CONSTRAINT "stripe_accounts_stripe_account_id_unique" TO "stripe_connect_accounts_stripe_account_id_unique";--> statement-breakpoint
ALTER TABLE "stripe_connect_accounts" RENAME CONSTRAINT "stripe_accounts_user_id_users_id_fk" TO "stripe_connect_accounts_user_id_users_id_fk";--> statement-breakpoint
ALTER SEQUENCE "stripe_accounts_id_seq" RENAME TO "stripe_connect_accounts_id_seq";--> statement-breakpoint
ALTER TABLE "support_reductions" RENAME TO "billing_reductions";--> statement-breakpoint
ALTER TABLE "billing_reductions" RENAME CONSTRAINT "support_reductions_pkey" TO "billing_reductions_pkey";--> statement-breakpoint
ALTER TABLE "billing_reductions" RENAME CONSTRAINT "support_reductions_user_id_users_id_fk" TO "billing_reductions_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "idx_support_reductions_user_cycle" RENAME TO "idx_billing_reductions_user_cycle";--> statement-breakpoint
ALTER SEQUENCE "support_reductions_id_seq" RENAME TO "billing_reductions_id_seq";--> statement-breakpoint
ALTER TABLE "month_settlements" RENAME TO "settlement_months";--> statement-breakpoint
ALTER TABLE "settlement_months" RENAME CONSTRAINT "month_settlements_pkey" TO "settlement_months_pkey";--> statement-breakpoint
ALTER TABLE "settlement_months" RENAME CONSTRAINT "month_settlements_billing_cycle_unique" TO "settlement_months_billing_cycle_unique";--> statement-breakpoint
ALTER SEQUENCE "month_settlements_id_seq" RENAME TO "settlement_months_id_seq";--> statement-breakpoint
ALTER TABLE "crf_ledger" RENAME TO "charitable_ledger";--> statement-breakpoint
ALTER TABLE "charitable_ledger" RENAME CONSTRAINT "crf_ledger_pkey" TO "charitable_ledger_pkey";--> statement-breakpoint
ALTER TABLE "charitable_ledger" RENAME CONSTRAINT "crf_ledger_purchase_id_purchases_id_fk" TO "charitable_ledger_purchase_id_purchases_id_fk";--> statement-breakpoint
ALTER INDEX "idx_crf_ledger_purchase" RENAME TO "idx_charitable_ledger_purchase";--> statement-breakpoint
ALTER SEQUENCE "crf_ledger_id_seq" RENAME TO "charitable_ledger_id_seq";--> statement-breakpoint
ALTER TABLE "time_pool_fund_ledger" RENAME TO "pool_fund_ledger";--> statement-breakpoint
ALTER TABLE "pool_fund_ledger" RENAME CONSTRAINT "time_pool_fund_ledger_pkey" TO "pool_fund_ledger_pkey";--> statement-breakpoint
ALTER INDEX "uq_time_pool_fund_cycle" RENAME TO "uq_pool_fund_cycle";--> statement-breakpoint
ALTER SEQUENCE "time_pool_fund_ledger_id_seq" RENAME TO "pool_fund_ledger_id_seq";
