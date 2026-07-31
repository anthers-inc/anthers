-- The moderation surface: reports, the record of what was done about them, and a
-- moderation state on the two user-generated row types.
--
-- Purely additive, and deliberately so. Both new columns are NOT NULL with a
-- 'visible' default, so every existing comment and rating is born visible and no
-- backfill is needed; nothing here drops, renames or rewrites anything.
--
-- The load-bearing choice is `moderation_status` as a COLUMN rather than a
-- removal as a DELETE. Hiding a comment leaves the row — its author, its text,
-- its timestamp — intact and reversible, which is what keeps appeals,
-- creator-side moderation and composable labelers as later FEATURES instead of
-- later migrations. Once content is deleted, none of those can be built without
-- an audit trail that no longer exists.
--
-- The two users FKs are ON DELETE SET NULL, not CASCADE, for the same reason: a
-- moderation record has to outlive the account it concerns. If deleting a
-- reporter erased their reports, the trail would be a function of who still has
-- an account.

CREATE TABLE "moderation_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"action" text NOT NULL,
	"actor_id" integer,
	"actor_role" text DEFAULT 'operator' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"reporter_id" integer,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "moderation_status" text DEFAULT 'visible' NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "moderation_status" text DEFAULT 'visible' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_moderation_actions_subject" ON "moderation_actions" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_moderation_actions_created" ON "moderation_actions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_moderation_report_reporter_subject" ON "moderation_reports" USING btree ("reporter_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_moderation_reports_subject" ON "moderation_reports" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_moderation_reports_status" ON "moderation_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_comments_post_visible" ON "comments" USING btree ("post_id","moderation_status");--> statement-breakpoint
CREATE INDEX "idx_ratings_post_visible" ON "ratings" USING btree ("post_id","moderation_status");