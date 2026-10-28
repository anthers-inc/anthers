CREATE TABLE "work_credit_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"contributor_did" text NOT NULL,
	"role" text NOT NULL,
	"decision" text NOT NULL,
	"atproto_uri" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_credit_decisions_atproto_uri_unique" UNIQUE("atproto_uri")
);--> statement-breakpoint
ALTER TABLE "work_credit_decisions" ADD CONSTRAINT "work_credit_decisions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_credit_decisions_work_contributor_role" ON "work_credit_decisions" USING btree ("work_id","contributor_did","role");--> statement-breakpoint
CREATE INDEX "idx_work_credit_decisions_work" ON "work_credit_decisions" USING btree ("work_id");--> statement-breakpoint
-- An acceptance folds in as the accepted decision, keeping the record address and the
-- moment the person said yes rather than the moment this migration ran.
INSERT INTO "work_credit_decisions" ("work_id", "contributor_did", "role", "decision", "atproto_uri", "decided_at")
SELECT "work_id", "contributor_did", "role", 'accepted', "atproto_uri", "accepted_at" FROM "credit_acceptances"
ON CONFLICT ("work_id", "contributor_did", "role") DO NOTHING;--> statement-breakpoint
-- A rejection folds in beside it. A credit that somehow has both rows ends as rejected:
-- accepting refuses a rejected credit, so the only way both exist is accept-then-reject.
INSERT INTO "work_credit_decisions" ("work_id", "contributor_did", "role", "decision", "decided_at")
SELECT "work_id", "contributor_did", "role", 'rejected', "rejected_at" FROM "credit_rejections"
ON CONFLICT ("work_id", "contributor_did", "role") DO UPDATE SET
	"decision" = 'rejected',
	"decided_at" = EXCLUDED."decided_at";--> statement-breakpoint
DROP TABLE "credit_acceptances" CASCADE;--> statement-breakpoint
DROP TABLE "credit_rejections" CASCADE;
