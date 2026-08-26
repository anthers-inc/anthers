-- A parked ATProto identity generalizes into a pending account: one unfinished signup,
-- whichever door it came through.
--
-- Hand-authored as a RENAME where drizzle-kit generated a create-plus-drop. Both describe
-- the same end state, which is why `0054_snapshot.json` is still the generated one and the
-- next diff is taken against a true picture — but a drop would strand anyone mid-ceremony
-- when this deploys, and there is no reason to make them start over.
ALTER TABLE "atproto_pending_signups" RENAME TO "pending_signups";--> statement-breakpoint
ALTER TABLE "pending_signups" RENAME CONSTRAINT "atproto_pending_signups_pkey" TO "pending_signups_pkey";--> statement-breakpoint
ALTER TABLE "pending_signups" RENAME COLUMN "did" TO "atproto_did";--> statement-breakpoint
ALTER TABLE "pending_signups" RENAME COLUMN "handle" TO "atproto_handle";--> statement-breakpoint
ALTER TABLE "pending_signups" RENAME COLUMN "pds_url" TO "atproto_pds_url";--> statement-breakpoint
-- The email door writes these rows too, and it has no identity to put here.
ALTER TABLE "pending_signups" ALTER COLUMN "atproto_did" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_signups" ADD COLUMN "email_proved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_signups" ADD COLUMN "picks" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_signups" ADD COLUMN "next" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_signups" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
-- Existing rows carried their expiry as a constant in the service — thirty minutes from
-- creation. Now that it is a column, the rule those rows were created under is written into
-- them, rather than the new and much longer one being applied to them retroactively.
UPDATE "pending_signups" SET "expires_at" = "created_at" + interval '30 minutes';--> statement-breakpoint
ALTER TABLE "pending_signups" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_pending_signups_email" ON "pending_signups" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_pending_signups_did" ON "pending_signups" USING btree ("atproto_did");--> statement-breakpoint
CREATE INDEX "idx_pending_signups_expires" ON "pending_signups" USING btree ("expires_at");
