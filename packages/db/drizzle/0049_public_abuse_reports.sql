CREATE TABLE "abuse_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"work_id" integer,
	"reason" text NOT NULL,
	"details" text NOT NULL,
	"reporter_email" text DEFAULT '' NOT NULL,
	"reporter_id" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"escalated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" integer,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_escalation" ON "abuse_reports" USING btree ("escalated_at","reason");--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_status" ON "abuse_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_work" ON "abuse_reports" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_resolved_by" ON "abuse_reports" USING btree ("resolved_by");