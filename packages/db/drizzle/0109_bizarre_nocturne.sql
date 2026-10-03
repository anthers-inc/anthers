ALTER TABLE "disputes" ADD COLUMN "contested_by_admin_id" integer;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "contested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "contested_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_contested_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("contested_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;