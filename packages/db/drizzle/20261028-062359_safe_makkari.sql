-- Every report that was escalated becomes a ledger row, keyed the way the escalators now
-- key it. The recipient address was a deployment constant rather than a stored value, so
-- these historical rows carry an empty one; the subject is rebuilt from the reason.
INSERT INTO "outbound_emails" ("dedupe_key", "kind", "recipient", "subject", "detail", "message_id", "sent_at", "delivery_event", "delivery_event_at", "created_at")
SELECT 'moderation-escalation:' || r."id", 'escalation', '', 'Floor report: ' || r."reason",
	jsonb_build_object('reportKind', 'moderation_report', 'reportId', r."id"::text, 'reason', r."reason"),
	r."escalation_message_id", r."escalated_at", r."escalation_delivery_event", r."escalation_delivery_at",
	COALESCE(r."escalated_at", r."created_at")
FROM "moderation_reports" r
WHERE r."escalated_at" IS NOT NULL OR r."escalation_message_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "outbound_emails" ("dedupe_key", "kind", "recipient", "subject", "detail", "message_id", "sent_at", "delivery_event", "delivery_event_at", "created_at")
SELECT 'abuse-escalation:' || r."id", 'escalation', '', 'Public report: ' || r."reason",
	jsonb_build_object('reportKind', 'abuse_report', 'reportId', r."id"::text, 'reason', r."reason"),
	r."escalation_message_id", r."escalated_at", r."escalation_delivery_event", r."escalation_delivery_at",
	COALESCE(r."escalated_at", r."created_at")
FROM "abuse_reports" r
WHERE r."escalated_at" IS NOT NULL OR r."escalation_message_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX "idx_abuse_reports_escalation";--> statement-breakpoint
DROP INDEX "idx_moderation_reports_escalation";--> statement-breakpoint
ALTER TABLE "abuse_reports" DROP COLUMN "escalated_at";--> statement-breakpoint
ALTER TABLE "abuse_reports" DROP COLUMN "escalation_message_id";--> statement-breakpoint
ALTER TABLE "abuse_reports" DROP COLUMN "escalation_delivery_event";--> statement-breakpoint
ALTER TABLE "abuse_reports" DROP COLUMN "escalation_delivery_at";--> statement-breakpoint
ALTER TABLE "moderation_reports" DROP COLUMN "escalated_at";--> statement-breakpoint
ALTER TABLE "moderation_reports" DROP COLUMN "escalation_message_id";--> statement-breakpoint
ALTER TABLE "moderation_reports" DROP COLUMN "escalation_delivery_event";--> statement-breakpoint
ALTER TABLE "moderation_reports" DROP COLUMN "escalation_delivery_at";
