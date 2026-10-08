CREATE TABLE "financial_plan_phases" (
	"id" serial PRIMARY KEY NOT NULL,
	"phase" smallint NOT NULL,
	"label" text NOT NULL,
	"accounts" integer NOT NULL,
	"paying_share" real NOT NULL,
	"staff" real DEFAULT 0 NOT NULL,
	"tooling" real DEFAULT 0 NOT NULL,
	"services" real DEFAULT 0 NOT NULL,
	"admin_budget_share" real,
	"fund_share" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_plan_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"admin_budget_share" real NOT NULL,
	"fund_share" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_financial_plan_phases_phase" ON "financial_plan_phases" USING btree ("phase");