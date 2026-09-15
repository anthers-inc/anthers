ALTER TABLE "abuse_reports" DROP CONSTRAINT "abuse_reports_resolved_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "legal_holds" DROP CONSTRAINT "legal_holds_placed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "media_quarantine" DROP CONSTRAINT "media_quarantine_placed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "media_quarantine" DROP CONSTRAINT "media_quarantine_cleared_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "work_rating_appeals" DROP CONSTRAINT "work_rating_appeals_resolved_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "dmca_notices" DROP CONSTRAINT "dmca_notices_actor_id_users_id_fk";
--> statement-breakpoint
-- Every operator column below named an Anthers account and now names an admin account, so the
-- values already in them identify the wrong kind of account and are cleared rather than carried
-- over. The two columns that stay on Anthers accounts are reserved for Keepers, and every value in
-- them today was written by an operator, so those are cleared too. Nothing here is real data yet.
UPDATE "abuse_reports" SET "resolved_by" = NULL;--> statement-breakpoint
UPDATE "legal_holds" SET "placed_by" = NULL;--> statement-breakpoint
UPDATE "media_quarantine" SET "placed_by" = NULL, "cleared_by" = NULL;--> statement-breakpoint
UPDATE "work_rating_appeals" SET "resolved_by" = NULL;--> statement-breakpoint
UPDATE "dmca_notices" SET "actor_id" = NULL;--> statement-breakpoint
UPDATE "moderation_actions" SET "actor_id" = NULL;--> statement-breakpoint
UPDATE "moderation_reports" SET "resolved_by" = NULL;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD COLUMN "lifted_by" integer;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "admin_actor_id" integer;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD COLUMN "resolved_by_admin_id" integer;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD COLUMN "resolved_by" integer;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "suit_recorded_by" integer;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_resolved_by_admin_accounts_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_placed_by_admin_accounts_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_lifted_by_admin_accounts_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_quarantine" ADD CONSTRAINT "media_quarantine_placed_by_admin_accounts_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_quarantine" ADD CONSTRAINT "media_quarantine_cleared_by_admin_accounts_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_admin_actor_id_admin_accounts_id_fk" FOREIGN KEY ("admin_actor_id") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_resolved_by_admin_id_admin_accounts_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_rating_appeals" ADD CONSTRAINT "work_rating_appeals_resolved_by_admin_accounts_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_resolved_by_admin_accounts_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_suit_recorded_by_admin_accounts_id_fk" FOREIGN KEY ("suit_recorded_by") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_actor_id_admin_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_admin";