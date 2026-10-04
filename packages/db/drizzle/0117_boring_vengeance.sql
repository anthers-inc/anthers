CREATE TABLE "issue_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"details" text NOT NULL,
	"page_url" text DEFAULT '' NOT NULL,
	"reporter_email" text DEFAULT '' NOT NULL,
	"reporter_id" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"ingested_by" integer,
	"ingested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_reports" ADD CONSTRAINT "issue_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reports" ADD CONSTRAINT "issue_reports_ingested_by_admin_accounts_id_fk" FOREIGN KEY ("ingested_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issue_reports_status" ON "issue_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_issue_reports_reporter" ON "issue_reports" USING btree ("reporter_id");