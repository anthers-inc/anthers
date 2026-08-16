ALTER TABLE "dmca_notices" DROP CONSTRAINT "dmca_notices_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "work_title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "counter_notice_due_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "finalized_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "buyers_refunded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dmca_notices_finality" ON "dmca_notices" USING btree ("status","counter_notice_due_by");