CREATE TABLE "media_quarantine" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer,
	"uploader_id" integer,
	"original_key" text NOT NULL,
	"quarantine_key" text NOT NULL,
	"object_kind" text NOT NULL,
	"source" text NOT NULL,
	"classification" text DEFAULT '' NOT NULL,
	"report_id" integer,
	"prior_visibility" text DEFAULT '' NOT NULL,
	"placed_by" integer,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" integer,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "quarantine_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_quarantine" ADD CONSTRAINT "media_quarantine_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_quarantine" ADD CONSTRAINT "media_quarantine_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_quarantine" ADD CONSTRAINT "media_quarantine_report_id_moderation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."moderation_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_quarantine" ADD CONSTRAINT "media_quarantine_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_quarantine" ADD CONSTRAINT "media_quarantine_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_media_quarantine_work" ON "media_quarantine" USING btree ("work_id","cleared_at");--> statement-breakpoint
CREATE INDEX "idx_media_quarantine_placed" ON "media_quarantine" USING btree ("placed_at");