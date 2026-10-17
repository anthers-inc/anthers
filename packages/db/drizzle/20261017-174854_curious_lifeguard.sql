CREATE TABLE "time_pool_fund_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"billing_cycle" text NOT NULL,
	"status" text DEFAULT 'actual' NOT NULL,
	"charitable_revenue" numeric DEFAULT '0.00' NOT NULL,
	"admin_budget_share" real NOT NULL,
	"free_access_share" real NOT NULL,
	"pool_amount" numeric DEFAULT '0.00' NOT NULL,
	"active_free_accounts" integer DEFAULT 0 NOT NULL,
	"slice_per_account" numeric DEFAULT '0.00' NOT NULL,
	"actualized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_time_pool_fund_cycle" ON "time_pool_fund_ledger" USING btree ("billing_cycle");